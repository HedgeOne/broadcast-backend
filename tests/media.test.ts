import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { pool } from "../src/db/client.js";
import type { RateLimiter } from "../src/lib/rate-limiter.js";
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
  type TestUser,
} from "./helpers/messaging.js";

afterAll(closeConnections);

const MAX_BYTES = 15 * 1024 * 1024;

interface UploadBody {
  id: string;
  clientUploadId: string;
  category: string;
  mimeType: string;
  fileName: string | null;
  fileSize: number;
  status: string;
  failureCode: string | null;
}

interface TargetBody {
  url: string;
  method: string;
  headers: Record<string, string>;
  expiresAt: string;
}

interface AttachmentBody {
  id: string;
  type: string;
  mimeType: string;
  fileName: string | null;
  fileSize: number | null;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  hasThumbnail: boolean;
}

interface MessageBody {
  id: string;
  chatId: string;
  type: string;
  ciphertext: string;
  attachment: AttachmentBody | null;
  deleted: boolean;
}

interface FileSpec {
  category: "image" | "video" | "audio" | "document";
  mimeType: string;
  fileName: string | null;
  body: Buffer;
  width?: number;
  height?: number;
  durationMs?: number;
}

/** Minimal Tink streaming-AEAD framed ciphertext (header length byte = 40). */
function e2eeBody(minPlain = 32): Buffer {
  const header = Buffer.alloc(40, 0);
  header[0] = 40;
  const segment = Buffer.alloc(Math.max(minPlain, 1) + 16, 7);
  return Buffer.concat([header, segment]);
}

const PNG: FileSpec = {
  category: "image",
  mimeType: "image/png",
  fileName: "photo.png",
  body: e2eeBody(SAMPLES.png.length),
  width: 1,
  height: 1,
};
const PDF: FileSpec = {
  category: "document",
  mimeType: "application/pdf",
  fileName: "Quarterly report.pdf",
  body: e2eeBody(SAMPLES.pdf.length),
};

