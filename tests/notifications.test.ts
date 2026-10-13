import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";

import { sql } from "drizzle-orm";
import { pino } from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { db, pool } from "../src/db/client.js";
import { enqueueMessageNotification } from "../src/modules/notifications/notifications.outbox.js";
import {
  PushProviderError,
  type PushMessage,
  type PushProvider,
  type PushReceipt,
  type PushTicket,
} from "../src/modules/notifications/notifications.provider.js";
import { retryDelaySeconds } from "../src/modules/notifications/notifications.worker.js";
import {
  ANDROID_DEVICE,
  bearer,
  closeConnections,
  createTestApp,
  login,
  resetState,
  type LoginResult,
  type TestContext,
} from "./helpers/auth.js";
import { api, createUser, openChat, sendText, type TestUser } from "./helpers/messaging.js";

afterAll(closeConnections);

type SendHandler = (messages: readonly PushMessage[]) => Promise<PushTicket[]>;

class FakePushProvider implements PushProvider {
  batches: PushMessage[][] = [];
  receiptRequests: string[][] = [];
  onSend: SendHandler = (messages) =>
    Promise.resolve(messages.map(() => ({ status: "ok", id: `ticket-${randomUUID()}` })));
  receiptFor: (ticketId: string) => PushReceipt | undefined = () => ({ status: "ok" });

  get sent(): PushMessage[] {
    return this.batches.flat();
  }

  send(messages: readonly PushMessage[]): Promise<PushTicket[]> {
    this.batches.push([...messages]);
    return this.onSend(messages);
  }

  receipts(ids: readonly string[]): Promise<Map<string, PushReceipt>> {
    this.receiptRequests.push([...ids]);
    const result = new Map<string, PushReceipt>();
    for (const id of ids) {
      const receipt = this.receiptFor(id);
      if (receipt) result.set(id, receipt);
    }
    return Promise.resolve(result);
  }

  reset(): void {
    this.batches = [];
    this.receiptRequests = [];
    this.onSend = (messages) =>
      Promise.resolve(messages.map(() => ({ status: "ok", id: `ticket-${randomUUID()}` })));
    this.receiptFor = () => ({ status: "ok" });
  }
}

let tokenCounter = 0;
function expoToken(): string {
  tokenCounter += 1;
  return `ExponentPushToken[test-${tokenCounter}-${randomUUID().slice(0, 8)}]`;
}

const SECRET_TEXT = "meet me at the usual place";

