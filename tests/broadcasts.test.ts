import { randomUUID } from "node:crypto";

import type { WebSocket } from "ws";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { pool } from "../src/db/client.js";
import {
  bearer,
  closeConnections,
  createTestApp,
  resetState,
  type TestContext,
} from "./helpers/auth.js";
import {
  api,
  createUser,
  encodeText,
  nextEvent,
  openChat,
  sendText,
  type TestUser,
} from "./helpers/messaging.js";

afterAll(closeConnections);

const MAX_RECIPIENTS = 4;

interface Summary {
  total: number;
  pending: number;
  accepted: number;
  delivered: number;
  read: number;
  failed: number;
  retryable: number;
}

interface BroadcastBody {
  id: string;
  listId: string;
  clientMessageId: string;
  type: string;
  ciphertext: string;
  state: "sending" | "completed" | "partial" | "failed";
  completedAt: string | null;
  summary: Summary;
}

interface ListBody {
  id: string;
  name: string;
  recipientCount: number;
  muted: boolean;
  lastBroadcast: BroadcastBody | null;
  maxRecipients?: number;
  recipients?: { userId: string; displayName: string | null; available: boolean }[];
}

interface ReportRow {
  userId: string;
  displayName: string | null;
  status: string;
  chatId: string | null;
  attemptCount: number;
  readAt: string | null;
  failureCode: string | null;
  retryable: boolean;
}

interface MessageBody {
  id: string;
  chatId: string;
  senderId: string;
  sequence: number;
  ciphertext: string;
}

