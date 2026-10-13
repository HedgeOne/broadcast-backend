import { Writable } from "node:stream";

import { pino } from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { pool } from "../src/db/client.js";
import { redis } from "../src/redis/client.js";
import {
  closeConnections,
  createTestApp,
  resetState,
  uniqueIp,
  type TestContext,
} from "./helpers/auth.js";
import { api, createUser, openChat, type TestUser } from "./helpers/messaging.js";

afterAll(closeConnections);

interface MatchBody {
  matches: {
    phoneNumber: string;
    user: { id: string; displayName: string | null; available: boolean; blockedByMe: boolean };
  }[];
}

// Numbers in the +9198 range: valid Indian mobiles, distinct from testPhone().
const phone = (n: number) => `+919800${String(n).padStart(6, "0")}`;

function match(
  ctx: TestContext,
  user: TestUser,
  phoneNumbers: unknown,
  remoteAddress = uniqueIp(),
) {
  return ctx.app.inject({
    method: "POST",
    url: "/contacts/match",
    headers: { authorization: `Bearer ${user.accessToken}` },
    payload: { phoneNumbers },
    remoteAddress,
  });
}

describe("POST /contacts/match", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  beforeEach(resetState);

  afterAll(async () => {
    await ctx.app.close();
  });

  it("requires a session", async () => {
    const response = await ctx.app.inject({
      method: "POST",
      url: "/contacts/match",
      payload: { phoneNumbers: [phone(1)] },
    });
    expect(response.statusCode).toBe(401);
  });

  it("returns only active, verified, unblocked users other than the caller", async () => {
    const me = await createUser(ctx, "me", { phone: phone(1) });
    const friend = await createUser(ctx, "friend", { displayName: "Friend", phone: phone(2) });
    const blockedByMe = await createUser(ctx, "blocked", { phone: phone(3) });
    const blocksMe = await createUser(ctx, "blocker", { phone: phone(4) });
    const disabled = await createUser(ctx, "disabled", { phone: phone(5) });
    const deleted = await createUser(ctx, "deleted", { phone: phone(6) });
    await api(ctx, me, "PUT", `/privacy/blocks/${blockedByMe.user.id}`);
    await api(ctx, blocksMe, "PUT", `/privacy/blocks/${me.user.id}`);
    await pool.query("UPDATE users SET status = 'disabled' WHERE id = $1", [disabled.user.id]);
    await pool.query("UPDATE users SET status = 'deleted' WHERE id = $1", [deleted.user.id]);

    const response = await match(ctx, me, [1, 2, 3, 4, 5, 6, 99].map(phone));

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      matches: [
        {
          phoneNumber: phone(2),
          user: {
            id: friend.user.id,
            displayName: "Friend",
            available: true,
            blockedByMe: false,
            photoId: null,
          },
        },
      ],
    });
    for (const hidden of [me, blockedByMe, blocksMe, disabled, deleted]) {
      expect(response.body).not.toContain(hidden.user.id);
    }
  });

  it("does not reveal why a number did not match", async () => {
    const me = await createUser(ctx, "me");
    const blocker = await createUser(ctx, "blocker", { phone: phone(10) });
    const disabled = await createUser(ctx, "disabled", { phone: phone(11) });
    await api(ctx, blocker, "PUT", `/privacy/blocks/${me.user.id}`);
    await pool.query("UPDATE users SET status = 'disabled' WHERE id = $1", [disabled.user.id]);

    const bodies = await Promise.all(
      [phone(10), phone(11), phone(12)].map(async (number) => {
        const response = await match(ctx, me, [number]);
        expect(response.statusCode).toBe(200);
        return response.body;
      }),
    );
    expect(new Set(bodies)).toEqual(new Set(['{"matches":[]}']));
  });

  it("returns the minimal public profile only", async () => {
    const me = await createUser(ctx, "me");
    await createUser(ctx, "friend", { phone: phone(20) });

    const response = await match(ctx, me, [phone(20)]);
    const [entry] = response.json<MatchBody>().matches;
    expect(Object.keys(entry ?? {}).sort()).toEqual(["phoneNumber", "user"]);
    expect(Object.keys(entry?.user ?? {}).sort()).toEqual([
      "available",
      "blockedByMe",
      "displayName",
      "id",
      "photoId",
    ]);
    expect(response.body).not.toMatch(/status|verified|username|dateOfBirth|avatar|lastSeen/i);
  });

  it("collapses duplicate numbers into one match", async () => {
    const me = await createUser(ctx, "me");
    await createUser(ctx, "friend", { phone: phone(30) });

    const response = await match(ctx, me, [phone(30), phone(30), phone(31), phone(30)]);
    expect(response.json<MatchBody>().matches).toHaveLength(1);
    expect(await redis.get(`rl:contacts:match:numbers:${me.user.id}`)).toBe("2");
  });

  it.each([
    ["a national-format number", ["9800000040"]],
    ["a formatted number", ["+91 98000 00040"]],
    ["an invalid number", ["+911234"]],
    ["a non-string entry", [9198000040]],
    ["an empty list", []],
  ])("rejects %s", async (_label, phoneNumbers) => {
    const me = await createUser(ctx, "me");
    const response = await match(ctx, me, phoneNumbers);
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: "VALIDATION_ERROR" } });
    expect(response.body).not.toContain("98000");
  });

  it("rejects batches above the configured maximum", async () => {
    const me = await createUser(ctx, "me");
    const response = await match(
      ctx,
      me,
      Array.from({ length: 501 }, (_, i) => phone(1000 + i)),
    );
    expect(response.statusCode).toBe(400);
  });

  it("stores nothing about the submitted numbers", async () => {
    const me = await createUser(ctx, "me");
    await createUser(ctx, "friend", { phone: phone(50) });
    const before = new Set(await redis.keys("*"));
    const counts = async () =>
      (
        await pool.query<{ users: string; contacts: string; chats: string }>(
          `SELECT (SELECT COUNT(*) FROM users) AS users,
                  (SELECT COUNT(*) FROM user_contacts) AS contacts,
                  (SELECT COUNT(*) FROM chats) AS chats`,
        )
      ).rows[0];
    const rowsBefore = await counts();

    expect((await match(ctx, me, [phone(50), phone(51)])).statusCode).toBe(200);

    expect(await counts()).toEqual(rowsBefore);
    const added = (await redis.keys("*")).filter((key) => !before.has(key));
    expect(added.every((key) => key.startsWith("rl:contacts:match:"))).toBe(true);
    for (const key of added) {
      expect(key).not.toMatch(/9800/);
      expect(await redis.get(key)).toMatch(/^\d+$/);
    }
  });
});

