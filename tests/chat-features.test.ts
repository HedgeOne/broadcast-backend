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
import { FakeObjectStorage, SAMPLES } from "./helpers/media.js";
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

interface MessageBody {
  id: string;
  sequence: number;
  type: string;
  ciphertext: string;
  attachment: { id: string; type: string; fileName: string | null } | null;
  deleted: boolean;
  starred?: boolean;
  inHistory?: boolean;
}

interface SummaryBody {
  id: string;
  lastMessage: MessageBody | null;
  unreadCount: number;
  clearedThroughSequence: number;
}

interface BroadcastBody {
  id: string;
  sequence: number;
  starred: boolean;
  inHistory: boolean;
  attachment: { uploadId: string; type: string } | null;
}

interface FileSpec {
  category: "image" | "video" | "audio" | "document";
  mimeType: string;
  fileName: string;
  body: Buffer;
}

const PNG: FileSpec = {
  category: "image",
  mimeType: "image/png",
  fileName: "photo.png",
  body: SAMPLES.png,
};
const PDF: FileSpec = {
  category: "document",
  mimeType: "application/pdf",
  fileName: "Report.pdf",
  body: SAMPLES.pdf,
};

describe("chat features", () => {
  let ctx: TestContext;
  let storage: FakeObjectStorage;
  let ana: TestUser;
  let ben: TestUser;
  let cara: TestUser;

  beforeAll(async () => {
    storage = new FakeObjectStorage();
    ctx = await createTestApp({ chats: { storage } });
    await ctx.app.realtimeHub.ready();
  });

  beforeEach(async () => {
    await resetState();
    storage.objects.clear();
    ana = await createUser(ctx, "ana", { displayName: "Ana" });
    ben = await createUser(ctx, "ben", { displayName: "Ben" });
    cara = await createUser(ctx, "cara", { displayName: "Cara" });
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  function direct(a: TestUser, b: TestUser): Promise<string> {
    return openChat(ctx, a, b);
  }

  async function text(user: TestUser, chatId: string, body: string): Promise<MessageBody> {
    const response = await sendText(ctx, user, chatId, body);
    expect(response.statusCode, response.body).toBe(201);
    return response.json<{ message: MessageBody }>().message;
  }

  async function history(user: TestUser, chatId: string): Promise<MessageBody[]> {
    const response = await api(ctx, user, "GET", `/chats/${chatId}/messages`);
    expect(response.statusCode, response.body).toBe(200);
    return response.json<{ messages: MessageBody[] }>().messages;
  }

  async function chatList(user: TestUser): Promise<SummaryBody[]> {
    const response = await api(ctx, user, "GET", "/chats");
    expect(response.statusCode, response.body).toBe(200);
    return response.json<{ chats: SummaryBody[] }>().chats;
  }

  function clear(user: TestUser, chatId: string, keepStarred: boolean) {
    return api(ctx, user, "POST", `/chats/${chatId}/clear`, { keepStarred });
  }

  function star(user: TestUser, chatId: string, messageId: string, on = true) {
    return api(ctx, user, on ? "PUT" : "DELETE", `/chats/${chatId}/messages/${messageId}/star`);
  }

  async function starred(user: TestUser, chatId: string, query = ""): Promise<MessageBody[]> {
    const response = await api(ctx, user, "GET", `/chats/${chatId}/starred${query}`);
    expect(response.statusCode, response.body).toBe(200);
    return response.json<{ messages: MessageBody[] }>().messages;
  }

  async function upload(user: TestUser, file: FileSpec): Promise<string> {
    const session = await api(ctx, user, "POST", "/media/uploads", {
      clientUploadId: randomUUID(),
      category: file.category,
      mimeType: file.mimeType,
      fileName: file.fileName,
      fileSize: file.body.length,
      ...(file.category === "image" ? { width: 1, height: 1 } : {}),
    });
    expect(session.statusCode, session.body).toBe(201);
    const { upload: created, target } = session.json<{
      upload: { id: string };
      target: { url: string; headers: Record<string, string> };
    }>();
    expect(storage.put(target.url, file.body, target.headers["Content-Type"] ?? "")).toBe(200);
    const done = await api(ctx, user, "POST", `/media/uploads/${created.id}/complete`);
    expect(done.statusCode, done.body).toBe(200);
    return created.id;
  }

  async function sendFile(user: TestUser, chatId: string, file: FileSpec): Promise<MessageBody> {
    const uploadId = await upload(user, file);
    const response = await api(ctx, user, "POST", `/chats/${chatId}/messages`, {
      clientMessageId: randomUUID(),
      type: file.category,
      ciphertext: "",
      attachment: { uploadId },
    });
    expect(response.statusCode, response.body).toBe(201);
    return response.json<{ message: MessageBody }>().message;
  }

  async function shared(
    user: TestUser,
    chatId: string,
    query: string,
  ): Promise<{ messages: MessageBody[]; hasMore: boolean }> {
    const response = await api(ctx, user, "GET", `/chats/${chatId}/shared?${query}`);
    expect(response.statusCode, response.body).toBe(200);
    return response.json();
  }

  async function createGroup(owner: TestUser, members: TestUser[], name = "Trip"): Promise<string> {
    const response = await api(ctx, owner, "POST", "/groups", {
      clientRequestId: randomUUID(),
      name,
      memberIds: members.map((member) => member.user.id),
    });
    expect(response.statusCode, response.body).toBe(201);
    return response.json<{ chat: { id: string } }>().chat.id;
  }

  function connect(user: TestUser) {
    return ctx.app.injectWS("/ws", { headers: bearer(user.accessToken) });
  }

  function record(socket: WebSocket): { types: string[] } {
    const seen = { types: [] as string[] };
    socket.on("message", (raw: Buffer) => {
      seen.types.push((JSON.parse(raw.toString("utf8")) as { type: string }).type);
    });
    return seen;
  }

  describe("authentication and validation", () => {
    it.each([
      ["POST", `/chats/${randomUUID()}/clear`],
      ["PUT", `/chats/${randomUUID()}/messages/${randomUUID()}/star`],
      ["DELETE", `/chats/${randomUUID()}/messages/${randomUUID()}/star`],
      ["GET", `/chats/${randomUUID()}/starred`],
      ["GET", `/chats/${randomUUID()}/shared?kind=media`],
      ["POST", `/broadcasts/${randomUUID()}/clear`],
      ["GET", `/broadcasts/${randomUUID()}/shared?kind=docs`],
      ["GET", `/broadcasts/${randomUUID()}/starred`],
      ["GET", `/users/${randomUUID()}/groups-in-common`],
    ] as const)("rejects %s %s without a token", async (method, url) => {
      const response = await ctx.app.inject({ method, url });
      expect(response.statusCode).toBe(401);
    });

    it("validates bodies and cursors", async () => {
      const chatId = await openChat(ctx, ana, ben);
      await text(ana, chatId, "hi");
      expect((await api(ctx, ana, "POST", `/chats/${chatId}/clear`, {})).statusCode).toBe(400);
      expect(
        (await api(ctx, ana, "POST", `/chats/${chatId}/clear`, { keepStarred: "yes" })).statusCode,
      ).toBe(400);
      expect(
        (
          await api(ctx, ana, "POST", `/chats/${chatId}/clear`, {
            keepStarred: true,
            userId: ben.user.id,
          })
        ).statusCode,
      ).toBe(400);
      expect((await api(ctx, ana, "GET", `/chats/${chatId}/shared`)).statusCode).toBe(400);
      expect((await api(ctx, ana, "GET", `/chats/${chatId}/shared?kind=links`)).statusCode).toBe(
        400,
      );
      expect(
        (await api(ctx, ana, "GET", `/chats/${chatId}/shared?kind=media&before=abc`)).statusCode,
      ).toBe(400);
      expect((await api(ctx, ana, "GET", `/chats/${chatId}/starred?before=0`)).statusCode).toBe(
        400,
      );
      expect((await api(ctx, ana, "GET", `/chats/${chatId}/starred?limit=500`)).statusCode).toBe(
        400,
      );
    });

    it("hides every feature of a chat from non-members", async () => {
      const chatId = await openChat(ctx, ana, ben);
      const message = await text(ana, chatId, "private");
      for (const [method, url] of [
        ["POST", `/chats/${chatId}/clear`],
        ["PUT", `/chats/${chatId}/messages/${message.id}/star`],
        ["GET", `/chats/${chatId}/starred`],
        ["GET", `/chats/${chatId}/shared?kind=media`],
      ] as const) {
        const response = await api(
          ctx,
          cara,
          method,
          url,
          method === "POST" ? { keepStarred: true } : undefined,
        );
        expect(response.statusCode, `${method} ${url}`).toBe(404);
      }
    });
  });

  describe("clear chat", () => {
    it("clears only the caller's view, keeps the chat listed and lets new messages through", async () => {
      const chatId = await direct(ana, ben);
      await text(ana, chatId, "one");
      await text(ben, chatId, "two");

      const response = await clear(ana, chatId, false);
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toEqual({ chatId, clearedThroughSequence: 2 });

      expect(await history(ana, chatId)).toEqual([]);
      expect((await history(ben, chatId)).map((m) => m.sequence)).toEqual([1, 2]);
      expect(await pool.query("SELECT 1 FROM messages WHERE chat_id = $1", [chatId])).toMatchObject(
        { rowCount: 2 },
      );

      const listed = (await chatList(ana)).find((chat) => chat.id === chatId);
      expect(listed).toMatchObject({
        lastMessage: null,
        unreadCount: 0,
        clearedThroughSequence: 2,
      });
      expect((await chatList(ben)).find((chat) => chat.id === chatId)).toMatchObject({
        clearedThroughSequence: 0,
      });

      await text(ben, chatId, "three");
      expect((await history(ana, chatId)).map((m) => m.sequence)).toEqual([3]);
      expect((await chatList(ana)).find((chat) => chat.id === chatId)?.unreadCount).toBe(1);

      // Paging backwards never reaches cleared messages.
      const older = await api(ctx, ana, "GET", `/chats/${chatId}/messages?before=3`);
      expect(older.json<{ messages: MessageBody[] }>().messages).toEqual([]);
      const forward = await api(ctx, ana, "GET", `/chats/${chatId}/messages?after=0`);
      expect(forward.json<{ messages: MessageBody[] }>().messages.map((m) => m.sequence)).toEqual([
        3,
      ]);
    });

    it("is idempotent and never moves the marker back", async () => {
      const chatId = await direct(ana, ben);
      await text(ana, chatId, "one");
      expect((await clear(ana, chatId, true)).json()).toMatchObject({ clearedThroughSequence: 1 });
      expect((await clear(ana, chatId, true)).json()).toMatchObject({ clearedThroughSequence: 1 });
      await text(ana, chatId, "two");
      expect((await clear(ana, chatId, true)).json()).toMatchObject({ clearedThroughSequence: 2 });
    });

    it("tells only the caller's own devices", async () => {
      const chatId = await direct(ana, ben);
      await text(ana, chatId, "one");
      const anaSocket = await connect(ana);
      const benSocket = await connect(ben);
      const benSeen = record(benSocket);
      const event = nextEvent<{ chatId: string; clearedThroughSequence: number }>(
        anaSocket,
        "chat.cleared",
      );
      await clear(ana, chatId, true);
      expect(await event).toMatchObject({ chatId, clearedThroughSequence: 1 });
      const arrived = nextEvent(benSocket, "message.new");
      await text(ana, chatId, "after");
      await arrived;
      expect(benSeen.types).not.toContain("chat.cleared");
      expect(benSeen.types).not.toContain("message.deleted");
      anaSocket.terminate();
      benSocket.terminate();
    });

    it("keeps or removes stars as chosen, and kept stars still open their files", async () => {
      const chatId = await direct(ana, ben);
      const kept = await text(ben, chatId, "keep me");
      const photo = await sendFile(ben, chatId, PNG);
      expect((await star(ana, chatId, kept.id)).statusCode).toBe(200);
      expect((await star(ana, chatId, photo.id)).statusCode).toBe(200);
      expect((await star(ben, chatId, kept.id)).statusCode).toBe(200);

      await clear(ana, chatId, true);
      const list = await starred(ana, chatId);
      expect(list.map((m) => [m.id, m.inHistory, m.starred])).toEqual([
        [photo.id, false, true],
        [kept.id, false, true],
      ]);
      // A starred file stays downloadable; history and shared content don't show it.
      const attachmentId = photo.attachment?.id ?? "";
      expect(
        (await api(ctx, ana, "GET", `/media/attachments/${attachmentId}/url`)).statusCode,
      ).toBe(200);
      expect((await shared(ana, chatId, "kind=media")).messages).toEqual([]);
      // Starring a cleared message again isn't possible; unstarring is.
      expect((await star(ana, chatId, photo.id, false)).statusCode).toBe(200);
      expect((await star(ana, chatId, photo.id)).statusCode).toBe(404);
      expect(
        (await api(ctx, ana, "GET", `/media/attachments/${attachmentId}/url`)).statusCode,
      ).toBe(404);

      await text(ben, chatId, "new");
      await clear(ana, chatId, false);
      expect(await starred(ana, chatId)).toEqual([]);
      // Ben's own star is his.
      expect((await starred(ben, chatId)).map((m) => m.id)).toEqual([kept.id]);
    });

    it("survives leaving and rejoining a group that shares history", async () => {
      const chatId = await createGroup(ana, [ben]);
      const settings = await api(ctx, ana, "PATCH", `/groups/${chatId}/settings`, {
        historyVisibleToNewMembers: true,
      });
      expect(settings.statusCode, settings.body).toBe(200);
      await text(ana, chatId, "before clear");
      const cleared = (await clear(ben, chatId, false)).json<{ clearedThroughSequence: number }>();

      expect((await api(ctx, ben, "POST", `/groups/${chatId}/leave`)).statusCode).toBe(204);
      const readd = await api(ctx, ana, "POST", `/groups/${chatId}/members`, {
        userIds: [ben.user.id],
      });
      expect(readd.statusCode, readd.body).toBe(200);

      const visible = await history(ben, chatId);
      expect(visible.every((m) => m.sequence > cleared.clearedThroughSequence)).toBe(true);
      expect(visible.some((m) => m.type === "text")).toBe(false);
    });

    it("rate limits clearing and starring", async () => {
      const chatId = await direct(ana, ben);
      const message = await text(ana, chatId, "hi");
      const refuse = ["chat:clear:", "msg:star:"];
      const limited = await createTestApp({
        chats: {
          storage,
          rateLimiter: {
            consume: (key) =>
              Promise.resolve({
                allowed: !refuse.some((prefix) => key.startsWith(prefix)),
                retryAfterSeconds: 60,
              }),
          },
        },
      });
      try {
        const cleared = await limited.app.inject({
          method: "POST",
          url: `/chats/${chatId}/clear`,
          headers: bearer(ana.accessToken),
          payload: { keepStarred: true },
        });
        expect(cleared.statusCode).toBe(429);
        expect(cleared.json<{ error: { code: string } }>().error.code).toBe("RATE_LIMITED");
        const starredResponse = await limited.app.inject({
          method: "PUT",
          url: `/chats/${chatId}/messages/${message.id}/star`,
          headers: bearer(ana.accessToken),
        });
        expect(starredResponse.statusCode).toBe(429);
      } finally {
        await limited.app.close();
      }
    });
  });

  describe("starred messages", () => {
    it("stars idempotently per user and syncs to the user's devices only", async () => {
      const chatId = await direct(ana, ben);
      const message = await text(ben, chatId, "remember");
      const anaSocket = await connect(ana);
      const benSocket = await connect(ben);
      const benSeen = record(benSocket);

      const event = nextEvent<{ messageId: string; starred: boolean }>(
        anaSocket,
        "message.starred",
      );
      const first = await star(ana, chatId, message.id);
      expect(first.statusCode, first.body).toBe(200);
      expect(first.json()).toEqual({ messageId: message.id, starred: true });
      expect(await event).toMatchObject({ chatId, messageId: message.id, starred: true });
      expect((await star(ana, chatId, message.id)).json()).toEqual({
        messageId: message.id,
        starred: true,
      });
      expect(
        (await pool.query("SELECT 1 FROM starred_messages WHERE message_id = $1", [message.id]))
          .rowCount,
      ).toBe(1);

      expect((await history(ana, chatId))[0]?.starred).toBe(true);
      expect((await history(ben, chatId))[0]?.starred).toBe(false);
      const arrived = nextEvent(benSocket, "message.new");
      await text(ana, chatId, "ping");
      await arrived;
      expect(benSeen.types).not.toContain("message.starred");

      expect((await star(ana, chatId, message.id, false)).json()).toEqual({
        messageId: message.id,
        starred: false,
      });
      expect((await star(ana, chatId, message.id, false)).statusCode).toBe(200);
      expect(await starred(ana, chatId)).toEqual([]);
      anaSocket.terminate();
      benSocket.terminate();
    });

    it("refuses system, deleted, hidden and foreign messages", async () => {
      const groupId = await createGroup(ana, [ben]);
      const system = (await history(ana, groupId))[0];
      expect(system?.type).toBe("system");
      expect((await star(ana, groupId, system?.id ?? "")).statusCode).toBe(400);

      const chatId = await direct(ana, ben);
      const message = await text(ana, chatId, "oops");
      expect((await star(ben, chatId, message.id)).statusCode).toBe(200);
      const removed = await api(ctx, ana, "DELETE", `/chats/${chatId}/messages/${message.id}`);
      expect(removed.statusCode).toBe(200);
      expect((await star(ana, chatId, message.id)).statusCode).toBe(400);
      // Deleting removed every star on it.
      expect(await starred(ben, chatId)).toEqual([]);

      // Another chat's message id.
      const other = await direct(ana, cara);
      const elsewhere = await text(ana, other, "elsewhere");
      expect((await star(ana, chatId, elsewhere.id)).statusCode).toBe(404);
    });

    it("pages starred messages newest first by sequence", async () => {
      const chatId = await direct(ana, ben);
      const sent: MessageBody[] = [];
      for (let i = 0; i < 5; i += 1) sent.push(await text(ana, chatId, `m${i}`));
      for (const message of [sent[0], sent[2], sent[4]]) {
        await star(ana, chatId, message?.id ?? "");
      }
      const first = await api(ctx, ana, "GET", `/chats/${chatId}/starred?limit=2`);
      const page = first.json<{ messages: MessageBody[]; hasMore: boolean }>();
      expect(page.messages.map((m) => m.sequence)).toEqual([5, 3]);
      expect(page.hasMore).toBe(true);
      const rest = await starred(ana, chatId, "?limit=2&before=3");
      expect(rest.map((m) => m.sequence)).toEqual([1]);
    });
  });

  describe("shared content", () => {
    it("lists media and documents separately, newest first, with cursor paging", async () => {
      const chatId = await direct(ana, ben);
      const photo1 = await sendFile(ana, chatId, PNG);
      await text(ana, chatId, "https://example.com");
      const doc = await sendFile(ben, chatId, PDF);
      const photo2 = await sendFile(ben, chatId, PNG);

      const media = await shared(ana, chatId, "kind=media&limit=1");
      expect(media.messages.map((m) => m.id)).toEqual([photo2.id]);
      expect(media.hasMore).toBe(true);
      const next = await shared(ana, chatId, `kind=media&limit=1&before=${photo2.sequence}`);
      expect(next.messages.map((m) => m.id)).toEqual([photo1.id]);
      expect(next.hasMore).toBe(false);

      const docs = await shared(ben, chatId, "kind=docs");
      expect(docs.messages.map((m) => [m.id, m.attachment?.fileName])).toEqual([
        [doc.id, "Report.pdf"],
      ]);
      // Metadata only: never storage keys or URLs.
      expect(JSON.stringify(docs)).not.toMatch(/storage|https?:\/\/(?!example)/i);
    });

    it("leaves out deleted messages and history the member can't see", async () => {
      const groupId = await createGroup(ana, [ben]);
      const early = await sendFile(ana, groupId, PNG);
      const added = await api(ctx, ana, "POST", `/groups/${groupId}/members`, {
        userIds: [cara.user.id],
      });
      expect(added.statusCode, added.body).toBe(200);
      const late = await sendFile(ben, groupId, PNG);
      const gone = await sendFile(ben, groupId, PNG);
      await api(ctx, ben, "DELETE", `/chats/${groupId}/messages/${gone.id}`);

      expect((await shared(cara, groupId, "kind=media")).messages.map((m) => m.id)).toEqual([
        late.id,
      ]);
      expect((await shared(ana, groupId, "kind=media")).messages.map((m) => m.id)).toEqual([
        late.id,
        early.id,
      ]);
    });
  });

  describe("broadcast lists", () => {
    async function createList(owner: TestUser, recipients: TestUser[]): Promise<string> {
      const response = await api(ctx, owner, "POST", "/broadcasts", {
        clientRequestId: randomUUID(),
        name: "Family",
        recipientIds: recipients.map((user) => user.user.id),
      });
      expect(response.statusCode, response.body).toBe(201);
      return response.json<{ list: { id: string } }>().list.id;
    }

    async function broadcastText(owner: TestUser, listId: string, body: string) {
      const response = await api(ctx, owner, "POST", `/broadcasts/${listId}/messages`, {
        clientMessageId: randomUUID(),
        type: "text",
        ciphertext: encodeText(body),
        protocol: "opene2ee-v1",
      });
      expect(response.statusCode, response.body).toBe(201);
      return response.json<{ broadcast: BroadcastBody }>().broadcast;
    }

    async function listHistory(owner: TestUser, listId: string): Promise<BroadcastBody[]> {
      const response = await api(ctx, owner, "GET", `/broadcasts/${listId}/messages`);
      expect(response.statusCode, response.body).toBe(200);
      return response.json<{ broadcasts: BroadcastBody[] }>().broadcasts;
    }

    it("clears only the owner's list view; recipients and direct chats keep everything", async () => {
      const listId = await createList(ana, [ben, cara]);
      await broadcastText(ana, listId, "one");
      const socket = await connect(ana);
      const cleared = nextEvent(socket, "broadcast.list.cleared");
      const response = await api(ctx, ana, "POST", `/broadcasts/${listId}/clear`, {
        keepStarred: false,
      });
      expect(response.statusCode, response.body).toBe(200);
      await cleared;
      socket.terminate();

      expect(await listHistory(ana, listId)).toEqual([]);
      const direct = await openChat(ctx, ana, ben);
      expect(await history(ben, direct)).toHaveLength(1);
      expect(await history(ana, direct)).toHaveLength(1);

      const after = await broadcastText(ana, listId, "two");
      expect((await listHistory(ana, listId)).map((b) => b.id)).toEqual([after.id]);

      // Only the owner can clear it.
      const foreign = await api(ctx, ben, "POST", `/broadcasts/${listId}/clear`, {
        keepStarred: true,
      });
      expect(foreign.statusCode).toBe(404);
    });

    it("stars a broadcast through the owner's delivered copy, once per broadcast", async () => {
      const listId = await createList(ana, [ben, cara]);
      const sent = await broadcastText(ana, listId, "save this");
      const url = `/broadcasts/${listId}/messages/${sent.id}/star`;

      const first = await api(ctx, ana, "PUT", url);
      expect(first.statusCode, first.body).toBe(200);
      expect(first.json<{ broadcast: BroadcastBody }>().broadcast.starred).toBe(true);
      expect((await api(ctx, ana, "PUT", url)).statusCode).toBe(200);
      expect(
        (await pool.query("SELECT 1 FROM starred_messages WHERE user_id = $1", [ana.user.id]))
          .rowCount,
      ).toBe(1);

      // Starring the other copy from the direct chat still lists it once.
      const caraChat = await openChat(ctx, ana, cara);
      const copy = (await history(ana, caraChat))[0];
      await star(ana, caraChat, copy?.id ?? "");
      const list = await api(ctx, ana, "GET", `/broadcasts/${listId}/starred`);
      expect(list.json<{ broadcasts: BroadcastBody[] }>().broadcasts.map((b) => b.id)).toEqual([
        sent.id,
      ]);

      // Recipients can't reach the list's stars.
      expect((await api(ctx, ben, "GET", `/broadcasts/${listId}/starred`)).statusCode).toBe(404);
      expect((await api(ctx, ben, "PUT", url)).statusCode).toBe(404);

      const off = await api(ctx, ana, "DELETE", url);
      expect(off.json<{ broadcast: BroadcastBody }>().broadcast.starred).toBe(false);
      expect(
        (await pool.query("SELECT 1 FROM starred_messages WHERE user_id = $1", [ana.user.id]))
          .rowCount,
      ).toBe(0);
    });

    it("keeps starred broadcasts through a clear when asked", async () => {
      const listId = await createList(ana, [ben]);
      const sent = await broadcastText(ana, listId, "keep");
      await api(ctx, ana, "PUT", `/broadcasts/${listId}/messages/${sent.id}/star`);
      await api(ctx, ana, "POST", `/broadcasts/${listId}/clear`, { keepStarred: true });
      const kept = await api(ctx, ana, "GET", `/broadcasts/${listId}/starred`);
      expect(
        kept.json<{ broadcasts: BroadcastBody[] }>().broadcasts.map((b) => [b.id, b.inHistory]),
      ).toEqual([[sent.id, false]]);
    });

    it("lists the owner's shared files after the clear marker", async () => {
      const listId = await createList(ana, [ben]);
      const uploadId = await upload(ana, PDF);
      const sent = await api(ctx, ana, "POST", `/broadcasts/${listId}/messages`, {
        clientMessageId: randomUUID(),
        type: "document",
        ciphertext: "",
        attachment: { uploadId },
      });
      expect(sent.statusCode, sent.body).toBe(201);
      const docs = await api(ctx, ana, "GET", `/broadcasts/${listId}/shared?kind=docs`);
      expect(
        docs.json<{ broadcasts: BroadcastBody[] }>().broadcasts.map((b) => b.attachment?.uploadId),
      ).toEqual([uploadId]);
      expect(
        (await api(ctx, ana, "GET", `/broadcasts/${listId}/shared?kind=media`)).json<{
          broadcasts: BroadcastBody[];
        }>().broadcasts,
      ).toEqual([]);

      await api(ctx, ana, "POST", `/broadcasts/${listId}/clear`, { keepStarred: true });
      expect(
        (await api(ctx, ana, "GET", `/broadcasts/${listId}/shared?kind=docs`)).json<{
          broadcasts: BroadcastBody[];
        }>().broadcasts,
      ).toEqual([]);
    });
  });

  describe("groups in common", () => {
    async function common(viewer: TestUser, other: TestUser) {
      const response = await api(ctx, viewer, "GET", `/users/${other.user.id}/groups-in-common`);
      expect(response.statusCode, response.body).toBe(200);
      return response.json<{ groups: Record<string, unknown>[] }>().groups;
    }

    it("returns live groups both users are current members of, with minimal fields", async () => {
      const shared1 = await createGroup(ana, [ben, cara], "Zoo trip");
      const shared2 = await createGroup(ben, [ana], "Book club");
      await createGroup(ana, [cara], "Without Ben");
      const left = await createGroup(ana, [ben], "Ben left");
      await api(ctx, ben, "POST", `/groups/${left}/leave`);
      const deleted = await createGroup(ana, [ben], "Deleted");
      await pool.query("UPDATE groups SET deleted_at = NOW() WHERE chat_id = $1", [deleted]);

      const groups = await common(ana, ben);
      expect(groups).toEqual([
        { chatId: shared2, name: "Book club", photoId: null, memberCount: 2 },
        { chatId: shared1, name: "Zoo trip", photoId: null, memberCount: 3 },
      ]);
      expect(await common(ben, ana)).toEqual(groups);
    });

    it("is empty when nothing is shared, and refuses self and unknown users", async () => {
      expect(await common(ana, cara)).toEqual([]);
      expect(
        (await api(ctx, ana, "GET", `/users/${ana.user.id}/groups-in-common`)).statusCode,
      ).toBe(400);
      expect(
        (await api(ctx, ana, "GET", `/users/${randomUUID()}/groups-in-common`)).statusCode,
      ).toBe(404);
      expect((await api(ctx, ana, "GET", `/users/not-a-uuid/groups-in-common`)).statusCode).toBe(
        400,
      );
    });
  });
});