describe("push notifications", () => {
  const provider = new FakePushProvider();
  const logLines: string[] = [];
  let ctx: TestContext;

  beforeAll(async () => {
    const sink = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        logLines.push(chunk.toString());
        callback();
      },
    });
    ctx = await createTestApp({
      logger: pino({ level: "trace" }, sink),
      notifications: {
        provider,
        settings: { processOnCommit: false, maxAttempts: 3, receiptDelaySeconds: 0 },
      },
    });
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  beforeEach(async () => {
    await resetState();
    provider.reset();
  });

  async function register(session: LoginResult, token = expoToken()): Promise<string> {
    const response = await ctx.app.inject({
      method: "PUT",
      url: "/devices/current/push-token",
      headers: bearer(session.accessToken),
      payload: { token },
    });
    expect(response.statusCode, response.body).toBe(200);
    return token;
  }

  async function userWithToken(name: string): Promise<TestUser & { token: string }> {
    const user = await createUser(ctx, name);
    return { ...user, token: await register(user) };
  }

  async function drain(): Promise<void> {
    await ctx.app.pushNotifier.drain();
  }

  async function createGroup(owner: TestUser, members: TestUser[]): Promise<string> {
    const response = await api(ctx, owner, "POST", "/groups", {
      clientRequestId: randomUUID(),
      name: "Team",
      memberIds: members.map((member) => member.user.id),
    });
    expect(response.statusCode, response.body).toBe(201);
    return response.json<{ chat: { id: string } }>().chat.id;
  }

  async function send(user: TestUser, chatId: string, text = SECRET_TEXT): Promise<string> {
    const response = await sendText(ctx, user, chatId, text);
    expect(response.statusCode, response.body).toBe(201);
    return response.json<{ message: { id: string } }>().message.id;
  }

  function recipientsOf(messages: PushMessage[]): string[] {
    return messages.map((message) => message.to).sort();
  }

  async function deliveries(): Promise<
    { status: string; error_code: string | null; attempts: number; token: string }[]
  > {
    const result = await pool.query<{
      status: string;
      error_code: string | null;
      attempts: number;
      token: string;
    }>("SELECT status, error_code, attempts, token FROM push_deliveries ORDER BY created_at");
    return result.rows;
  }

  async function makeDue(): Promise<void> {
    await pool.query("UPDATE push_deliveries SET next_attempt_at = NOW() WHERE status = 'pending'");
    await pool.query("UPDATE notification_jobs SET available_at = NOW() WHERE status = 'queued'");
  }

  async function jobCount(): Promise<number> {
    const result = await pool.query<{ count: string }>("SELECT COUNT(*) FROM notification_jobs");
    return Number(result.rows[0]?.count);
  }

  describe("device registration", () => {
    it("registers the session's device without ever returning the token", async () => {
      const ana = await createUser(ctx, "Ana");
      const token = await register(ana);

      const status = await ctx.app.inject({
        method: "GET",
        url: "/devices/current/push-token",
        headers: bearer(ana.accessToken),
      });
      expect(status.statusCode).toBe(200);
      expect(status.json()).toMatchObject({ pushToken: { registered: true } });
      expect(status.body).not.toContain(token);

      const row = await pool.query("SELECT push_token FROM devices WHERE id = $1", [ana.device.id]);
      expect(row.rows[0]).toEqual({ push_token: token });
    });

    it("requires authentication and a valid Expo token", async () => {
      const anonymous = await ctx.app.inject({
        method: "PUT",
        url: "/devices/current/push-token",
        payload: { token: expoToken() },
      });
      expect(anonymous.statusCode).toBe(401);

      const ana = await createUser(ctx, "Ana");
      for (const token of [
        "not-a-token",
        "ExponentPushToken[]",
        `ExponentPushToken[${"a".repeat(300)}]`,
      ]) {
        const response = await api(ctx, ana, "PUT", "/devices/current/push-token", { token });
        expect(response.statusCode, token).toBe(400);
      }
      const extra = await api(ctx, ana, "PUT", "/devices/current/push-token", {
        token: expoToken(),
        userId: randomUUID(),
      });
      // Unknown fields are ignored; the device always comes from the session.
      expect(extra.statusCode).toBe(200);
    });

    it("updates the token when it changes and supports several devices per user", async () => {
      const ana = await userWithToken("Ana");
      const phone = await login(ctx, ana.phone, ANDROID_DEVICE);
      const androidToken = await register(phone);
      const rotated = await register(ana);

      const ben = await createUser(ctx, "Ben");
      const chatId = await openChat(ctx, ben, ana);
      await send(ben, chatId);
      await drain();

      expect(recipientsOf(provider.sent)).toEqual([androidToken, rotated].sort());
      expect(provider.sent.map((message) => message.to)).not.toContain(ana.token);
    });

    it("moves a token to the account that registered it last", async () => {
      const ana = await userWithToken("Ana");
      const ben = await createUser(ctx, "Ben");
      await register(ben, ana.token);

      const row = await pool.query(
        "SELECT push_token, push_token_revoked_reason FROM devices WHERE id = $1",
        [ana.device.id],
      );
      expect(row.rows[0]).toEqual({ push_token: null, push_token_revoked_reason: "replaced" });

      const cara = await createUser(ctx, "Cara");
      await send(cara, await openChat(ctx, cara, ana));
      await drain();
      expect(provider.sent).toHaveLength(0);
    });

    it("stops pushes after unregistering and after signing out", async () => {
      const ana = await userWithToken("Ana");
      const ben = await userWithToken("Ben");
      const cara = await createUser(ctx, "Cara");

      expect((await api(ctx, ana, "DELETE", "/devices/current/push-token")).statusCode).toBe(204);
      const logout = await ctx.app.inject({
        method: "POST",
        url: "/auth/logout",
        headers: bearer(ben.accessToken),
      });
      expect(logout.statusCode).toBe(204);

      const reasons = await pool.query(
        "SELECT push_token, push_token_revoked_reason AS reason FROM devices WHERE id = ANY($1) ORDER BY push_token_revoked_reason::text",
        [[ana.device.id, ben.device.id]],
      );
      expect(reasons.rows).toEqual([
        { push_token: null, reason: "logout" },
        { push_token: null, reason: "unregistered" },
      ]);

      await send(cara, await openChat(ctx, cara, ana));
      await send(cara, await openChat(ctx, cara, ben));
      await drain();
      expect(provider.sent).toHaveLength(0);
    });
  });

  describe("recipients", () => {
    it("notifies the other person in a direct chat with a content-free payload", async () => {
      const ana = await userWithToken("Ana");
      const ben = await userWithToken("Ben");
      const benPhone = await login(ctx, ben.phone, ANDROID_DEVICE);
      await register(benPhone);

      const chatId = await openChat(ctx, ben, ana);
      const messageId = await send(ben, chatId);
      await drain();

      expect(provider.sent).toHaveLength(1);
      const [push] = provider.sent;
      expect(push).toMatchObject({
        to: ana.token,
        body: "New message",
        sound: "default",
        channelId: "messages",
        badge: 1,
        data: { type: "direct_message", chatId, messageId },
      });
      expect(push?.data.notificationId).toMatch(/^[0-9a-f-]{36}$/);
      expect(Object.keys(push?.data ?? {}).sort()).toEqual(
        ["chatId", "messageId", "notificationId", "type"].sort(),
      );
      const serialized = JSON.stringify(provider.batches);
      expect(serialized).not.toContain(SECRET_TEXT);
      expect(serialized).not.toContain(Buffer.from(SECRET_TEXT).toString("base64"));
      expect(serialized).not.toContain(ben.phone);
      expect(serialized).not.toContain("Ben");

      const states = await deliveries();
      expect(states).toEqual([
        expect.objectContaining({ status: "accepted", error_code: null, attempts: 1 }),
      ]);
    });

    it("notifies group members except the sender", async () => {
      const ana = await userWithToken("Ana");
      const ben = await userWithToken("Ben");
      const cara = await userWithToken("Cara");
      const chatId = await createGroup(ana, [ben, cara]);
      await drain();
      // Creating the group posts system events, which never notify.
      expect(provider.sent).toHaveLength(0);

      await send(ben, chatId);
      await drain();
      expect(recipientsOf(provider.sent)).toEqual([ana.token, cara.token].sort());
      expect(provider.sent[0]).toMatchObject({
        body: "New group message",
        data: { type: "group_message", chatId },
      });
    });

    it("skips members removed and groups deleted before the job runs", async () => {
      const ana = await createUser(ctx, "Ana");
      const ben = await userWithToken("Ben");
      const cara = await userWithToken("Cara");
      const dev = await userWithToken("Dev");
      const chatId = await createGroup(ana, [ben, cara, dev]);

      await send(ben, chatId);
      expect(
        (await api(ctx, ana, "DELETE", `/groups/${chatId}/members/${cara.user.id}`)).statusCode,
      ).toBe(200);
      await drain();
      expect(recipientsOf(provider.sent)).toEqual([dev.token]);

      provider.reset();
      await send(ben, chatId);
      expect((await api(ctx, ana, "DELETE", `/groups/${chatId}`)).statusCode).toBe(204);
      await drain();
      expect(provider.sent).toHaveLength(0);
    });

    it("skips deleted messages, blocks and messages already read elsewhere", async () => {
      const ana = await userWithToken("Ana");
      const ben = await createUser(ctx, "Ben");
      const chatId = await openChat(ctx, ben, ana);

      const deleted = await send(ben, chatId);
      expect(
        (await api(ctx, ben, "DELETE", `/chats/${chatId}/messages/${deleted}`)).statusCode,
      ).toBe(200);
      await drain();
      expect(provider.sent).toHaveLength(0);

      const read = await sendText(ctx, ben, chatId, "hello");
      const sequence = read.json<{ message: { sequence: number } }>().message.sequence;
      await api(ctx, ana, "POST", `/chats/${chatId}/receipts`, { readSequence: sequence });
      await drain();
      expect(provider.sent).toHaveLength(0);

      await send(ben, chatId);
      expect((await api(ctx, ana, "PUT", `/privacy/blocks/${ben.user.id}`)).statusCode).toBe(204);
      await drain();
      expect(provider.sent).toHaveLength(0);
    });

    it("honours a turned-off notifications setting", async () => {
      const ana = await userWithToken("Ana");
      const ben = await createUser(ctx, "Ben");
      await pool.query(
        "UPDATE user_settings SET notifications_enabled = FALSE WHERE user_id = $1",
        [ana.user.id],
      );
      await send(ben, await openChat(ctx, ben, ana));
      await drain();
      expect(provider.sent).toHaveLength(0);
    });

    it("notifies broadcast recipients once through their direct chat", async () => {
      const owner = await userWithToken("Owner");
      const ana = await userWithToken("Ana");
      const ben = await userWithToken("Ben");
      const list = await api(ctx, owner, "POST", "/broadcasts", {
        clientRequestId: randomUUID(),
        name: "Secret list name",
        recipientIds: [ana.user.id, ben.user.id],
      });
      expect(list.statusCode, list.body).toBe(201);
      const listId = list.json<{ list: { id: string } }>().list.id;
      const sent = await api(ctx, owner, "POST", `/broadcasts/${listId}/messages`, {
        clientMessageId: randomUUID(),
        type: "text",
        ciphertext: Buffer.from(SECRET_TEXT).toString("base64"),
      });
      expect(sent.statusCode, sent.body).toBe(201);
      await drain();
      await drain();

      expect(recipientsOf(provider.sent)).toEqual([ana.token, ben.token].sort());
      for (const push of provider.sent) {
        expect(push.data.type).toBe("direct_message");
      }
      const serialized = JSON.stringify(provider.batches);
      expect(serialized).not.toContain("Secret list name");
      expect(serialized).not.toContain(listId);
      expect(await jobCount()).toBe(2);
    });
  });

  describe("mutes", () => {
    async function mute(user: TestUser, chatId: string, body: Record<string, unknown>) {
      return api(ctx, user, "PUT", `/chats/${chatId}/mute`, body);
    }

    it("computes 8-hour and 1-week expiries on the server", async () => {
      const ana = await createUser(ctx, "Ana");
      const ben = await createUser(ctx, "Ben");
      const chatId = await openChat(ctx, ana, ben);

      for (const [duration, hours] of [
        ["8h", 8],
        ["1w", 168],
      ] as const) {
        const before = Date.now();
        const response = await mute(ana, chatId, { muted: true, duration });
        expect(response.statusCode, response.body).toBe(200);
        const chat = response.json<{ chat: { muted: boolean; mutedUntil: string } }>().chat;
        expect(chat.muted).toBe(true);
        const until = Date.parse(chat.mutedUntil);
        expect(until).toBeGreaterThanOrEqual(before + hours * 3_600_000 - 60_000);
        expect(until).toBeLessThanOrEqual(Date.now() + hours * 3_600_000 + 60_000);
      }
    });

    it("supports Always, unmuting, and refuses client-chosen expiries", async () => {
      const ana = await createUser(ctx, "Ana");
      const ben = await createUser(ctx, "Ben");
      const chatId = await openChat(ctx, ana, ben);

      const always = await mute(ana, chatId, { muted: true, duration: "always" });
      expect(always.json()).toMatchObject({ chat: { muted: true, mutedUntil: null } });
      const legacy = await mute(ana, chatId, { muted: true });
      expect(legacy.json()).toMatchObject({ chat: { muted: true, mutedUntil: null } });

      const unmuted = await mute(ana, chatId, { muted: false });
      expect(unmuted.json()).toMatchObject({ chat: { muted: false, mutedUntil: null } });
      // Idempotent.
      expect((await mute(ana, chatId, { muted: false })).statusCode).toBe(200);

      for (const body of [
        { muted: true, duration: "2h" },
        { muted: true, mutedUntil: "2030-01-01T00:00:00Z" },
        { muted: true, duration: "8h", mutedUntil: "2030-01-01T00:00:00Z" },
        { muted: "yes" },
      ]) {
        expect((await mute(ana, chatId, body)).statusCode, JSON.stringify(body)).toBe(400);
      }
    });

    it("is personal: other members neither see nor share it", async () => {
      const ana = await createUser(ctx, "Ana");
      const ben = await createUser(ctx, "Ben");
      const cara = await createUser(ctx, "Cara");
      const chatId = await createGroup(ana, [ben, cara]);
      await mute(ben, chatId, { muted: true, duration: "1w" });

      const forAna = await api(ctx, ana, "GET", `/chats/${chatId}`);
      expect(forAna.json()).toMatchObject({ chat: { muted: false, mutedUntil: null } });
      const group = await api(ctx, ana, "GET", `/groups/${chatId}`);
      expect(group.body).not.toContain("muted");
    });

    it("is only available to current members", async () => {
      const ana = await createUser(ctx, "Ana");
      const ben = await createUser(ctx, "Ben");
      const outsider = await createUser(ctx, "Dev");
      const chatId = await createGroup(ana, [ben]);

      expect((await mute(outsider, chatId, { muted: true })).statusCode).toBe(404);
      await api(ctx, ana, "DELETE", `/groups/${chatId}/members/${ben.user.id}`);
      expect((await mute(ben, chatId, { muted: true })).statusCode).toBe(404);
      expect((await mute(ben, randomUUID(), { muted: false })).statusCode).toBe(404);
    });

    it("suppresses a muted direct chat and resumes after the expiry by server time", async () => {
      const ana = await userWithToken("Ana");
      const ben = await createUser(ctx, "Ben");
      const chatId = await openChat(ctx, ben, ana);
      await mute(ana, chatId, { muted: true, duration: "8h" });

      await send(ben, chatId);
      await drain();
      expect(provider.sent).toHaveLength(0);

      // The 8 hours pass (no cleanup job runs).
      await pool.query(
        "UPDATE chat_members SET muted_until = NOW() - interval '1 second' WHERE user_id = $1",
        [ana.user.id],
      );
      const listed = await api(ctx, ana, "GET", `/chats/${chatId}`);
      expect(listed.json()).toMatchObject({ chat: { muted: false, mutedUntil: null } });

      await send(ben, chatId);
      await drain();
      expect(recipientsOf(provider.sent)).toEqual([ana.token]);
    });

    it("mutes a group only for the member who muted it", async () => {
      const ana = await userWithToken("Ana");
      const ben = await userWithToken("Ben");
      const cara = await userWithToken("Cara");
      const chatId = await createGroup(ana, [ben, cara]);
      await mute(cara, chatId, { muted: true, duration: "always" });

      await send(ben, chatId);
      await drain();
      expect(recipientsOf(provider.sent)).toEqual([ana.token]);

      provider.reset();
      await mute(cara, chatId, { muted: false });
      await send(ben, chatId);
      await drain();
      expect(recipientsOf(provider.sent)).toEqual([ana.token, cara.token].sort());
    });

    it("leaves muted chats out of the badge count", async () => {
      const ana = await userWithToken("Ana");
      const ben = await createUser(ctx, "Ben");
      const cara = await createUser(ctx, "Cara");
      const muted = await openChat(ctx, cara, ana);
      await send(cara, muted);
      await send(cara, muted);
      await mute(ana, muted, { muted: true, duration: "always" });
      await drain();
      provider.reset();

      await send(ben, await openChat(ctx, ben, ana));
      await drain();
      expect(provider.sent[0]?.badge).toBe(1);
    });

    it("clears expired mutes in the sweep without changing behaviour", async () => {
      const ana = await createUser(ctx, "Ana");
      const ben = await createUser(ctx, "Ben");
      const chatId = await openChat(ctx, ana, ben);
      await mute(ana, chatId, { muted: true, duration: "8h" });
      await pool.query("UPDATE chat_members SET muted_until = NOW() - interval '1 minute'");
      await ctx.app.pushNotifier.sweep();
      const row = await pool.query(
        "SELECT COUNT(*)::int AS muted FROM chat_members WHERE muted_until IS NOT NULL",
      );
      expect(row.rows[0]).toEqual({ muted: 0 });
    });
  });

  describe("outbox", () => {
    it("never queues a push for a rolled-back message", async () => {
      const ana = await userWithToken("Ana");
      const ben = await createUser(ctx, "Ben");
      const chatId = await openChat(ctx, ben, ana);
      const messageId = await send(ben, chatId);
      await pool.query("DELETE FROM notification_jobs");

      await expect(
        db.transaction(async (tx) => {
          await enqueueMessageNotification(tx, { id: messageId, chatId, type: "text" });
          throw new Error("rolled back");
        }),
      ).rejects.toThrow("rolled back");
      expect(await jobCount()).toBe(0);

      // A send the server refuses (only admins may post) writes nothing.
      const cara = await userWithToken("Cara");
      const groupId = await createGroup(cara, [ben]);
      await api(ctx, cara, "PATCH", `/groups/${groupId}/settings`, { onlyAdminsCanMessage: true });
      expect((await sendText(ctx, ben, groupId, "hi")).statusCode).toBe(403);
      await drain();
      expect(provider.sent).toHaveLength(0);
      expect(await jobCount()).toBe(0);
    });

    it("keeps one job per message across retries and repeated processing", async () => {
      const ana = await userWithToken("Ana");
      const ben = await createUser(ctx, "Ben");
      const chatId = await openChat(ctx, ben, ana);
      const clientMessageId = randomUUID();
      await sendText(ctx, ben, chatId, "once", clientMessageId);
      await sendText(ctx, ben, chatId, "once", clientMessageId);
      const messageId = (
        await pool.query<{ id: string }>("SELECT id FROM messages WHERE client_message_id = $1", [
          clientMessageId,
        ])
      ).rows[0]?.id;
      await db.transaction((tx) =>
        enqueueMessageNotification(tx, { id: messageId ?? "", chatId, type: "text" }),
      );
      expect(await jobCount()).toBe(1);

      await drain();
      await drain();
      await pool.query(
        "UPDATE notification_jobs SET status = 'queued', available_at = NOW(), planned_at = NULL",
      );
      await drain();
      expect(provider.sent).toHaveLength(1);
    });

    it("recovers jobs a crashed worker left behind", async () => {
      const ana = await userWithToken("Ana");
      const ben = await createUser(ctx, "Ben");
      await send(ben, await openChat(ctx, ben, ana));
      await pool.query(
        "UPDATE notification_jobs SET status = 'processing', locked_until = NOW() + interval '1 minute'",
      );
      await drain();
      expect(provider.sent).toHaveLength(0);

      await pool.query("UPDATE notification_jobs SET locked_until = NOW() - interval '1 second'");
      await ctx.app.pushNotifier.sweep();
      expect(recipientsOf(provider.sent)).toEqual([ana.token]);
    });

    it("drops notifications that are too old to be useful", async () => {
      const ana = await userWithToken("Ana");
      const ben = await createUser(ctx, "Ben");
      await send(ben, await openChat(ctx, ben, ana));
      await pool.query("UPDATE notification_jobs SET created_at = NOW() - interval '2 hours'");
      await drain();
      expect(provider.sent).toHaveLength(0);
      const job = await pool.query("SELECT status FROM notification_jobs");
      expect(job.rows[0]).toEqual({ status: "expired" });
    });
  });

  describe("provider outcomes", () => {
    async function oneMessageTo(): Promise<{
      ana: TestUser & { token: string };
      chatId: string;
      ben: TestUser;
    }> {
      const ana = await userWithToken("Ana");
      const ben = await createUser(ctx, "Ben");
      const chatId = await openChat(ctx, ben, ana);
      await send(ben, chatId);
      return { ana, chatId, ben };
    }

    it("retries transient failures with backoff, then gives up", async () => {
      await oneMessageTo();
      provider.onSend = () => Promise.reject(new PushProviderError("PROVIDER_UNAVAILABLE", true));

      await drain();
      const [first] = await deliveries();
      expect(first).toMatchObject({
        status: "pending",
        attempts: 1,
        error_code: "PROVIDER_UNAVAILABLE",
      });
      const scheduled = await pool.query<{ wait: number }>(
        "SELECT EXTRACT(EPOCH FROM next_attempt_at - NOW())::float AS wait FROM push_deliveries",
      );
      expect(scheduled.rows[0]?.wait).toBeGreaterThan(0);
      // Not due yet: nothing is sent.
      await drain();
      expect(provider.batches).toHaveLength(1);

      await makeDue();
      await drain();
      await makeDue();
      await drain();
      expect(provider.batches).toHaveLength(3);
      expect(await deliveries()).toEqual([
        expect.objectContaining({
          status: "failed",
          attempts: 3,
          error_code: "PROVIDER_UNAVAILABLE",
        }),
      ]);
      const job = await pool.query("SELECT status FROM notification_jobs");
      expect(job.rows[0]).toEqual({ status: "completed" });
    });

    it("succeeds on a later attempt after a transient failure", async () => {
      const { ana } = await oneMessageTo();
      provider.onSend = () => Promise.reject(new PushProviderError("TIMEOUT", true));
      await drain();
      provider.reset();
      await makeDue();
      await drain();
      expect(recipientsOf(provider.sent)).toEqual([ana.token]);
      expect(await deliveries()).toEqual([
        expect.objectContaining({ status: "accepted", attempts: 2 }),
      ]);
    });

    it("waits at least as long as a rate limit asks", async () => {
      await oneMessageTo();
      provider.onSend = () => Promise.reject(new PushProviderError("RATE_LIMITED", true, 120));
      await drain();
      const scheduled = await pool.query<{ wait: number }>(
        "SELECT EXTRACT(EPOCH FROM next_attempt_at - NOW())::float AS wait FROM push_deliveries",
      );
      expect(scheduled.rows[0]?.wait).toBeGreaterThan(110);
    });

    it("does not retry permanent errors", async () => {
      await oneMessageTo();
      provider.onSend = () => Promise.reject(new PushProviderError("VALIDATION_ERROR", false));
      await drain();
      await makeDue();
      await drain();
      expect(provider.batches).toHaveLength(1);
      expect(await deliveries()).toEqual([
        expect.objectContaining({ status: "failed", error_code: "VALIDATION_ERROR" }),
      ]);

      provider.reset();
      const ana2 = await userWithToken("Ana Two");
      const ben2 = await createUser(ctx, "Ben Two");
      provider.onSend = (messages) =>
        Promise.resolve(messages.map(() => ({ status: "error", code: "MessageTooBig" })));
      await send(ben2, await openChat(ctx, ben2, ana2));
      await drain();
      await makeDue();
      await drain();
      expect(provider.batches).toHaveLength(1);
    });

    it("retries a ticket rate limit for that device only", async () => {
      const ana = await userWithToken("Ana");
      const ben = await userWithToken("Ben");
      const cara = await createUser(ctx, "Cara");
      const chatId = await createGroup(cara, [ana, ben]);
      provider.onSend = (messages) =>
        Promise.resolve(
          messages.map((message) =>
            message.to === ana.token
              ? { status: "error" as const, code: "MessageRateExceeded" }
              : { status: "ok" as const, id: `ticket-${randomUUID()}` },
          ),
        );
      await send(cara, chatId);
      await drain();
      provider.reset();
      await makeDue();
      await drain();
      expect(recipientsOf(provider.sent)).toEqual([ana.token]);
    });

    it("deactivates tokens the provider reports as unregistered", async () => {
      const { ana, chatId, ben } = await oneMessageTo();
      provider.onSend = (messages) =>
        Promise.resolve(messages.map(() => ({ status: "error", code: "DeviceNotRegistered" })));
      await drain();

      const device = await pool.query(
        "SELECT push_token, push_token_revoked_reason AS reason, push_last_error_code AS code FROM devices WHERE id = $1",
        [ana.device.id],
      );
      expect(device.rows[0]).toEqual({
        push_token: null,
        reason: "invalid",
        code: "DeviceNotRegistered",
      });

      provider.reset();
      await send(ben, chatId);
      await drain();
      expect(provider.sent).toHaveLength(0);
    });

    it("records receipts, distinguishing acceptance from hand-off to APNs/FCM", async () => {
      const ana = await userWithToken("Ana");
      const ben = await userWithToken("Ben");
      const cara = await createUser(ctx, "Cara");
      const chatId = await createGroup(cara, [ana, ben]);
      await send(cara, chatId);
      await drain();
      expect((await deliveries()).map((d) => d.status)).toEqual(["accepted", "accepted"]);

      const benTicket = (
        await pool.query<{ ticket_id: string }>(
          "SELECT ticket_id FROM push_deliveries WHERE token = $1",
          [ben.token],
        )
      ).rows[0]?.ticket_id;
      provider.receiptFor = (id) =>
        id === benTicket ? { status: "error", code: "DeviceNotRegistered" } : { status: "ok" };
      await ctx.app.pushNotifier.checkReceipts();

      const states = await pool.query<{ token: string; status: string; error_code: string | null }>(
        "SELECT token, status, error_code FROM push_deliveries",
      );
      expect(Object.fromEntries(states.rows.map((row) => [row.token, row.status]))).toEqual({
        [ana.token]: "provider_delivered",
        [ben.token]: "failed",
      });
      const benDevice = await pool.query("SELECT push_token FROM devices WHERE id = $1", [
        ben.device.id,
      ]);
      expect(benDevice.rows[0]).toEqual({ push_token: null });

      // Checked once.
      await ctx.app.pushNotifier.checkReceipts();
      expect(provider.receiptRequests).toHaveLength(1);
    });

    it("leaves receipts that aren't ready for the next check", async () => {
      await oneMessageTo();
      await drain();
      provider.receiptFor = () => undefined;
      await ctx.app.pushNotifier.checkReceipts();
      expect((await deliveries())[0]?.status).toBe("accepted");
      provider.receiptFor = () => ({ status: "ok" });
      await ctx.app.pushNotifier.checkReceipts();
      expect((await deliveries())[0]?.status).toBe("provider_delivered");
    });

    it("never logs message content or push tokens", async () => {
      const { ana } = await oneMessageTo();
      provider.onSend = (messages) =>
        Promise.resolve(messages.map(() => ({ status: "error", code: "DeviceNotRegistered" })));
      await drain();
      const logs = logLines.join("\n");
      expect(logs).toContain("push ticket error");
      expect(logs).not.toContain(SECRET_TEXT);
      expect(logs).not.toContain(Buffer.from(SECRET_TEXT).toString("base64"));
      expect(logs).not.toContain(ana.token);
      expect(logs).not.toContain("ExponentPushToken[");
    });
  });

  it("backs off exponentially with jitter, capped", () => {
    expect(retryDelaySeconds(0, undefined, () => 0)).toBe(1);
    expect(retryDelaySeconds(3, undefined, () => 1)).toBe(16);
    expect(retryDelaySeconds(20, undefined, () => 1)).toBe(300);
    expect(retryDelaySeconds(1, 90, () => 0)).toBe(90);
  });
});

describe("push on commit", () => {
  const provider = new FakePushProvider();
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp({ notifications: { provider } });
    await resetState();
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  it("sends right after the message commits, without waiting for a sweep", async () => {
    const ana = await createUser(ctx, "Ana");
    const ben = await createUser(ctx, "Ben");
    const token = expoToken();
    await api(ctx, ana, "PUT", "/devices/current/push-token", { token });
    const response = await sendText(ctx, ben, await openChat(ctx, ben, ana), "hi");
    expect(response.statusCode).toBe(201);
    await ctx.app.pushNotifier.idle();
    expect(provider.sent.map((message) => message.to)).toEqual([token]);
    const jobs = await db.execute<{ status: string }>(sql`SELECT status FROM notification_jobs`);
    expect(jobs.rows).toEqual([{ status: "completed" }]);
  });
});
