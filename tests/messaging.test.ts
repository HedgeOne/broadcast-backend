import { randomUUID } from "node:crypto";

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

interface ChatSummaryBody {
  id: string;
  peer: { id: string; displayName: string | null; blockedByMe: boolean };
  lastMessage: { sequence: number; ciphertext: string; senderId: string } | null;
  lastSequence: number;
  unreadCount: number;
  muted: boolean;
  peerDeliveredSequence: number;
  peerReadSequence: number | null;
}

interface MessageBody {
  id: string;
  sequence: number;
  clientMessageId: string;
  ciphertext: string;
}

describe("direct messaging", () => {
  let ctx: TestContext;
  let ana: TestUser;
  let ben: TestUser;

  beforeAll(async () => {
    ctx = await createTestApp();
    await ctx.app.realtimeHub.ready();
  });

  beforeEach(async () => {
    await resetState();
    ana = await createUser(ctx, "ana", { displayName: "Ana" });
    ben = await createUser(ctx, "ben", { displayName: "Ben" });
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  async function chatList(user: TestUser): Promise<ChatSummaryBody[]> {
    const response = await api(ctx, user, "GET", "/chats");
    expect(response.statusCode).toBe(200);
    return response.json<{ chats: ChatSummaryBody[] }>().chats;
  }

  async function summary(user: TestUser, chatId: string): Promise<ChatSummaryBody> {
    const response = await api(ctx, user, "GET", `/chats/${chatId}`);
    expect(response.statusCode).toBe(200);
    return response.json<{ chat: ChatSummaryBody }>().chat;
  }

  describe("authentication", () => {
    it.each([
      ["GET", "/chats"],
      ["POST", "/chats/direct"],
      ["GET", `/chats/${randomUUID()}/messages`],
      ["POST", "/contacts/match"],
      ["PUT", `/privacy/blocks/${randomUUID()}`],
    ] as const)("rejects %s %s without a session", async (method, url) => {
      const response = await ctx.app.inject({ method, url, payload: {} });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({ error: { code: "UNAUTHENTICATED" } });
    });

    it("rejects requests after the session is revoked", async () => {
      await api(ctx, ana, "POST", "/auth/logout");
      const response = await api(ctx, ana, "GET", "/chats");
      expect(response.statusCode).toBe(401);
    });
  });

  describe("conversations", () => {
    it("returns an empty list for a new user", async () => {
      expect(await chatList(ana)).toEqual([]);
    });

    it("creates the direct chat once, whoever opens it and however often", async () => {
      const first = await openChat(ctx, ana, ben);
      const again = await openChat(ctx, ana, ben);
      const fromBen = await openChat(ctx, ben, ana);
      expect(again).toBe(first);
      expect(fromBen).toBe(first);
    });

    it("never creates duplicate direct chats under concurrent requests", async () => {
      const ids = await Promise.all([
        openChat(ctx, ana, ben),
        openChat(ctx, ben, ana),
        openChat(ctx, ana, ben),
        openChat(ctx, ben, ana),
      ]);
      expect(new Set(ids).size).toBe(1);
      const { rows } = await pool.query<{ count: string }>(
        "SELECT COUNT(*) AS count FROM chats WHERE type = 'direct'",
      );
      expect(Number(rows[0]?.count)).toBe(1);
    });

    it("rejects a chat with yourself or an unknown user", async () => {
      const self = await api(ctx, ana, "POST", "/chats/direct", { userId: ana.user.id });
      expect(self.json()).toMatchObject({ error: { code: "CANNOT_MESSAGE_SELF" } });

      const unknown = await api(ctx, ana, "POST", "/chats/direct", { userId: randomUUID() });
      expect(unknown.statusCode).toBe(404);
      expect(unknown.json()).toMatchObject({ error: { code: "USER_NOT_FOUND" } });
    });

    it("hides empty chats from the list until the first message", async () => {
      const chatId = await openChat(ctx, ana, ben);
      expect(await chatList(ben)).toEqual([]);
      expect((await summary(ana, chatId)).lastMessage).toBeNull();

      await sendText(ctx, ana, chatId, "hi");
      const list = await chatList(ben);
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({
        id: chatId,
        peer: { id: ana.user.id, displayName: "Ana", blockedByMe: false },
        unreadCount: 1,
        lastMessage: {
          sequence: 1,
          senderId: ana.user.id,
        },
      });
      // Server stores an opaque protocol pointer, never UTF-8 plaintext.
      const last = list[0]!.lastMessage!;
      const pointer = JSON.parse(Buffer.from(last.ciphertext, "base64").toString("utf8")) as {
        protocol?: string;
      };
      expect(pointer.protocol).toBe("opene2ee-v1");
    });

    it("does not reveal a chat to non-members", async () => {
      const chatId = await openChat(ctx, ana, ben);
      const eve = await createUser(ctx, "eve");
      expect((await api(ctx, eve, "GET", `/chats/${chatId}`)).statusCode).toBe(404);
      expect((await api(ctx, eve, "GET", `/chats/${chatId}/messages`)).statusCode).toBe(404);
      expect((await sendText(ctx, eve, chatId, "x")).statusCode).toBe(404);
    });

    it("orders the list by the latest message", async () => {
      const cara = await createUser(ctx, "cara", { displayName: "Cara" });
      const withBen = await openChat(ctx, ana, ben);
      const withCara = await openChat(ctx, ana, cara);
      await sendText(ctx, ana, withBen, "first");
      await sendText(ctx, ana, withCara, "second");
      expect((await chatList(ana)).map((chat) => chat.id)).toEqual([withCara, withBen]);

      await sendText(ctx, ben, withBen, "reply");
      expect((await chatList(ana)).map((chat) => chat.id)).toEqual([withBen, withCara]);
    });

    it("mutes and unmutes for the caller only", async () => {
      const chatId = await openChat(ctx, ana, ben);
      const muted = await api(ctx, ana, "PUT", `/chats/${chatId}/mute`, { muted: true });
      expect(muted.json()).toMatchObject({ chat: { muted: true } });
      expect((await summary(ben, chatId)).muted).toBe(false);

      const unmuted = await api(ctx, ana, "PUT", `/chats/${chatId}/mute`, { muted: false });
      expect(unmuted.json()).toMatchObject({ chat: { muted: false } });
    });
  });

  describe("sending", () => {
    it("persists a message with a server-assigned sequence", async () => {
      const chatId = await openChat(ctx, ana, ben);
      const clientMessageId = randomUUID();
      const response = await sendText(ctx, ana, chatId, "Hello Ben", clientMessageId);

      expect(response.statusCode).toBe(201);
      const { message } = response.json<{ message: MessageBody }>();
      expect(message).toMatchObject({ sequence: 1, clientMessageId });
      const stored = Buffer.from(message.ciphertext, "base64").toString("utf8");
      expect(stored).not.toContain("Hello Ben");
      expect(JSON.parse(stored)).toMatchObject({ v: 1, protocol: "opene2ee-v1" });

      const { rows } = await pool.query("SELECT sequence FROM messages WHERE id = $1", [
        message.id,
      ]);
      expect(rows).toHaveLength(1);
    });

    it("treats a retried client message ID as the same message", async () => {
      const chatId = await openChat(ctx, ana, ben);
      const clientMessageId = randomUUID();
      const first = await sendText(ctx, ana, chatId, "once", clientMessageId);
      const retry = await sendText(ctx, ana, chatId, "once", clientMessageId);

      expect(first.statusCode).toBe(201);
      expect(retry.statusCode).toBe(200);
      expect(retry.json<{ message: MessageBody }>().message).toEqual(
        first.json<{ message: MessageBody }>().message,
      );
      const { rows } = await pool.query<{ count: string }>(
        "SELECT COUNT(*) AS count FROM messages WHERE chat_id = $1",
        [chatId],
      );
      expect(Number(rows[0]?.count)).toBe(1);
    });

    it("never duplicates under concurrent retries", async () => {
      const chatId = await openChat(ctx, ana, ben);
      const clientMessageId = randomUUID();
      const results = await Promise.all(
        Array.from({ length: 5 }, () => sendText(ctx, ana, chatId, "race", clientMessageId)),
      );
      expect(results.map((r) => r.statusCode).sort()).toEqual([200, 200, 200, 200, 201]);
      const ids = new Set(results.map((r) => r.json<{ message: MessageBody }>().message.id));
      expect(ids.size).toBe(1);
    });

    it("rejects reusing a client message ID in another chat", async () => {
      const cara = await createUser(ctx, "cara");
      const withBen = await openChat(ctx, ana, ben);
      const withCara = await openChat(ctx, ana, cara);
      const clientMessageId = randomUUID();
      await sendText(ctx, ana, withBen, "a", clientMessageId);
      const reused = await sendText(ctx, ana, withCara, "b", clientMessageId);
      expect(reused.statusCode).toBe(409);
    });

    it("rejects non-text types and malformed bodies", async () => {
      const chatId = await openChat(ctx, ana, ben);
      const image = await api(ctx, ana, "POST", `/chats/${chatId}/messages`, {
        clientMessageId: randomUUID(),
        type: "image",
        ciphertext: encodeText("x"),
        protocol: "opene2ee-v1",
      });
      expect(image.statusCode).toBe(400);
      const notBase64 = await api(ctx, ana, "POST", `/chats/${chatId}/messages`, {
        clientMessageId: randomUUID(),
        type: "text",
        ciphertext: "not base64!",
      });
      expect(notBase64.statusCode).toBe(400);
    });

    it("orders by sequence and pages forwards and backwards", async () => {
      const chatId = await openChat(ctx, ana, ben);
      for (const [user, text] of [
        [ana, "one"],
        [ben, "two"],
        [ana, "three"],
        [ben, "four"],
      ] as const) {
        expect((await sendText(ctx, user, chatId, text)).statusCode).toBe(201);
      }

      const all = await api(ctx, ben, "GET", `/chats/${chatId}/messages`);
      const body = all.json<{ messages: MessageBody[]; hasMore: boolean }>();
      expect(body.messages.map((m) => m.sequence)).toEqual([1, 2, 3, 4]);
      expect(body.hasMore).toBe(false);

      const after = await api(ctx, ben, "GET", `/chats/${chatId}/messages?after=2`);
      expect(after.json<{ messages: MessageBody[] }>().messages.map((m) => m.sequence)).toEqual([
        3, 4,
      ]);

      const before = await api(ctx, ben, "GET", `/chats/${chatId}/messages?before=4&limit=2`);
      const page = before.json<{ messages: MessageBody[]; hasMore: boolean }>();
      expect(page.messages.map((m) => m.sequence)).toEqual([2, 3]);
      expect(page.hasMore).toBe(true);
    });

    it("assigns gap-free sequences to concurrent senders", async () => {
      const chatId = await openChat(ctx, ana, ben);
      await Promise.all(
        Array.from({ length: 6 }, (_, i) => sendText(ctx, i % 2 ? ben : ana, chatId, `m${i}`)),
      );
      const { rows } = await pool.query<{ sequence: string }>(
        "SELECT sequence FROM messages WHERE chat_id = $1 ORDER BY sequence",
        [chatId],
      );
      expect(rows.map((row) => Number(row.sequence))).toEqual([1, 2, 3, 4, 5, 6]);
    });
  });

  describe("receipts", () => {
    it("tracks delivered and read pointers and unread counts", async () => {
      const chatId = await openChat(ctx, ana, ben);
      await sendText(ctx, ana, chatId, "one");
      await sendText(ctx, ana, chatId, "two");

      expect((await summary(ben, chatId)).unreadCount).toBe(2);
      expect(await summary(ana, chatId)).toMatchObject({
        unreadCount: 0,
        peerDeliveredSequence: 0,
        peerReadSequence: 0,
      });

      await api(ctx, ben, "POST", `/chats/${chatId}/receipts`, { deliveredSequence: 2 });
      expect(await summary(ana, chatId)).toMatchObject({
        peerDeliveredSequence: 2,
        peerReadSequence: 0,
      });

      const read = await api(ctx, ben, "POST", `/chats/${chatId}/receipts`, { readSequence: 1 });
      expect(read.json()).toEqual({ deliveredSequence: 2, readSequence: 1 });
      expect((await summary(ben, chatId)).unreadCount).toBe(1);
      expect((await summary(ana, chatId)).peerReadSequence).toBe(1);
    });

    it("never moves pointers backwards or past the last message", async () => {
      const chatId = await openChat(ctx, ana, ben);
      await sendText(ctx, ana, chatId, "one");

      const ahead = await api(ctx, ben, "POST", `/chats/${chatId}/receipts`, { readSequence: 99 });
      expect(ahead.json()).toEqual({ deliveredSequence: 1, readSequence: 1 });

      const back = await api(ctx, ben, "POST", `/chats/${chatId}/receipts`, {
        deliveredSequence: 0,
        readSequence: 0,
      });
      expect(back.json()).toEqual({ deliveredSequence: 1, readSequence: 1 });
    });

    it("hides read progress when either user turns read receipts off", async () => {
      const chatId = await openChat(ctx, ana, ben);
      await sendText(ctx, ana, chatId, "one");
      await pool.query(
        "UPDATE privacy_settings SET show_read_receipts = FALSE WHERE user_id = $1",
        [ben.user.id],
      );
      await api(ctx, ben, "POST", `/chats/${chatId}/receipts`, { readSequence: 1 });

      expect(await summary(ana, chatId)).toMatchObject({
        peerDeliveredSequence: 1,
        peerReadSequence: null,
      });
      expect((await summary(ben, chatId)).unreadCount).toBe(0);
    });
  });

  describe("realtime", () => {
    function connect(user: TestUser) {
      return ctx.app.injectWS("/ws", { headers: bearer(user.accessToken) });
    }

    it("refuses sockets without a valid session", async () => {
      await expect(ctx.app.injectWS("/ws")).rejects.toThrow();
    });

    it("delivers new messages to the recipient and the sender's devices", async () => {
      const chatId = await openChat(ctx, ana, ben);
      const benSocket = await connect(ben);
      const anaSocket = await connect(ana);
      try {
        const toBen = nextEvent<{ chatId: string; message: MessageBody }>(benSocket, "message.new");
        const toAna = nextEvent<{ message: MessageBody }>(anaSocket, "message.new");
        await sendText(ctx, ana, chatId, "live");

        const event = await toBen;
        expect(event.chatId).toBe(chatId);
        expect(event.message.sequence).toBe(1);
        expect((await toAna).message.id).toBe(event.message.id);
      } finally {
        benSocket.terminate();
        anaSocket.terminate();
      }
    });

    it("does not re-deliver a retried message", async () => {
      const chatId = await openChat(ctx, ana, ben);
      const clientMessageId = randomUUID();
      await sendText(ctx, ana, chatId, "once", clientMessageId);

      const benSocket = await connect(ben);
      try {
        const duplicate = nextEvent(benSocket, "message.new", 300);
        await sendText(ctx, ana, chatId, "once", clientMessageId);
        await expect(duplicate).rejects.toThrow(/timed out/);
      } finally {
        benSocket.terminate();
      }
    });

    it("notifies the sender when the recipient reads", async () => {
      const chatId = await openChat(ctx, ana, ben);
      await sendText(ctx, ana, chatId, "one");
      const anaSocket = await connect(ana);
      try {
        const receipt = nextEvent<{ userId: string; readSequence: number | null }>(
          anaSocket,
          "receipt.updated",
        );
        await api(ctx, ben, "POST", `/chats/${chatId}/receipts`, { readSequence: 1 });
        expect(await receipt).toMatchObject({
          chatId,
          userId: ben.user.id,
          deliveredSequence: 1,
          readSequence: 1,
        });
      } finally {
        anaSocket.terminate();
      }
    });

    it("answers application pings", async () => {
      const socket = await connect(ana);
      try {
        const pong = nextEvent(socket, "pong");
        socket.send(JSON.stringify({ type: "ping" }));
        await pong;
      } finally {
        socket.terminate();
      }
    });
  });

  describe("blocking", () => {
    it("stops both users from messaging and creating chats", async () => {
      const chatId = await openChat(ctx, ana, ben);
      expect((await api(ctx, ana, "PUT", `/privacy/blocks/${ben.user.id}`)).statusCode).toBe(204);

      const fromAna = await sendText(ctx, ana, chatId, "x");
      expect(fromAna.statusCode).toBe(403);
      expect(fromAna.json()).toMatchObject({ error: { code: "BLOCKED" } });

      const fromBen = await sendText(ctx, ben, chatId, "x");
      expect(fromBen.statusCode).toBe(403);
      expect(fromBen.json()).toMatchObject({ error: { code: "RECIPIENT_UNAVAILABLE" } });

      expect((await summary(ana, chatId)).peer.blockedByMe).toBe(true);
      expect((await summary(ben, chatId)).peer.blockedByMe).toBe(false);

      const cara = await createUser(ctx, "cara");
      await api(ctx, cara, "PUT", `/privacy/blocks/${ana.user.id}`);
      const newChat = await api(ctx, ana, "POST", "/chats/direct", { userId: cara.user.id });
      expect(newChat.json()).toMatchObject({ error: { code: "RECIPIENT_UNAVAILABLE" } });
    });

    it("keeps existing history readable and allows messaging after unblocking", async () => {
      const chatId = await openChat(ctx, ana, ben);
      await sendText(ctx, ana, chatId, "before");
      await api(ctx, ana, "PUT", `/privacy/blocks/${ben.user.id}`);

      expect(await openChat(ctx, ana, ben)).toBe(chatId);
      expect((await api(ctx, ana, "GET", `/chats/${chatId}/messages`)).statusCode).toBe(200);

      expect((await api(ctx, ana, "DELETE", `/privacy/blocks/${ben.user.id}`)).statusCode).toBe(
        204,
      );
      expect((await sendText(ctx, ana, chatId, "after")).statusCode).toBe(201);
    });

    it("lets a failed send be retried with the same client message ID", async () => {
      const chatId = await openChat(ctx, ana, ben);
      await api(ctx, ana, "PUT", `/privacy/blocks/${ben.user.id}`);
      const clientMessageId = randomUUID();
      expect((await sendText(ctx, ana, chatId, "retry me", clientMessageId)).statusCode).toBe(403);

      await api(ctx, ana, "DELETE", `/privacy/blocks/${ben.user.id}`);
      const retry = await sendText(ctx, ana, chatId, "retry me", clientMessageId);
      expect(retry.statusCode).toBe(201);
      expect(retry.json<{ message: MessageBody }>().message.sequence).toBe(1);
    });

    it("blocking is idempotent and cannot target yourself", async () => {
      await api(ctx, ana, "PUT", `/privacy/blocks/${ben.user.id}`);
      expect((await api(ctx, ana, "PUT", `/privacy/blocks/${ben.user.id}`)).statusCode).toBe(204);
      expect((await api(ctx, ana, "PUT", `/privacy/blocks/${ana.user.id}`)).statusCode).toBe(400);
    });
  });

  describe("reports", () => {
    it("records a report and optionally blocks", async () => {
      const chatId = await openChat(ctx, ana, ben);
      const response = await api(ctx, ana, "POST", "/privacy/reports", {
        userId: ben.user.id,
        chatId,
        reason: "spam",
        block: true,
      });
      expect(response.statusCode).toBe(201);
      expect(response.json()).toEqual({ reported: true, blocked: true });
      expect((await summary(ana, chatId)).peer.blockedByMe).toBe(true);

      const { rows } = await pool.query("SELECT reason FROM user_reports WHERE reporter_id = $1", [
        ana.user.id,
      ]);
      expect(rows).toEqual([{ reason: "spam" }]);
    });

    it("rejects reports about a chat the reporter is not in", async () => {
      const eve = await createUser(ctx, "eve");
      const chatId = await openChat(ctx, ana, ben);
      const response = await api(ctx, eve, "POST", "/privacy/reports", {
        userId: ben.user.id,
        chatId,
        reason: "spam",
      });
      expect(response.statusCode).toBe(404);
    });
  });
});

describe("user profiles", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  beforeEach(resetState);

  afterAll(async () => {
    await ctx.app.close();
  });

  it("returns a minimal public profile without identifiers", async () => {
    const me = await createUser(ctx, "me");
    const other = await createUser(ctx, "other", {
      displayName: "Other",
      phone: "+919800000010",
    });
    const response = await api(ctx, me, "GET", `/users/${other.user.id}`);
    expect(response.json()).toEqual({
      user: {
        id: other.user.id,
        displayName: "Other",
        available: true,
        blockedByMe: false,
        photoId: null,
      },
    });
    expect(response.body).not.toMatch(/phone|\+91/i);
  });
});