describe("broadcast lists", () => {
  let ctx: TestContext;
  let owen: TestUser;
  let ana: TestUser;
  let ben: TestUser;
  let cara: TestUser;
  let dev: TestUser;

  beforeAll(async () => {
    ctx = await createTestApp({ chats: { broadcastMaxRecipients: MAX_RECIPIENTS } });
    await ctx.app.realtimeHub.ready();
  });

  beforeEach(async () => {
    await resetState();
    owen = await createUser(ctx, "owen", { displayName: "Owen" });
    ana = await createUser(ctx, "ana", { displayName: "Ana" });
    ben = await createUser(ctx, "ben", { displayName: "Ben" });
    cara = await createUser(ctx, "cara", { displayName: "Cara" });
    dev = await createUser(ctx, "dev", { displayName: "Dev" });
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  function idsOf(users: TestUser[]): string[] {
    return users.map((user) => user.user.id);
  }

  function create(owner: TestUser, recipients: string[], extra: Record<string, unknown> = {}) {
    return api(ctx, owner, "POST", "/broadcasts", {
      clientRequestId: randomUUID(),
      name: "Family",
      recipientIds: recipients,
      ...extra,
    });
  }

  async function createList(owner: TestUser, recipients: TestUser[]): Promise<string> {
    const response = await create(owner, idsOf(recipients));
    expect(response.statusCode, response.body).toBe(201);
    return response.json<{ list: ListBody }>().list.id;
  }

  function send(
    owner: TestUser,
    listId: string,
    text: string,
    clientMessageId: string = randomUUID(),
  ) {
    return api(ctx, owner, "POST", `/broadcasts/${listId}/messages`, {
      clientMessageId,
      type: "text",
      ciphertext: encodeText(text),
      protocol: "opene2ee-v1",
    });
  }

  async function broadcast(owner: TestUser, listId: string, text: string): Promise<BroadcastBody> {
    const response = await send(owner, listId, text);
    expect(response.statusCode, response.body).toBe(201);
    return response.json<{ broadcast: BroadcastBody }>().broadcast;
  }

  async function report(owner: TestUser, listId: string, broadcastId: string) {
    const response = await api(ctx, owner, "GET", `/broadcasts/${listId}/messages/${broadcastId}`);
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json<{ broadcast: BroadcastBody; recipients: ReportRow[] }>();
    return { ...body, byUser: new Map(body.recipients.map((row) => [row.userId, row])) };
  }

  async function details(owner: TestUser, listId: string): Promise<ListBody> {
    const response = await api(ctx, owner, "GET", `/broadcasts/${listId}`);
    expect(response.statusCode, response.body).toBe(200);
    return response.json<{ list: ListBody }>().list;
  }

  async function directMessages(a: TestUser, b: TestUser): Promise<MessageBody[]> {
    const chatId = await openChat(ctx, a, b);
    const response = await api(ctx, a, "GET", `/chats/${chatId}/messages`);
    expect(response.statusCode, response.body).toBe(200);
    return response.json<{ messages: MessageBody[] }>().messages;
  }

  async function count(query: string, params: unknown[] = []): Promise<number> {
    const { rows } = await pool.query<{ n: number }>(query, params);
    return rows[0]?.n ?? 0;
  }

  function block(user: TestUser, other: TestUser) {
    return api(ctx, user, "PUT", `/privacy/blocks/${other.user.id}`);
  }

  function connect(user: TestUser) {
    return ctx.app.injectWS("/ws", { headers: bearer(user.accessToken) });
  }

  // Every event type a socket receives until stopped.
  function record(socket: WebSocket): { types: string[] } {
    const seen = { types: [] as string[] };
    socket.on("message", (raw: Buffer) => {
      const event = JSON.parse(raw.toString("utf8")) as { type: string };
      seen.types.push(event.type);
    });
    return seen;
  }

  describe("authentication and ownership", () => {
    it.each([
      ["GET", "/broadcasts"],
      ["POST", "/broadcasts"],
      ["GET", `/broadcasts/${randomUUID()}`],
      ["POST", `/broadcasts/${randomUUID()}/messages`],
    ] as const)("rejects %s %s without a token", async (method, url) => {
      const response = await ctx.app.inject({ method, url });
      expect(response.statusCode).toBe(401);
    });

    it("hides a list from every other account, including its recipients", async () => {
      const listId = await createList(owen, [ana, ben]);
      const sent = await broadcast(owen, listId, "hello");

      for (const outsider of [ana, cara]) {
        const attempts = [
          api(ctx, outsider, "GET", `/broadcasts/${listId}`),
          api(ctx, outsider, "PATCH", `/broadcasts/${listId}`, { name: "Mine" }),
          api(ctx, outsider, "DELETE", `/broadcasts/${listId}`),
          api(ctx, outsider, "POST", `/broadcasts/${listId}/recipients`, {
            recipientIds: [cara.user.id],
          }),
          api(ctx, outsider, "DELETE", `/broadcasts/${listId}/recipients/${ben.user.id}`),
          api(ctx, outsider, "GET", `/broadcasts/${listId}/messages`),
          api(ctx, outsider, "GET", `/broadcasts/${listId}/messages/${sent.id}`),
          api(ctx, outsider, "POST", `/broadcasts/${listId}/messages/${sent.id}/retry`),
          send(outsider, listId, "as the owner?"),
        ];
        for (const response of await Promise.all(attempts)) {
          expect(response.statusCode, response.body).toBe(404);
          expect(response.json<{ error: { code: string } }>().error.code).toBe(
            "BROADCAST_LIST_NOT_FOUND",
          );
        }
        const lists = await api(ctx, outsider, "GET", "/broadcasts");
        expect(lists.json<{ lists: ListBody[] }>().lists).toEqual([]);
      }

      // Nothing changed.
      const list = await details(owen, listId);
      expect(list.name).toBe("Family");
      expect(list.recipients?.map((r) => r.userId).sort()).toEqual(idsOf([ana, ben]).sort());
      expect(await count("SELECT COUNT(*)::int AS n FROM broadcast_messages")).toBe(1);
    });

    it("rejects client-supplied sender, owner and status fields", async () => {
      const listId = await createList(owen, [ana]);
      const spoofed = await api(ctx, owen, "POST", `/broadcasts/${listId}/messages`, {
        clientMessageId: randomUUID(),
        type: "text",
        ciphertext: encodeText("hi"),
        protocol: "opene2ee-v1",
        senderId: ana.user.id,
      });
      expect(spoofed.statusCode).toBe(400);

      const status = await api(ctx, owen, "PATCH", `/broadcasts/${listId}`, {
        name: "X",
        ownerId: ana.user.id,
      });
      expect(status.statusCode).toBe(400);

      const created = await api(ctx, owen, "POST", "/broadcasts", {
        clientRequestId: randomUUID(),
        name: "Spoof",
        recipientIds: [ana.user.id],
        ownerId: ana.user.id,
      });
      expect(created.statusCode).toBe(400);
      const added = await api(ctx, owen, "POST", `/broadcasts/${listId}/recipients`, {
        recipientIds: [ana.user.id],
        status: "sent",
      });
      expect(added.statusCode).toBe(400);
      expect(await count("SELECT COUNT(*)::int AS n FROM messages")).toBe(0);
      expect(await count("SELECT COUNT(*)::int AS n FROM broadcast_lists")).toBe(1);
    });
  });

  describe("list management", () => {
    it("creates a list once per request id and shows it on the Broadcast tab", async () => {
      const clientRequestId = randomUUID();
      const first = await create(owen, idsOf([ana, ben, ben]), {
        clientRequestId,
        name: "  Team  ",
      });
      expect(first.statusCode, first.body).toBe(201);
      const created = first.json<{ list: ListBody }>().list;
      expect(created.name).toBe("Team");
      expect(created.recipientCount).toBe(2);
      expect(created.maxRecipients).toBe(MAX_RECIPIENTS);
      expect(created.lastBroadcast).toBeNull();

      const retry = await create(owen, idsOf([ana, ben]), { clientRequestId, name: "Team" });
      expect(retry.statusCode).toBe(200);
      expect(retry.json<{ list: ListBody }>().list.id).toBe(created.id);
      expect(await count("SELECT COUNT(*)::int AS n FROM broadcast_lists")).toBe(1);

      const lists = await api(ctx, owen, "GET", "/broadcasts");
      expect(
        lists.json<{ lists: ListBody[] }>().lists.map((l) => [l.name, l.recipientCount]),
      ).toEqual([["Team", 2]]);
      // Not a chat: nothing appears in anyone's chat list.
      for (const user of [owen, ana, ben]) {
        const chats = await api(ctx, user, "GET", "/chats");
        expect(chats.json<{ chats: unknown[] }>().chats).toEqual([]);
      }
    });

    it("validates names and recipients", async () => {
      expect((await create(owen, idsOf([ana]), { name: "   " })).statusCode).toBe(400);
      expect((await create(owen, idsOf([ana]), { name: "x".repeat(101) })).statusCode).toBe(400);
      expect((await create(owen, [])).statusCode).toBe(400);
      expect((await create(owen, ["not-a-uuid"])).statusCode).toBe(400);

      const self = await create(owen, [owen.user.id]);
      expect(self.statusCode).toBe(400);
      expect(self.json<{ error: { code: string } }>().error.code).toBe("INVALID_RECIPIENTS");

      const unknown = await create(owen, [randomUUID()]);
      expect(unknown.statusCode).toBe(422);
      expect(unknown.json<{ error: { code: string } }>().error.code).toBe("RECIPIENTS_UNAVAILABLE");

      const extra = await createUser(ctx, "eve", { displayName: "Eve" });
      const full = await create(owen, idsOf([ana, ben, cara, dev, extra]));
      expect(full.statusCode).toBe(409);
      expect(full.json<{ error: { code: string } }>().error.code).toBe("BROADCAST_LIST_FULL");
      expect(await count("SELECT COUNT(*)::int AS n FROM broadcast_lists")).toBe(0);
    });

    it("applies blocks without revealing who blocked whom", async () => {
      expect((await block(owen, ana)).statusCode).toBe(204);
      expect((await block(ben, owen)).statusCode).toBe(204);

      const blockedByMe = await create(owen, idsOf([ana, cara]));
      expect(blockedByMe.statusCode).toBe(422);
      expect(blockedByMe.json<{ error: { code: string; details: unknown } }>().error).toMatchObject(
        {
          code: "RECIPIENTS_BLOCKED",
          details: { userIds: [ana.user.id] },
        },
      );

      const blockedMe = await create(owen, idsOf([ben, cara]));
      expect(blockedMe.statusCode).toBe(422);
      expect(blockedMe.json<{ error: { code: string; details: unknown } }>().error).toMatchObject({
        code: "RECIPIENTS_UNAVAILABLE",
        details: { userIds: [ben.user.id] },
      });
    });

    it("renames, mutes, adds and removes recipients", async () => {
      const listId = await createList(owen, [ana, ben]);

      const renamed = await api(ctx, owen, "PATCH", `/broadcasts/${listId}`, {
        name: " Neighbours ",
      });
      expect(renamed.statusCode, renamed.body).toBe(200);
      expect(renamed.json<{ list: ListBody }>().list.name).toBe("Neighbours");
      expect(
        (await api(ctx, owen, "PATCH", `/broadcasts/${listId}`, { name: "" })).statusCode,
      ).toBe(400);
      expect((await api(ctx, owen, "PATCH", `/broadcasts/${listId}`, {})).statusCode).toBe(400);

      const muted = await api(ctx, owen, "PATCH", `/broadcasts/${listId}`, { muted: true });
      expect(muted.json<{ list: ListBody }>().list).toMatchObject({
        muted: true,
        name: "Neighbours",
      });

      // Existing recipients are ignored; new ones are added.
      const added = await api(ctx, owen, "POST", `/broadcasts/${listId}/recipients`, {
        recipientIds: idsOf([ana, cara, dev]),
      });
      expect(added.statusCode, added.body).toBe(200);
      expect(added.json<{ list: ListBody }>().list.recipientCount).toBe(4);

      const extra = await createUser(ctx, "eve", { displayName: "Eve" });
      const overLimit = await api(ctx, owen, "POST", `/broadcasts/${listId}/recipients`, {
        recipientIds: [extra.user.id],
      });
      expect(overLimit.statusCode).toBe(409);

      const removed = await api(
        ctx,
        owen,
        "DELETE",
        `/broadcasts/${listId}/recipients/${ben.user.id}`,
      );
      expect(removed.statusCode).toBe(200);
      const list = removed.json<{ list: ListBody }>().list;
      expect(list.recipients?.map((r) => r.displayName)).toEqual(["Ana", "Cara", "Dev"]);

      const again = await api(
        ctx,
        owen,
        "DELETE",
        `/broadcasts/${listId}/recipients/${ben.user.id}`,
      );
      expect(again.statusCode).toBe(404);
      expect(again.json<{ error: { code: string } }>().error.code).toBe("RECIPIENT_NOT_FOUND");

      // A removed recipient can be added back.
      const back = await api(ctx, owen, "POST", `/broadcasts/${listId}/recipients`, {
        recipientIds: [ben.user.id],
      });
      expect(back.json<{ list: ListBody }>().list.recipientCount).toBe(4);
    });

    it("deletes a list but keeps every direct message already sent", async () => {
      const listId = await createList(owen, [ana, ben]);
      const sent = await broadcast(owen, listId, "before delete");

      expect((await api(ctx, owen, "DELETE", `/broadcasts/${listId}`)).statusCode).toBe(204);
      expect((await api(ctx, owen, "DELETE", `/broadcasts/${listId}`)).statusCode).toBe(404);
      expect((await api(ctx, owen, "GET", `/broadcasts/${listId}`)).statusCode).toBe(404);
      expect((await api(ctx, owen, "GET", `/broadcasts/${listId}/messages`)).statusCode).toBe(404);
      expect((await send(owen, listId, "after delete")).statusCode).toBe(404);
      const lists = await api(ctx, owen, "GET", "/broadcasts");
      expect(lists.json<{ lists: ListBody[] }>().lists).toEqual([]);

      for (const recipient of [ana, ben]) {
        const messages = await directMessages(recipient, owen);
        expect(messages.map((m) => Buffer.from(m.ciphertext, "base64").toString())).toEqual([
          "before delete",
        ]);
      }
      expect(
        await count(
          "SELECT COUNT(*)::int AS n FROM broadcast_message_recipients WHERE broadcast_message_id = $1",
          [sent.id],
        ),
      ).toBe(2);
    });
  });

  describe("delivery", () => {
    it("writes one ordinary direct message per recipient and no group chat", async () => {
      const listId = await createList(owen, [ana, ben, cara]);
      const sent = await broadcast(owen, listId, "Dinner at 8");

      expect(sent.state).toBe("completed");
      expect(sent.summary).toEqual({
        total: 3,
        pending: 0,
        accepted: 3,
        delivered: 0,
        read: 0,
        failed: 0,
        retryable: 0,
      });
      expect(Buffer.from(sent.ciphertext, "base64").toString()).toBe("Dinner at 8");

      const chatIds = new Set<string>();
      for (const recipient of [ana, ben, cara]) {
        const messages = await directMessages(recipient, owen);
        expect(messages).toHaveLength(1);
        expect(messages[0]?.senderId).toBe(owen.user.id);
        expect(Buffer.from(messages[0]?.ciphertext ?? "", "base64").toString()).toBe("Dinner at 8");
        chatIds.add(messages[0]?.chatId ?? "");

        const chats = await api(ctx, recipient, "GET", "/chats");
        const list = chats.json<{
          chats: { type: string; unreadCount: number; peer: { id: string } }[];
        }>().chats;
        expect(list).toHaveLength(1);
        expect(list[0]).toMatchObject({
          type: "direct",
          unreadCount: 1,
          peer: { id: owen.user.id },
        });
      }
      expect(chatIds.size).toBe(3);
      expect(await count("SELECT COUNT(*)::int AS n FROM chats WHERE type = 'group'")).toBe(0);
      expect(await count("SELECT COUNT(*)::int AS n FROM messages")).toBe(3);

      // The body lives in the direct messages only.
      const { rows } = await pool.query<{ ciphertext: Buffer | null; completed_at: Date | null }>(
        "SELECT ciphertext, completed_at FROM broadcast_messages WHERE id = $1",
        [sent.id],
      );
      expect(rows[0]?.ciphertext).toBeNull();
      expect(rows[0]?.completed_at).not.toBeNull();

      // Each recipient record points at that recipient's message.
      const mapping = await pool.query<{ recipient_id: string; message_chat: string }>(
        `SELECT r.recipient_id, m.chat_id AS message_chat
         FROM broadcast_message_recipients r JOIN messages m ON m.id = r.message_id
         WHERE r.broadcast_message_id = $1 AND m.chat_id = r.target_chat_id`,
        [sent.id],
      );
      expect(mapping.rows).toHaveLength(3);

      const history = await api(ctx, owen, "GET", `/broadcasts/${listId}/messages`);
      const page = history.json<{ broadcasts: BroadcastBody[]; hasMore: boolean }>();
      expect(page.broadcasts.map((b) => b.id)).toEqual([sent.id]);
      expect(Buffer.from(page.broadcasts[0]?.ciphertext ?? "", "base64").toString()).toBe(
        "Dinner at 8",
      );

      const lists = await api(ctx, owen, "GET", "/broadcasts");
      expect(lists.json<{ lists: ListBody[] }>().lists[0]?.lastBroadcast?.id).toBe(sent.id);

      // The sender's direct chats show the message too.
      const owenChats = await api(ctx, owen, "GET", "/chats");
      expect(owenChats.json<{ chats: unknown[] }>().chats).toHaveLength(3);
    });

    it("reuses an existing direct chat", async () => {
      const chatId = await openChat(ctx, owen, ana);
      expect((await sendText(ctx, ana, chatId, "hey")).statusCode).toBe(201);
      const listId = await createList(owen, [ana]);
      await broadcast(owen, listId, "news");

      const messages = await directMessages(ana, owen);
      expect(messages.map((m) => [m.chatId, m.sequence])).toEqual([
        [chatId, 1],
        [chatId, 2],
      ]);
      expect(await count("SELECT COUNT(*)::int AS n FROM chats WHERE type = 'direct'")).toBe(1);
      const r = await report(owen, listId, (await details(owen, listId)).lastBroadcast?.id ?? "");
      expect(r.byUser.get(ana.user.id)?.chatId).toBe(chatId);
    });

    it("keeps recipients unaware of each other and of the list", async () => {
      const listId = await createList(owen, [ana, ben]);
      const sent = await broadcast(owen, listId, "private to each");

      const messages = await directMessages(ana, owen);
      const keys = Object.keys(messages[0] ?? {});
      expect(keys.some((key) => /broadcast|list|recipient/i.test(key))).toBe(false);
      expect(JSON.stringify(messages)).not.toContain(listId);
      expect(JSON.stringify(messages)).not.toContain(ben.user.id);
      expect(JSON.stringify(messages)).not.toContain("Family");

      const anaChats = await api(ctx, ana, "GET", "/chats");
      expect(JSON.stringify(anaChats.json())).not.toContain(ben.user.id);
      expect(
        (await api(ctx, ana, "GET", `/broadcasts/${listId}/messages/${sent.id}`)).statusCode,
      ).toBe(404);
    });

    it("keeps replies in the replier's direct chat", async () => {
      const listId = await createList(owen, [ana, ben]);
      await broadcast(owen, listId, "Who's coming?");

      const anaChat = await openChat(ctx, ana, owen);
      expect((await sendText(ctx, ana, anaChat, "Me!")).statusCode).toBe(201);

      expect((await directMessages(ben, owen)).map((m) => m.senderId)).toEqual([owen.user.id]);
      expect((await directMessages(owen, ana)).map((m) => m.senderId)).toEqual([
        owen.user.id,
        ana.user.id,
      ]);
      const history = await api(ctx, owen, "GET", `/broadcasts/${listId}/messages`);
      expect(history.json<{ broadcasts: unknown[] }>().broadcasts).toHaveLength(1);
    });

    it("does not duplicate anything when a send is retried", async () => {
      const listId = await createList(owen, [ana, ben]);
      const clientMessageId = randomUUID();

      const [first, second] = await Promise.all([
        send(owen, listId, "once", clientMessageId),
        send(owen, listId, "once", clientMessageId),
      ]);
      expect([first.statusCode, second.statusCode].sort()).toEqual([200, 201]);
      const again = await send(owen, listId, "once", clientMessageId);
      expect(again.statusCode).toBe(200);
      const ids = [first, second, again].map(
        (response) => response.json<{ broadcast: BroadcastBody }>().broadcast.id,
      );
      expect(new Set(ids).size).toBe(1);

      expect(await count("SELECT COUNT(*)::int AS n FROM broadcast_messages")).toBe(1);
      expect(await count("SELECT COUNT(*)::int AS n FROM messages")).toBe(2);
      expect((await directMessages(ana, owen)).length).toBe(1);

      // The same client message ID can't be reused for another list.
      const otherList = await createList(owen, [cara]);
      const conflict = await send(owen, otherList, "once", clientMessageId);
      expect(conflict.statusCode).toBe(409);
      expect(conflict.json<{ error: { code: string } }>().error.code).toBe(
        "CLIENT_MESSAGE_ID_CONFLICT",
      );
    });

    it("keeps successful deliveries when some recipients fail, and retries only those that may succeed", async () => {
      const listId = await createList(owen, [ana, ben, cara]);
      // After the list was made: Owen blocks Ben (fixable), Cara blocks Owen
      // (permanent, and indistinguishable from a closed account).
      expect((await block(owen, ben)).statusCode).toBe(204);
      expect((await block(cara, owen)).statusCode).toBe(204);

      const sent = await broadcast(owen, listId, "partial");
      expect(sent.state).toBe("partial");
      expect(sent.summary).toMatchObject({ total: 3, accepted: 1, failed: 2, retryable: 1 });

      let r = await report(owen, listId, sent.id);
      expect(r.byUser.get(ana.user.id)).toMatchObject({ status: "sent", failureCode: null });
      expect(r.byUser.get(ben.user.id)).toMatchObject({
        status: "failed",
        failureCode: "BLOCKED",
        retryable: true,
        chatId: null,
      });
      expect(r.byUser.get(cara.user.id)).toMatchObject({
        status: "failed",
        failureCode: "RECIPIENT_UNAVAILABLE",
        retryable: false,
      });
      expect(await count("SELECT COUNT(*)::int AS n FROM messages")).toBe(1);
      // A retry may still need the body.
      const { rows } = await pool.query<{ ciphertext: Buffer | null }>(
        "SELECT ciphertext FROM broadcast_messages WHERE id = $1",
        [sent.id],
      );
      expect(rows[0]?.ciphertext).not.toBeNull();

      // Still blocked: the retry fails again, nothing else is touched.
      const stillBlocked = await api(
        ctx,
        owen,
        "POST",
        `/broadcasts/${listId}/messages/${sent.id}/retry`,
      );
      expect(stillBlocked.statusCode, stillBlocked.body).toBe(200);
      r = await report(owen, listId, sent.id);
      expect(r.byUser.get(ben.user.id)).toMatchObject({ failureCode: "BLOCKED", attemptCount: 1 });

      expect((await api(ctx, owen, "DELETE", `/privacy/blocks/${ben.user.id}`)).statusCode).toBe(
        204,
      );
      const retried = await api(
        ctx,
        owen,
        "POST",
        `/broadcasts/${listId}/messages/${sent.id}/retry`,
      );
      const after = retried.json<{ broadcast: BroadcastBody }>().broadcast;
      expect(after.summary).toMatchObject({ accepted: 2, failed: 1, retryable: 0 });
      expect(after.state).toBe("partial");

      r = await report(owen, listId, sent.id);
      expect(r.byUser.get(ben.user.id)).toMatchObject({ status: "sent", attemptCount: 2 });
      expect(r.byUser.get(cara.user.id)?.status).toBe("failed");
      expect((await directMessages(ana, owen)).length).toBe(1);
      expect((await directMessages(ben, owen)).length).toBe(1);
      expect(await count("SELECT COUNT(*)::int AS n FROM messages")).toBe(2);
      expect(await count("SELECT COUNT(*)::int AS n FROM chats WHERE type = 'direct'")).toBe(2);

      // Body dropped once no retry can need it.
      const cleared = await pool.query<{ ciphertext: Buffer | null }>(
        "SELECT ciphertext FROM broadcast_messages WHERE id = $1",
        [sent.id],
      );
      expect(cleared.rows[0]?.ciphertext).toBeNull();
      expect(Buffer.from(after.ciphertext, "base64").toString()).toBe("partial");
    });

    it("records a delivery error as retryable and recovers on retry", async () => {
      const listId = await createList(owen, [ana, dev]);
      const devChat = await openChat(ctx, owen, dev);
      // A real database failure for Dev's chat only.
      await pool.query(`
        CREATE OR REPLACE FUNCTION test_reject_message() RETURNS trigger AS $$
        BEGIN RAISE EXCEPTION 'simulated storage failure'; END $$ LANGUAGE plpgsql;
      `);
      await pool.query(`
        CREATE TRIGGER test_reject_message BEFORE INSERT ON messages
        FOR EACH ROW WHEN (NEW.chat_id = '${devChat}') EXECUTE FUNCTION test_reject_message();
      `);
      let sent: BroadcastBody;
      try {
        sent = await broadcast(owen, listId, "flaky");
      } finally {
        await pool.query("DROP TRIGGER IF EXISTS test_reject_message ON messages");
        await pool.query("DROP FUNCTION IF EXISTS test_reject_message()");
      }

      expect(sent.state).toBe("partial");
      let r = await report(owen, listId, sent.id);
      expect(r.byUser.get(ana.user.id)?.status).toBe("sent");
      expect(r.byUser.get(dev.user.id)).toMatchObject({
        status: "failed",
        failureCode: "DELIVERY_FAILED",
        retryable: true,
        attemptCount: 1,
      });

      const retried = await api(
        ctx,
        owen,
        "POST",
        `/broadcasts/${listId}/messages/${sent.id}/retry`,
      );
      expect(retried.json<{ broadcast: BroadcastBody }>().broadcast.state).toBe("completed");
      r = await report(owen, listId, sent.id);
      expect(r.byUser.get(dev.user.id)).toMatchObject({ status: "sent", attemptCount: 2 });
      expect((await directMessages(dev, owen)).length).toBe(1);
      expect((await directMessages(ana, owen)).length).toBe(1);
    });

    it("keeps each broadcast's recipient snapshot through later edits", async () => {
      const listId = await createList(owen, [ana, ben]);
      const first = await broadcast(owen, listId, "first");

      await api(ctx, owen, "POST", `/broadcasts/${listId}/recipients`, {
        recipientIds: [cara.user.id],
      });
      await api(ctx, owen, "DELETE", `/broadcasts/${listId}/recipients/${ben.user.id}`);
      const second = await broadcast(owen, listId, "second");

      expect([...(await report(owen, listId, first.id)).byUser.keys()].sort()).toEqual(
        idsOf([ana, ben]).sort(),
      );
      expect([...(await report(owen, listId, second.id)).byUser.keys()].sort()).toEqual(
        idsOf([ana, cara]).sort(),
      );
      // Removing Ben didn't touch what he already received.
      expect((await directMessages(ben, owen)).length).toBe(1);
      expect((await directMessages(cara, owen)).length).toBe(1);
      expect((await directMessages(ana, owen)).length).toBe(2);
    });

    it("resolves a send racing a delete to one well-defined outcome", async () => {
      for (let round = 0; round < 5; round += 1) {
        const listId = await createList(owen, [ana, ben]);
        const [sent, deleted] = await Promise.all([
          send(owen, listId, `race ${round}`),
          api(ctx, owen, "DELETE", `/broadcasts/${listId}`),
        ]);
        expect(deleted.statusCode).toBe(204);
        const recipients = await count(
          `SELECT COUNT(*)::int AS n FROM broadcast_message_recipients r
           JOIN broadcast_messages bm ON bm.id = r.broadcast_message_id
           WHERE bm.broadcast_list_id = $1`,
          [listId],
        );
        if (sent.statusCode === 201) {
          // Accepted before the delete: the full snapshot is delivered.
          expect(recipients).toBe(2);
          expect(
            await count(
              `SELECT COUNT(*)::int AS n FROM broadcast_message_recipients r
               JOIN broadcast_messages bm ON bm.id = r.broadcast_message_id
               WHERE bm.broadcast_list_id = $1 AND r.status = 'sent'`,
              [listId],
            ),
          ).toBe(2);
        } else {
          expect(sent.statusCode).toBe(404);
          expect(recipients).toBe(0);
        }
      }
    });

    it("refuses to send to a list with no recipients", async () => {
      const listId = await createList(owen, [ana]);
      await api(ctx, owen, "DELETE", `/broadcasts/${listId}/recipients/${ana.user.id}`);
      const response = await send(owen, listId, "anyone?");
      expect(response.statusCode).toBe(409);
      expect(response.json<{ error: { code: string } }>().error.code).toBe("NO_RECIPIENTS");
      expect(await count("SELECT COUNT(*)::int AS n FROM broadcast_messages")).toBe(0);
    });

    it("pages history oldest first", async () => {
      const listId = await createList(owen, [ana]);
      const sent: string[] = [];
      for (const text of ["one", "two", "three"])
        sent.push((await broadcast(owen, listId, text)).id);

      const latest = await api(ctx, owen, "GET", `/broadcasts/${listId}/messages?limit=2`);
      const page = latest.json<{ broadcasts: BroadcastBody[]; hasMore: boolean }>();
      expect(page.broadcasts.map((b) => b.id)).toEqual(sent.slice(1));
      expect(page.hasMore).toBe(true);

      const older = await api(
        ctx,
        owen,
        "GET",
        `/broadcasts/${listId}/messages?limit=2&before=${page.broadcasts[0]?.id}`,
      );
      const rest = older.json<{ broadcasts: BroadcastBody[]; hasMore: boolean }>();
      expect(rest.broadcasts.map((b) => b.id)).toEqual(sent.slice(0, 1));
      expect(rest.hasMore).toBe(false);
    });
  });

  describe("receipts and realtime", () => {
    it("advances only the acknowledging recipient, never backwards", async () => {
      const listId = await createList(owen, [ana, ben]);
      const sent = await broadcast(owen, listId, "status?");
      const anaChat = await openChat(ctx, ana, owen);
      const [message] = await directMessages(ana, owen);
      const sequence = message?.sequence ?? 0;

      const owenSocket = await connect(owen);
      try {
        const delivered = nextEvent<{ reason: string; broadcast: BroadcastBody }>(
          owenSocket,
          "broadcast.updated",
        );
        await api(ctx, ana, "POST", `/chats/${anaChat}/receipts`, { deliveredSequence: sequence });
        const event = await delivered;
        expect(event.reason).toBe("delivered");
        expect(event.broadcast.summary).toMatchObject({ accepted: 2, delivered: 1, read: 0 });

        const read = nextEvent<{ reason: string; broadcast: BroadcastBody }>(
          owenSocket,
          "broadcast.updated",
        );
        await api(ctx, ana, "POST", `/chats/${anaChat}/receipts`, { readSequence: sequence });
        expect((await read).reason).toBe("read");
      } finally {
        owenSocket.terminate();
      }

      let r = await report(owen, listId, sent.id);
      expect(r.byUser.get(ana.user.id)?.status).toBe("read");
      expect(r.byUser.get(ana.user.id)?.readAt).not.toBeNull();
      expect(r.byUser.get(ben.user.id)?.status).toBe("sent");
      expect(r.broadcast.summary).toMatchObject({ accepted: 2, delivered: 1, read: 1 });

      // A late or duplicate delivery ack doesn't move read back.
      await api(ctx, ana, "POST", `/chats/${anaChat}/receipts`, { deliveredSequence: sequence });
      await api(ctx, ana, "POST", `/chats/${anaChat}/receipts`, { deliveredSequence: 0 });
      r = await report(owen, listId, sent.id);
      expect(r.byUser.get(ana.user.id)?.status).toBe("read");

      // Ben's own chat activity only affects Ben.
      const benChat = await openChat(ctx, ben, owen);
      await api(ctx, ben, "POST", `/chats/${benChat}/receipts`, { deliveredSequence: 1 });
      r = await report(owen, listId, sent.id);
      expect(r.byUser.get(ben.user.id)?.status).toBe("delivered");
      expect(r.byUser.get(ana.user.id)?.status).toBe("read");
    });

    it("doesn't report reads a recipient has hidden", async () => {
      await pool.query(
        "UPDATE privacy_settings SET show_read_receipts = FALSE WHERE user_id = $1",
        [ben.user.id],
      );
      const listId = await createList(owen, [ben]);
      const sent = await broadcast(owen, listId, "seen?");
      const benChat = await openChat(ctx, ben, owen);
      await api(ctx, ben, "POST", `/chats/${benChat}/receipts`, { readSequence: 1 });

      const r = await report(owen, listId, sent.id);
      expect(r.byUser.get(ben.user.id)).toMatchObject({ status: "delivered", readAt: null });
      expect(r.broadcast.summary).toMatchObject({ delivered: 1, read: 0 });
    });

    it("sends broadcast events only to the owner; recipients get a normal message", async () => {
      const listId = await createList(owen, [ana, ben]);
      const owenSocket = await connect(owen);
      const anaSocket = await connect(ana);
      const anaEvents = record(anaSocket);
      try {
        const accepted = nextEvent<{ reason: string }>(owenSocket, "broadcast.updated");
        const anaMessage = nextEvent<{ chatId: string; message: MessageBody }>(
          anaSocket,
          "message.new",
        );
        const sent = await broadcast(owen, listId, "live");
        expect((await accepted).reason).toBe("accepted");
        const received = await anaMessage;
        expect(received.message.senderId).toBe(owen.user.id);
        expect(received.chatId).toBe(await openChat(ctx, ana, owen));
        expect(JSON.stringify(received)).not.toContain(sent.id);

        // Let any stray events arrive.
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(anaEvents.types.filter((type) => type.startsWith("broadcast"))).toEqual([]);
        expect(anaEvents.types.filter((type) => type === "message.new")).toHaveLength(1);
      } finally {
        owenSocket.terminate();
        anaSocket.terminate();
      }
    });

    it("announces list changes and deletion to the owner", async () => {
      const listId = await createList(owen, [ana]);
      const owenSocket = await connect(owen);
      try {
        const updated = nextEvent<{ listId: string }>(owenSocket, "broadcast.list.updated");
        await api(ctx, owen, "PATCH", `/broadcasts/${listId}`, { name: "New name" });
        expect((await updated).listId).toBe(listId);

        const deleted = nextEvent<{ listId: string }>(owenSocket, "broadcast.list.deleted");
        await api(ctx, owen, "DELETE", `/broadcasts/${listId}`);
        expect((await deleted).listId).toBe(listId);
      } finally {
        owenSocket.terminate();
      }
    });

    it("delivers accepted work after a restart, exactly once", async () => {
      // An instance that accepts broadcasts but dies before delivering them.
      const crashed = await createTestApp({ chats: { broadcastDispatchInline: false } });
      let accepted: BroadcastBody;
      let listId: string;
      try {
        listId = await createList(owen, [ana, ben]);
        const response = await crashed.app.inject({
          method: "POST",
          url: `/broadcasts/${listId}/messages`,
          headers: bearer(owen.accessToken),
          payload: {
            clientMessageId: randomUUID(),
            type: "text",
            ciphertext: encodeText("durable"),
            protocol: "opene2ee-v1",
          },
        });
        expect(response.statusCode, response.body).toBe(201);
        accepted = response.json<{ broadcast: BroadcastBody }>().broadcast;
      } finally {
        await crashed.app.close();
      }
      expect(accepted.state).toBe("sending");
      expect(accepted.summary).toMatchObject({ total: 2, pending: 2, accepted: 0 });
      expect(await count("SELECT COUNT(*)::int AS n FROM messages")).toBe(0);

      // The surviving instance's sweep picks it up.
      expect(await ctx.app.broadcastDispatcher.sweep(0)).toBe(1);
      expect(await ctx.app.broadcastDispatcher.sweep(0)).toBe(0);

      const r = await report(owen, listId, accepted.id);
      expect(r.broadcast.state).toBe("completed");
      expect([...r.byUser.values()].map((row) => row.status)).toEqual(["sent", "sent"]);
      expect(await count("SELECT COUNT(*)::int AS n FROM messages")).toBe(2);
      // A reconnecting client syncing from scratch sees one copy.
      expect((await directMessages(ana, owen)).length).toBe(1);
    });
  });
});