describe("media", () => {
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
    storage.deleted.length = 0;
    storage.failDeletes = false;
    ana = await createUser(ctx, "ana");
    ben = await createUser(ctx, "ben");
    cara = await createUser(ctx, "cara");
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  function createSession(user: TestUser, file: FileSpec, extra: Record<string, unknown> = {}) {
    return api(ctx, user, "POST", "/media/uploads", {
      clientUploadId: randomUUID(),
      category: file.category,
      mimeType: file.mimeType,
      fileName: file.fileName,
      fileSize: file.body.length,
      contentEncrypted: true,
      ...(file.width ? { width: file.width, height: file.height } : {}),
      ...(file.durationMs !== undefined ? { durationMs: file.durationMs } : {}),
      ...extra,
    });
  }

  // Session, presigned PUT, completion: what the app does for each file.
  async function upload(user: TestUser, file: FileSpec = PNG): Promise<UploadBody> {
    const session = await createSession(user, file);
    expect(session.statusCode, session.body).toBe(201);
    const { upload: created, target } = session.json<{ upload: UploadBody; target: TargetBody }>();
    expect(target.headers["Content-Type"]).toBe("application/octet-stream");
    expect(storage.put(target.url, file.body, target.headers["Content-Type"] ?? "")).toBe(200);
    const done = await api(ctx, user, "POST", `/media/uploads/${created.id}/complete`);
    expect(done.statusCode, done.body).toBe(200);
    return done.json<{ upload: UploadBody }>().upload;
  }

  function sendMedia(
    user: TestUser,
    chatId: string,
    uploadId: string,
    extra: Record<string, unknown> = {},
  ) {
    return api(ctx, user, "POST", `/chats/${chatId}/messages`, {
      clientMessageId: randomUUID(),
      type: "image",
      ciphertext: encodeText("caption"),
      protocol: "opene2ee-v1",
      attachment: { uploadId },
      ...extra,
    });
  }

  function downloadUrl(user: TestUser, attachmentId: string, variant?: string) {
    return api(
      ctx,
      user,
      "GET",
      `/media/attachments/${attachmentId}/url${variant ? `?variant=${variant}` : ""}`,
    );
  }

  async function storageKeyOf(uploadId: string): Promise<string> {
    const result = await pool.query<{ storage_key: string }>(
      "SELECT storage_key FROM media_uploads WHERE id = $1",
      [uploadId],
    );
    return result.rows[0]?.storage_key ?? "";
  }

  async function uploadStatus(
    uploadId: string,
  ): Promise<{ status: string; objectDeleted: boolean }> {
    const result = await pool.query<{ status: string; object_deleted_at: Date | null }>(
      "SELECT status, object_deleted_at FROM media_uploads WHERE id = $1",
      [uploadId],
    );
    const row = result.rows[0];
    return {
      status: row?.status ?? "missing",
      objectDeleted: row !== undefined && row.object_deleted_at !== null,
    };
  }

  // ---- Upload sessions -----------------------------------------------------

  describe("upload sessions", () => {
    it.each([
      ["POST", "/media/uploads"],
      ["POST", `/media/uploads/${randomUUID()}/complete`],
      ["DELETE", `/media/uploads/${randomUUID()}`],
      ["GET", `/media/attachments/${randomUUID()}/url`],
    ] as const)("rejects %s %s without a session", async (method, url) => {
      const response = await ctx.app.inject({ method, url });
      expect(response.statusCode).toBe(401);
    });

    it("issues a presigned PUT for a server-generated key and never exposes the key", async () => {
      const response = await createSession(ana, PNG);
      expect(response.statusCode, response.body).toBe(201);
      const body = response.json<{ upload: UploadBody; target: TargetBody }>();
      expect(body.upload).toMatchObject({
        category: "image",
        mimeType: "image/png",
        fileName: "photo.png",
        fileSize: PNG.body.length,
        status: "pending",
      });
      expect(body.target.method).toBe("PUT");
      expect(body.target.headers).toEqual({ "Content-Type": "application/octet-stream" });
      expect(Date.parse(body.target.expiresAt)).toBeGreaterThan(Date.now());
      expect(response.headers["cache-control"]).toBe("no-store");

      const key = await storageKeyOf(body.upload.id);
      expect(key).toMatch(/^attachments\/[0-9a-f]{32}\/original$/);
      expect(key).not.toContain(ana.user.id);
      expect(key).not.toContain("photo");
      expect(JSON.stringify(body.upload)).not.toContain(key);
    });

    it("accepts exactly 15 MB and refuses anything larger", async () => {
      const big = { ...PDF, body: Buffer.alloc(0) };
      const atLimit = await createSession(ana, big, { fileSize: MAX_BYTES });
      expect(atLimit.statusCode, atLimit.body).toBe(201);

      const over = await createSession(ana, big, { fileSize: MAX_BYTES + 1 });
      expect(over.statusCode).toBe(413);
      expect(over.json()).toMatchObject({ error: { code: "FILE_TOO_LARGE" } });
    });

    it.each([
      ["application/x-msdownload", "setup.exe"],
      ["application/vnd.android.package-archive", "app.apk"],
      ["text/html", "page.html"],
      ["image/svg+xml", "logo.svg"],
      ["application/javascript", "run.js"],
      ["application/x-sh", "run.sh"],
    ])("refuses %s files", async (mimeType, fileName) => {
      const response = await createSession(ana, { ...PDF, mimeType, fileName });
      expect(response.statusCode).toBe(415);
      expect(response.json()).toMatchObject({ error: { code: "UNSUPPORTED_FILE_TYPE" } });
    });

    it("refuses names whose extension doesn't match the type", async () => {
      const disguised = await createSession(ana, { ...PDF, fileName: "invoice.pdf.exe" });
      expect(disguised.statusCode).toBe(422);
      expect(disguised.json()).toMatchObject({ error: { code: "FILE_EXTENSION_MISMATCH" } });

      const noExtension = await createSession(ana, { ...PDF, fileName: "invoice" });
      expect(noExtension.statusCode).toBe(422);
    });

    it("refuses a type that doesn't belong to the category", async () => {
      const response = await createSession(ana, { ...PDF, category: "image" });
      expect(response.statusCode).toBe(422);
      expect(response.json()).toMatchObject({ error: { code: "FILE_TYPE_MISMATCH" } });
    });

    it("strips directories and control characters from file names and bounds their length", async () => {
      const response = await createSession(ana, { ...PDF, fileName: "../../etc/\u0007notes.pdf" });
      expect(response.statusCode, response.body).toBe(201);
      expect(response.json<{ upload: UploadBody }>().upload.fileName).toBe("notes.pdf");

      const tooLong = await createSession(ana, { ...PDF, fileName: `${"a".repeat(1100)}.pdf` });
      expect(tooLong.statusCode).toBe(400);
    });

    it("is idempotent per client upload id and refuses reuse for a different file", async () => {
      const clientUploadId = randomUUID();
      const first = await createSession(ana, PNG, { clientUploadId });
      const retry = await createSession(ana, PNG, { clientUploadId });
      expect(first.statusCode).toBe(201);
      expect(retry.statusCode).toBe(200);
      expect(retry.json<{ upload: UploadBody }>().upload.id).toBe(
        first.json<{ upload: UploadBody }>().upload.id,
      );
      expect(retry.json<{ target: TargetBody | null }>().target).not.toBeNull();

      const other = await createSession(ana, PDF, { clientUploadId });
      expect(other.statusCode).toBe(409);
      expect(other.json()).toMatchObject({ error: { code: "CLIENT_UPLOAD_CONFLICT" } });
    });

    it("rejects spoofed fields", async () => {
      const response = await createSession(ana, PNG, { storageKey: "attachments/x/original" });
      expect(response.statusCode).toBe(400);
    });
  });

  // ---- Completion -------------------------------------------------------------

  describe("completion", () => {
    it("verifies the stored object and is idempotent", async () => {
      const session = await createSession(ana, PNG);
      const { upload: created, target } = session.json<{
        upload: UploadBody;
        target: TargetBody;
      }>();

      const early = await api(ctx, ana, "POST", `/media/uploads/${created.id}/complete`);
      expect(early.statusCode).toBe(409);
      expect(early.json()).toMatchObject({ error: { code: "UPLOAD_INCOMPLETE" } });

      expect(storage.put(target.url, PNG.body, "application/octet-stream")).toBe(200);
      const done = await api(ctx, ana, "POST", `/media/uploads/${created.id}/complete`);
      expect(done.statusCode).toBe(200);
      expect(done.json<{ upload: UploadBody }>().upload).toMatchObject({
        status: "ready",
        fileSize: PNG.body.length,
      });

      const again = await api(ctx, ana, "POST", `/media/uploads/${created.id}/complete`);
      expect(again.statusCode).toBe(200);
      expect(again.json<{ upload: UploadBody }>().upload.status).toBe("ready");

      const retry = await createSession(ana, PNG, { clientUploadId: created.clientUploadId });
      expect(retry.statusCode).toBe(200);
      expect(retry.json<{ target: TargetBody | null }>().target).toBeNull();
    });

    it("refuses ciphertext that is not streaming-AEAD framed and deletes it", async () => {
      const fake = { ...PNG, body: Buffer.alloc(PNG.body.length, 0xff) };
      const session = await createSession(ana, fake);
      const { upload: created, target } = session.json<{
        upload: UploadBody;
        target: TargetBody;
      }>();
      expect(storage.put(target.url, fake.body, "application/octet-stream")).toBe(200);

      const done = await api(ctx, ana, "POST", `/media/uploads/${created.id}/complete`);
      expect(done.statusCode).toBe(422);
      expect(done.json()).toMatchObject({
        error: { code: "UPLOAD_REJECTED", details: { reason: "CONTENT_MISMATCH" } },
      });
      const key = await storageKeyOf(created.id);
      expect(storage.objects.has(key)).toBe(false);
      expect(await uploadStatus(created.id)).toEqual({ status: "failed", objectDeleted: true });

      const again = await api(ctx, ana, "POST", `/media/uploads/${created.id}/complete`);
      expect(again.statusCode).toBe(422);
    });

    it("refuses an object whose size or type differs from the session", async () => {
      const session = await createSession(ana, PNG);
      const { upload: created } = session.json<{ upload: UploadBody }>();
      const key = await storageKeyOf(created.id);
      storage.plant(key, Buffer.concat([PNG.body, Buffer.alloc(10)]), "application/octet-stream");
      const bigger = await api(ctx, ana, "POST", `/media/uploads/${created.id}/complete`);
      expect(bigger.json()).toMatchObject({ error: { details: { reason: "SIZE_MISMATCH" } } });

      const second = await createSession(ana, PNG);
      const { upload: other } = second.json<{ upload: UploadBody }>();
      storage.plant(await storageKeyOf(other.id), PNG.body, "text/html");
      const retyped = await api(ctx, ana, "POST", `/media/uploads/${other.id}/complete`);
      expect(retyped.json()).toMatchObject({ error: { details: { reason: "TYPE_MISMATCH" } } });
    });

    it("rejects message attachment sessions that omit contentEncrypted", async () => {
      const response = await api(ctx, ana, "POST", "/media/uploads", {
        clientUploadId: randomUUID(),
        category: "image",
        mimeType: "image/png",
        fileName: "photo.png",
        fileSize: 64,
        width: 1,
        height: 1,
      });
      expect(response.statusCode).toBe(400);
    });

    it("presigned PUTs only accept the signed size and type", async () => {
      const session = await createSession(ana, PNG);
      const { target } = session.json<{ target: TargetBody }>();
      expect(
        storage.put(
          target.url,
          Buffer.concat([PNG.body, Buffer.alloc(1)]),
          "application/octet-stream",
        ),
      ).toBe(403);
      expect(storage.put(target.url, PNG.body, "text/html")).toBe(403);
    });

    it("keeps other people's uploads invisible", async () => {
      const mine = await upload(ana);
      for (const [method, url] of [
        ["GET", `/media/uploads/${mine.id}`],
        ["POST", `/media/uploads/${mine.id}/complete`],
        ["DELETE", `/media/uploads/${mine.id}`],
        ["GET", `/media/uploads/${mine.id}/url`],
      ] as const) {
        const response = await api(ctx, ben, method, url);
        expect(response.statusCode, `${method} ${url}`).toBe(404);
      }
    });

    it("lets the owner discard an unsent upload and removes its object", async () => {
      const ready = await upload(ana);
      const key = await storageKeyOf(ready.id);
      const response = await api(ctx, ana, "DELETE", `/media/uploads/${ready.id}`);
      expect(response.statusCode).toBe(204);
      expect(storage.objects.has(key)).toBe(false);
      expect(await uploadStatus(ready.id)).toEqual({ status: "deleted", objectDeleted: true });
      expect((await api(ctx, ana, "GET", `/media/uploads/${ready.id}`)).statusCode).toBe(404);
    });
  });

  // ---- Media messages ---------------------------------------------------------

  describe("media messages", () => {
    it("sends an image with a caption; events and responses carry metadata, never URLs", async () => {
      const chatId = await openChat(ctx, ana, ben);
      const ready = await upload(ana);
      const socket = await ctx.app.injectWS("/ws", { headers: bearer(ben.accessToken) });
      try {
        const event = nextEvent<{ message: MessageBody }>(socket, "message.new");
        const response = await sendMedia(ana, chatId, ready.id);
        expect(response.statusCode, response.body).toBe(201);
        const message = response.json<{ message: MessageBody }>().message;
        expect(message.type).toBe("image");
        expect(message.attachment).toMatchObject({
          type: "image",
          mimeType: "image/png",
          fileName: "photo.png",
          fileSize: PNG.body.length,
          width: 1,
          height: 1,
          hasThumbnail: false,
        });

        const received = (await event).message;
        expect(received.attachment?.id).toBe(message.attachment?.id);
        const key = await storageKeyOf(ready.id);
        for (const payload of [response.body, JSON.stringify(received)]) {
          expect(payload).not.toContain("https://");
          expect(payload).not.toContain(key);
        }
      } finally {
        socket.terminate();
      }

      const history = await api(ctx, ben, "GET", `/chats/${chatId}/messages`);
      const [listed] = history.json<{ messages: MessageBody[] }>().messages;
      expect(listed?.attachment?.mimeType).toBe("image/png");

      // Chat list previews name the kind of media from the type.
      const chats = await api(ctx, ben, "GET", "/chats");
      const [summary] = chats.json<{ chats: { lastMessage: MessageBody }[] }>().chats;
      expect(summary?.lastMessage.type).toBe("image");
    });

    it("allows an empty caption and requires an attachment for media types", async () => {
      const chatId = await openChat(ctx, ana, ben);
      const ready = await upload(ana);
      const empty = await sendMedia(ana, chatId, ready.id, { ciphertext: encodeText("") });
      expect(empty.statusCode, empty.body).toBe(201);

      const missing = await api(ctx, ana, "POST", `/chats/${chatId}/messages`, {
        clientMessageId: randomUUID(),
        type: "image",
        ciphertext: encodeText(""),
        protocol: "opene2ee-v1",
      });
      expect(missing.statusCode).toBe(400);

      const textWithFile = await sendMedia(ana, chatId, ready.id, { type: "text" });
      expect(textWithFile.statusCode).toBe(400);
      const emptyText = await api(ctx, ana, "POST", `/chats/${chatId}/messages`, {
        clientMessageId: randomUUID(),
        type: "text",
        ciphertext: "",
        protocol: "opene2ee-v1",
      });
      expect(emptyText.statusCode).toBe(400);
    });

    it("refuses uploads that aren't the sender's, aren't verified, or don't match the type", async () => {
      const chatId = await openChat(ctx, ana, ben);
      const bens = await upload(ben);
      const notMine = await sendMedia(ana, chatId, bens.id);
      expect(notMine.statusCode).toBe(422);
      expect(notMine.json()).toMatchObject({ error: { code: "ATTACHMENT_INVALID" } });

      const pending = (await createSession(ana, PNG)).json<{ upload: UploadBody }>().upload;
      expect((await sendMedia(ana, chatId, pending.id)).statusCode).toBe(422);

      const doc = await upload(ana, PDF);
      expect((await sendMedia(ana, chatId, doc.id)).statusCode).toBe(422);
      const asDocument = await sendMedia(ana, chatId, doc.id, { type: "document" });
      expect(asDocument.statusCode, asDocument.body).toBe(201);

      const discarded = await upload(ana);
      await api(ctx, ana, "DELETE", `/media/uploads/${discarded.id}`);
      expect((await sendMedia(ana, chatId, discarded.id)).statusCode).toBe(422);

      // Nothing was written for the refused sends.
      const history = await api(ctx, ben, "GET", `/chats/${chatId}/messages`);
      expect(history.json<{ messages: unknown[] }>().messages).toHaveLength(1);
    });

    it("refuses discarding an upload a message already uses", async () => {
      const chatId = await openChat(ctx, ana, ben);
      const ready = await upload(ana);
      await sendMedia(ana, chatId, ready.id);
      const response = await api(ctx, ana, "DELETE", `/media/uploads/${ready.id}`);
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ error: { code: "UPLOAD_IN_USE" } });
    });

    it("is idempotent per client message id", async () => {
      const chatId = await openChat(ctx, ana, ben);
      const ready = await upload(ana);
      const clientMessageId = randomUUID();
      const first = await sendMedia(ana, chatId, ready.id, { clientMessageId });
      const retry = await sendMedia(ana, chatId, ready.id, { clientMessageId });
      expect(first.statusCode).toBe(201);
      expect(retry.statusCode).toBe(200);
      expect(retry.json<{ message: MessageBody }>().message.attachment?.id).toBe(
        first.json<{ message: MessageBody }>().message.attachment?.id,
      );
      const rows = await pool.query("SELECT 1 FROM message_attachments");
      expect(rows.rowCount).toBe(1);
    });

    it("attaches a video thumbnail and serves it as its own variant", async () => {
      const chatId = await openChat(ctx, ana, ben);
      const videoBody = e2eeBody(SAMPLES.mp4.length);
      const posterBody = e2eeBody(SAMPLES.jpeg.length);
      const video = await upload(ana, {
        category: "video",
        mimeType: "video/mp4",
        fileName: "clip.mp4",
        body: videoBody,
        width: 640,
        height: 360,
        durationMs: 4200,
      });
      const poster = await upload(ana, {
        ...PNG,
        mimeType: "image/jpeg",
        fileName: "poster.jpg",
        body: posterBody,
      });
      const response = await sendMedia(ana, chatId, video.id, {
        type: "video",
        attachment: { uploadId: video.id, thumbnailUploadId: poster.id },
      });
      expect(response.statusCode, response.body).toBe(201);
      const attachment = response.json<{ message: MessageBody }>().message.attachment;
      expect(attachment).toMatchObject({ type: "video", durationMs: 4200, hasThumbnail: true });

      const thumb = await downloadUrl(ben, attachment?.id ?? "", "thumbnail");
      expect(thumb.statusCode).toBe(200);
      expect(storage.get(thumb.json<{ url: string }>().url)).toEqual(posterBody);

      const original = await downloadUrl(ben, attachment?.id ?? "");
      expect(storage.get(original.json<{ url: string }>().url)).toEqual(videoBody);
    });

    it("refuses a thumbnail that isn't a small image of the sender's", async () => {
      const chatId = await openChat(ctx, ana, ben);
      const video = await upload(ana, {
        category: "video",
        mimeType: "video/mp4",
        fileName: "clip.mp4",
        body: e2eeBody(SAMPLES.mp4.length),
      });
      const doc = await upload(ana, PDF);
      const response = await sendMedia(ana, chatId, video.id, {
        type: "video",
        attachment: { uploadId: video.id, thumbnailUploadId: doc.id },
      });
      expect(response.statusCode).toBe(422);
    });
  });

  // ---- Download authorization -------------------------------------------------

  describe("downloads", () => {
    it("gives chat members a short-lived URL to the right object", async () => {
      const chatId = await openChat(ctx, ana, ben);
      const ready = await upload(ana);
      const sent = await sendMedia(ana, chatId, ready.id);
      const attachmentId = sent.json<{ message: MessageBody }>().message.attachment?.id ?? "";

      for (const user of [ana, ben]) {
        const response = await downloadUrl(user, attachmentId);
        expect(response.statusCode).toBe(200);
        expect(response.headers["cache-control"]).toBe("no-store");
        const body = response.json<{ url: string; expiresAt: string }>();
        expect(storage.get(body.url)).toEqual(PNG.body);
        const ttl = Date.parse(body.expiresAt) - Date.now();
        expect(ttl).toBeGreaterThan(0);
        expect(ttl).toBeLessThanOrEqual(300_000);
      }
    });

    it("refuses outsiders, deleted messages and missing variants the same way", async () => {
      const chatId = await openChat(ctx, ana, ben);
      const ready = await upload(ana);
      const sent = await sendMedia(ana, chatId, ready.id);
      const message = sent.json<{ message: MessageBody }>().message;
      const attachmentId = message.attachment?.id ?? "";

      expect((await downloadUrl(cara, attachmentId)).statusCode).toBe(404);
      expect((await downloadUrl(ben, randomUUID())).statusCode).toBe(404);
      expect((await downloadUrl(ben, attachmentId, "thumbnail")).statusCode).toBe(404);
      expect((await downloadUrl(ben, attachmentId, "raw")).statusCode).toBe(400);

      const deleted = await api(ctx, ana, "DELETE", `/chats/${chatId}/messages/${message.id}`);
      expect(deleted.statusCode).toBe(200);
      expect(deleted.json<{ message: MessageBody }>().message.attachment).toBeNull();
      expect((await downloadUrl(ben, attachmentId)).statusCode).toBe(404);
      expect((await downloadUrl(ana, attachmentId)).statusCode).toBe(404);
    });

    it("denies removed group members and members who joined after the message", async () => {
      const group = await api(ctx, ana, "POST", "/groups", {
        clientRequestId: randomUUID(),
        name: "Trip",
        memberIds: [ben.user.id],
      });
      expect(group.statusCode, group.body).toBe(201);
      const chatId = group.json<{ chat: { id: string } }>().chat.id;
      const ready = await upload(ana);
      const sent = await sendMedia(ana, chatId, ready.id);
      expect(sent.statusCode, sent.body).toBe(201);
      const attachmentId = sent.json<{ message: MessageBody }>().message.attachment?.id ?? "";

      expect((await downloadUrl(ben, attachmentId)).statusCode).toBe(200);

      const added = await api(ctx, ana, "POST", `/groups/${chatId}/members`, {
        userIds: [cara.user.id],
      });
      expect(added.statusCode, added.body).toBe(200);
      expect((await downloadUrl(cara, attachmentId)).statusCode).toBe(404);

      const removed = await api(ctx, ana, "DELETE", `/groups/${chatId}/members/${ben.user.id}`);
      expect(removed.statusCode, removed.body).toBe(200);
      expect((await downloadUrl(ben, attachmentId)).statusCode).toBe(404);
    });
  });

  // ---- Broadcasts ---------------------------------------------------------------

  describe("broadcasts", () => {
    async function createList(owner: TestUser, recipients: TestUser[]): Promise<string> {
      const response = await api(ctx, owner, "POST", "/broadcasts", {
        clientRequestId: randomUUID(),
        name: "Family",
        recipientIds: recipients.map((user) => user.user.id),
      });
      expect(response.statusCode, response.body).toBe(201);
      return response.json<{ list: { id: string } }>().list.id;
    }

    it("stores one object and gives each recipient their own authorized attachment", async () => {
      const listId = await createList(ana, [ben, cara]);
      const ready = await upload(ana, PDF);
      const response = await api(ctx, ana, "POST", `/broadcasts/${listId}/messages`, {
        clientMessageId: randomUUID(),
        type: "document",
        ciphertext: encodeText(""),
        protocol: "opene2ee-v1",
        attachment: { uploadId: ready.id },
      });
      expect(response.statusCode, response.body).toBe(201);
      const broadcast = response.json<{
        broadcast: { state: string; attachment: { uploadId: string; available: boolean } };
      }>().broadcast;
      expect(broadcast.state).toBe("completed");
      expect(broadcast.attachment).toMatchObject({ uploadId: ready.id, available: true });

      const rows = await pool.query<{ id: string; storage_key: string; recipient: string }>(`
        SELECT a.id, a.storage_key, r.recipient_id AS recipient
        FROM message_attachments a
        JOIN broadcast_message_recipients r ON r.message_id = a.message_id
      `);
      expect(rows.rows).toHaveLength(2);
      expect(new Set(rows.rows.map((row) => row.storage_key)).size).toBe(1);
      expect(storage.objects.size).toBe(1);

      const bens = rows.rows.find((row) => row.recipient === ben.user.id)?.id ?? "";
      const caras = rows.rows.find((row) => row.recipient === cara.user.id)?.id ?? "";
      expect((await downloadUrl(ben, bens)).statusCode).toBe(200);
      expect((await downloadUrl(cara, caras)).statusCode).toBe(200);
      // Each recipient is authorized only through their own message.
      expect((await downloadUrl(ben, caras)).statusCode).toBe(404);
      expect((await downloadUrl(cara, bens)).statusCode).toBe(404);

      // The owner reaches the file through their upload.
      const own = await api(ctx, ana, "GET", `/media/uploads/${ready.id}/url`);
      expect(own.statusCode).toBe(200);
      expect(storage.get(own.json<{ url: string }>().url)).toEqual(PDF.body);
    });

    it("refuses another user's upload", async () => {
      const listId = await createList(ana, [ben]);
      const bens = await upload(ben);
      const response = await api(ctx, ana, "POST", `/broadcasts/${listId}/messages`, {
        clientMessageId: randomUUID(),
        type: "image",
        ciphertext: encodeText("x"),
        protocol: "opene2ee-v1",
        attachment: { uploadId: bens.id },
      });
      expect(response.statusCode).toBe(422);
    });
  });

  // ---- Cleanup ----------------------------------------------------------------

  describe("cleanup", () => {
    it("deletes abandoned sessions and uploads never sent", async () => {
      const abandoned = (await createSession(ana, PNG)).json<{
        upload: UploadBody;
        target: TargetBody;
      }>();
      storage.put(abandoned.target.url, PNG.body, "application/octet-stream");
      const unsent = await upload(ana);
      const fresh = await upload(ana);

      await pool.query(
        "UPDATE media_uploads SET upload_expires_at = NOW() - interval '2 hours' WHERE id = $1",
        [abandoned.upload.id],
      );
      await pool.query(
        "UPDATE media_uploads SET finalized_at = NOW() - interval '2 days' WHERE id = $1",
        [unsent.id],
      );

      const result = await ctx.app.mediaSweeper.sweep();
      expect(result.expired).toBe(2);
      expect(await uploadStatus(abandoned.upload.id)).toEqual({
        status: "deleted",
        objectDeleted: true,
      });
      expect(await uploadStatus(unsent.id)).toEqual({ status: "deleted", objectDeleted: true });
      expect(await uploadStatus(fresh.id)).toEqual({ status: "ready", objectDeleted: false });
      expect(storage.objects.has(await storageKeyOf(fresh.id))).toBe(true);
    });

    it("deletes a file once every message using it is deleted", async () => {
      const listId = await (async () => {
        const response = await api(ctx, ana, "POST", "/broadcasts", {
          clientRequestId: randomUUID(),
          name: "Pair",
          recipientIds: [ben.user.id, cara.user.id],
        });
        return response.json<{ list: { id: string } }>().list.id;
      })();
      const ready = await upload(ana);
      const broadcasted = await api(ctx, ana, "POST", `/broadcasts/${listId}/messages`, {
        clientMessageId: randomUUID(),
        type: "image",
        ciphertext: encodeText(""),
        protocol: "opene2ee-v1",
        attachment: { uploadId: ready.id },
      });
      expect(broadcasted.statusCode, broadcasted.body).toBe(201);
      const sent = await pool.query<{ message_id: string; target_chat_id: string }>(
        "SELECT message_id, target_chat_id FROM broadcast_message_recipients ORDER BY recipient_id",
      );
      const [first, second] = sent.rows;

      await api(
        ctx,
        ana,
        "DELETE",
        `/chats/${first?.target_chat_id}/messages/${first?.message_id}`,
      );
      await ctx.app.mediaSweeper.sweep();
      expect(await uploadStatus(ready.id)).toEqual({ status: "ready", objectDeleted: false });

      await api(
        ctx,
        ana,
        "DELETE",
        `/chats/${second?.target_chat_id}/messages/${second?.message_id}`,
      );
      const result = await ctx.app.mediaSweeper.sweep();
      expect(result.expired).toBe(1);
      expect(await uploadStatus(ready.id)).toEqual({ status: "deleted", objectDeleted: true });
      expect(storage.objects.size).toBe(0);
    });

    it("retries object deletion after a storage failure", async () => {
      const ready = await upload(ana);
      storage.failDeletes = true;
      const discarded = await api(ctx, ana, "DELETE", `/media/uploads/${ready.id}`);
      expect(discarded.statusCode).toBe(204);
      expect(await uploadStatus(ready.id)).toEqual({ status: "deleted", objectDeleted: false });

      const failed = await ctx.app.mediaSweeper.sweep();
      expect(failed.objectDeleteFailures).toBe(1);

      storage.failDeletes = false;
      const retried = await ctx.app.mediaSweeper.sweep();
      expect(retried.objectsDeleted).toBe(1);
      expect(await uploadStatus(ready.id)).toEqual({ status: "deleted", objectDeleted: true });
    });

    it("finds objects no upload owns", async () => {
      const ready = await upload(ana);
      storage.plant("attachments/orphan/original", PNG.body, "image/png");
      const report = await ctx.app.mediaSweeper.reconcileOrphans({ dryRun: true, minAgeMs: -1000 });
      expect(report.orphans).toEqual(["attachments/orphan/original"]);
      expect(storage.objects.has("attachments/orphan/original")).toBe(true);

      await ctx.app.mediaSweeper.reconcileOrphans({ dryRun: false, minAgeMs: -1000 });
      expect(storage.objects.has("attachments/orphan/original")).toBe(false);
      expect(storage.objects.has(await storageKeyOf(ready.id))).toBe(true);
    });
  });
});