describe("contact match limits", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp({
      contacts: {
        settings: { maxBatch: 3, userRequestLimit: 3, ipRequestLimit: 4, userNumberLimit: 5 },
      },
    });
  });

  beforeEach(resetState);

  afterAll(async () => {
    await ctx.app.close();
  });

  it("uses the configured batch size", async () => {
    const me = await createUser(ctx, "me");
    expect((await match(ctx, me, [1, 2, 3].map(phone))).statusCode).toBe(200);
    expect((await match(ctx, me, [1, 2, 3, 4].map(phone))).statusCode).toBe(400);
  });

  it("limits requests per user", async () => {
    const me = await createUser(ctx, "me");
    for (let i = 0; i < 3; i += 1) {
      expect((await match(ctx, me, [phone(i)])).statusCode).toBe(200);
    }
    const limited = await match(ctx, me, [phone(9)]);
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({ error: { code: "RATE_LIMITED" } });
    const { error } = limited.json<{ error: { details: { retryAfterSeconds: number } } }>();
    expect(error.details.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("limits requests per IP across accounts", async () => {
    const ip = uniqueIp();
    const users = await Promise.all([createUser(ctx, "a"), createUser(ctx, "b")]);
    const statuses: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      statuses.push((await match(ctx, users[i % 2]!, [phone(i)], ip)).statusCode);
    }
    expect(statuses).toEqual([200, 200, 200, 200, 429]);
  });

  it("caps how many distinct numbers one account looks up per window", async () => {
    const me = await createUser(ctx, "me");
    expect((await match(ctx, me, [1, 2, 3].map(phone))).statusCode).toBe(200);
    const over = await match(ctx, me, [4, 5, 6].map(phone));
    expect(over.statusCode).toBe(429);
    expect(over.json()).toMatchObject({ error: { code: "RATE_LIMITED" } });
  });
});

describe("contact match query bound", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp({ contacts: { queryTimeoutMs: 200 } });
  });

  beforeEach(resetState);

  afterAll(async () => {
    await ctx.app.close();
  });

  it("gives up after the statement timeout instead of hanging", async () => {
    const me = await createUser(ctx, "me");
    const holder = await pool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("LOCK TABLE blocked_users IN ACCESS EXCLUSIVE MODE");
      const started = Date.now();
      const response = await match(ctx, me, [phone(1)]);
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({ error: { code: "CONTACTS_UNAVAILABLE" } });
      expect(Date.now() - started).toBeLessThan(2000);
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
    }
  });
});

describe("contact match logging", () => {
  const lines: string[] = [];
  let ctx: TestContext;

  beforeAll(async () => {
    const sink = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        lines.push(chunk.toString());
        callback();
      },
    });
    ctx = await createTestApp({ logger: pino({ level: "trace" }, sink) });
    await resetState();
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  it("never writes submitted numbers to the logs", async () => {
    const me = await createUser(ctx, "me");
    await createUser(ctx, "friend", { phone: phone(60) });
    lines.length = 0;

    await match(ctx, me, [phone(60), phone(61)]);
    await match(ctx, me, ["+91 98000 00062"]);

    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join("\n")).not.toMatch(/9800000?06|98000 00062/);
  });
});

describe("starting a chat from a contact", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  beforeEach(resetState);

  afterAll(async () => {
    await ctx.app.close();
  });

  it("opens one direct chat with a matched user and reuses it", async () => {
    const me = await createUser(ctx, "me");
    const friend = await createUser(ctx, "friend", { phone: phone(70) });
    const [entry] = (await match(ctx, me, [phone(70)])).json<MatchBody>().matches;
    expect(entry?.user.id).toBe(friend.user.id);

    const ids = await Promise.all([openChat(ctx, me, friend), openChat(ctx, me, friend)]);
    expect(ids[0]).toBe(ids[1]);
    expect(await openChat(ctx, friend, me)).toBe(ids[0]);
  });

  it("refuses a chat with a disabled account", async () => {
    const me = await createUser(ctx, "me");
    const gone = await createUser(ctx, "gone");
    await pool.query("UPDATE users SET status = 'disabled' WHERE id = $1", [gone.user.id]);

    const response = await api(ctx, me, "POST", "/chats/direct", { userId: gone.user.id });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: "USER_NOT_FOUND" } });
  });
});