// Limits and configuration that need their own app.
describe("media limits", () => {
  let ctx: TestContext;
  let user: TestUser;
  const counts = new Map<string, number>();
  const limiter: RateLimiter = {
    consume(key, limit) {
      const count = (counts.get(key) ?? 0) + 1;
      counts.set(key, count);
      // Tight limits for media keys so the tests can reach them.
      const tight = key.startsWith("media:create:burst") || key.startsWith("media:url") ? 2 : limit;
      return Promise.resolve({ allowed: count <= tight, retryAfterSeconds: 30 });
    },
  };

  beforeAll(async () => {
    ctx = await createTestApp({
      chats: { storage: new FakeObjectStorage(), rateLimiter: limiter },
    });
  });

  beforeEach(async () => {
    await resetState();
    counts.clear();
    user = await createUser(ctx, "lim");
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  it("rate limits upload session creation", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      const response = await api(ctx, user, "POST", "/media/uploads", {
        clientUploadId: randomUUID(),
        category: "image",
        mimeType: "image/png",
        fileName: "a.png",
        fileSize: 64,
        contentEncrypted: true,
        width: 1,
        height: 1,
      });
      statuses.push(response.statusCode);
    }
    expect(statuses).toEqual([201, 201, 429]);
  });

  it("rate limits download URLs", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      statuses.push(
        (await api(ctx, user, "GET", `/media/attachments/${randomUUID()}/url`)).statusCode,
      );
    }
    expect(statuses).toEqual([404, 404, 429]);
  });
});

describe("media without a bucket", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp({ chats: { storage: null } });
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  it("answers 503 instead of failing", async () => {
    await resetState();
    const user = await createUser(ctx, "nobucket");
    const response = await api(ctx, user, "POST", "/media/uploads", {
      clientUploadId: randomUUID(),
      category: "image",
      mimeType: "image/png",
      fileName: "a.png",
      fileSize: 64,
      contentEncrypted: true,
      width: 1,
      height: 1,
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: { code: "MEDIA_UNAVAILABLE" } });
  });
});
