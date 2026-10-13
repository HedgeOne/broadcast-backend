import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { pool } from "../src/db/client.js";
import { closeConnections, createTestApp, resetState, type TestContext } from "./helpers/auth.js";
import { FakeObjectStorage, SAMPLES } from "./helpers/media.js";
import {
  api,
  createUser,
  encodeText,
  openChat,
  sendText,
  type TestUser,
} from "./helpers/messaging.js";

afterAll(closeConnections);

type Purpose = "attachment" | "profile_photo" | "group_photo" | "broadcast_list_photo";

interface Photo {
  uploadId: string;
  thumbnailUploadId: string;
}

interface FileSpec {
  mimeType: string;
  fileName: string;
  body: Buffer;
}

const JPEG: FileSpec = { mimeType: "image/jpeg", fileName: "photo.jpg", body: SAMPLES.jpeg };
const PNG: FileSpec = { mimeType: "image/png", fileName: "thumb.png", body: SAMPLES.png };

function idsOf(photo: Photo): string[] {
  return [photo.uploadId, photo.thumbnailUploadId];
}

describe("photos", () => {
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
    ana = await createUser(ctx, "ana");
    ben = await createUser(ctx, "ben");
    cara = await createUser(ctx, "cara");
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  function createSession(user: TestUser, purpose: Purpose, file: FileSpec, category = "image") {
    return api(ctx, user, "POST", "/media/uploads", {
      clientUploadId: randomUUID(),
      purpose,
      category,
      mimeType: file.mimeType,
      fileName: file.fileName,
      fileSize: file.body.length,
    });
  }

  async function uploadOne(user: TestUser, purpose: Purpose, file: FileSpec): Promise<string> {
    const session = await createSession(user, purpose, file);
    expect(session.statusCode, session.body).toBe(201);
    const { upload, target } = session.json<{
      upload: { id: string };
      target: { url: string; headers: Record<string, string> };
    }>();
    expect(storage.put(target.url, file.body, target.headers["Content-Type"] ?? "")).toBe(200);
    const done = await api(ctx, user, "POST", `/media/uploads/${upload.id}/complete`);
    expect(done.statusCode, done.body).toBe(200);
    return upload.id;
  }

  // What the app does: the cropped image and its thumbnail, both verified.
  async function uploadPhoto(user: TestUser, purpose: Purpose = "profile_photo"): Promise<Photo> {
    return {
      uploadId: await uploadOne(user, purpose, JPEG),
      thumbnailUploadId: await uploadOne(user, purpose, PNG),
    };
  }

  function setMyPhoto(user: TestUser, photo: Photo) {
    return api(ctx, user, "PUT", "/users/me/photo", { ...photo });
  }

  function photoUrl(user: TestUser, path: string, variant?: "original" | "thumbnail") {
    return api(ctx, user, "GET", `${path}/photo${variant ? `?variant=${variant}` : ""}`);
  }

  async function storageKeyOf(uploadId: string): Promise<string> {
    const result = await pool.query<{ storage_key: string }>(
      "SELECT storage_key FROM media_uploads WHERE id = $1",
      [uploadId],
    );
    return result.rows[0]?.storage_key ?? "";
  }

  async function peerPhotoId(viewer: TestUser, other: TestUser): Promise<string | null> {
    const response = await api(ctx, viewer, "GET", `/users/${other.user.id}`);
    expect(response.statusCode).toBe(200);
    return response.json<{ user: { photoId: string | null } }>().user.photoId;
  }

  // Old photos are swept once they are no longer referenced.
  async function ageUploads(ids: string[]): Promise<void> {
    await pool.query(
      "UPDATE media_uploads SET finalized_at = NOW() - interval '2 days' WHERE id = ANY($1::uuid[])",
      [ids],
    );
  }

  // ---- Upload sessions ----------------------------------------------------

  describe("photo uploads", () => {
    it("stores each kind of photo under its own prefix with an opaque key", async () => {
      for (const [purpose, prefix] of [
        ["profile_photo", "profile-photos/"],
        ["group_photo", "group-photos/"],
        ["broadcast_list_photo", "broadcast-list-photos/"],
        ["attachment", "attachments/"],
      ] as const) {
        const id = await uploadOne(ana, purpose, JPEG);
        const key = await storageKeyOf(id);
        expect(key.startsWith(prefix)).toBe(true);
        expect(key).toMatch(/^[a-z-]+\/[0-9a-f]{32}\/original$/);
        expect(key).not.toContain(ana.user.id);
      }
    });

    it("accepts only JPEG, PNG and WebP images for photos", async () => {
      const gif = { mimeType: "image/gif", fileName: "a.gif", body: Buffer.from("GIF89a....") };
      expect((await createSession(ana, "profile_photo", gif)).statusCode).toBe(415);
      const heic = { mimeType: "image/heic", fileName: "a.heic", body: SAMPLES.mp4 };
      expect((await createSession(ana, "profile_photo", heic)).statusCode).toBe(415);
      const pdf = { mimeType: "application/pdf", fileName: "a.pdf", body: SAMPLES.pdf };
      const asDocument = await createSession(ana, "group_photo", pdf, "document");
      expect(asDocument.statusCode).toBe(422);
      expect(asDocument.json()).toMatchObject({ error: { code: "FILE_TYPE_MISMATCH" } });
    });

    it("limits photos to 5 MB", async () => {
      const big = { ...JPEG, body: Buffer.alloc(5 * 1024 * 1024 + 1) };
      const response = await createSession(ana, "profile_photo", big);
      expect(response.statusCode).toBe(413);
      expect(response.json()).toMatchObject({
        error: { code: "FILE_TOO_LARGE", details: { maxBytes: 5 * 1024 * 1024 } },
      });
    });

    it("rejects content that isn't the declared image", async () => {
      const session = await createSession(ana, "profile_photo", JPEG);
      const { upload, target } = session.json<{
        upload: { id: string };
        target: { url: string };
      }>();
      const fake = SAMPLES.exe.subarray(0, JPEG.body.length);
      storage.plant(new URL(target.url).pathname.slice(1), fake, "image/jpeg");
      const done = await api(ctx, ana, "POST", `/media/uploads/${upload.id}/complete`);
      expect(done.statusCode).toBe(422);
      expect(done.json()).toMatchObject({ error: { code: "UPLOAD_REJECTED" } });
    });

    it("never lets a photo upload be sent as a message attachment", async () => {
      const chatId = await openChat(ctx, ana, ben);
      const photo = await uploadPhoto(ana);
      const response = await api(ctx, ana, "POST", `/chats/${chatId}/messages`, {
        clientMessageId: randomUUID(),
        type: "image",
        ciphertext: encodeText(""),
        attachment: { uploadId: photo.uploadId },
      });
      expect(response.statusCode).toBe(422);
      expect(response.json()).toMatchObject({ error: { code: "ATTACHMENT_INVALID" } });
    });
  });

  // ---- Profile photos ------------------------------------------------------

  describe("profile photo", () => {
    it.each([
      ["PUT", "/users/me/photo"],
      ["DELETE", "/users/me/photo"],
      ["GET", `/users/${randomUUID()}/photo`],
      ["GET", `/groups/${randomUUID()}/photo`],
      ["GET", `/broadcasts/${randomUUID()}/photo`],
      ["GET", "/privacy/settings"],
    ] as const)("rejects %s %s without a session", async (method, url) => {
      expect((await ctx.app.inject({ method, url })).statusCode).toBe(401);
    });

    it("sets the caller's photo and serves it through short-lived URLs", async () => {
      const photo = await uploadPhoto(ana);
      const response = await setMyPhoto(ana, photo);
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({
        user: { id: ana.user.id, photoId: photo.uploadId },
      });

      const thumb = await photoUrl(ben, `/users/${ana.user.id}`);
      expect(thumb.statusCode).toBe(200);
      expect(thumb.headers["cache-control"]).toBe("no-store");
      const { url, expiresAt } = thumb.json<{ url: string; expiresAt: string }>();
      expect(storage.get(url)).toEqual(PNG.body);
      expect(url).toContain("X-Amz-Expires=300");
      expect(new Date(expiresAt).getTime()).toBeGreaterThan(Date.now());

      const original = await photoUrl(ben, `/users/${ana.user.id}`, "original");
      expect(storage.get(original.json<{ url: string }>().url)).toEqual(JPEG.body);

      expect(await peerPhotoId(ben, ana)).toBe(photo.uploadId);
      const me = await ctx.app.inject({
        method: "GET",
        url: "/auth/me",
        headers: { authorization: `Bearer ${ana.accessToken}` },
      });
      expect(me.json()).toMatchObject({ user: { photoId: photo.uploadId } });
    });

    it("refuses another account's uploads, attachments and other kinds of photo", async () => {
      const bens = await uploadPhoto(ben);
      const stolen = await setMyPhoto(ana, bens);
      expect(stolen.statusCode).toBe(422);
      expect(stolen.json()).toMatchObject({ error: { code: "PHOTO_INVALID" } });

      const groupKind = await uploadPhoto(ana, "group_photo");
      expect((await setMyPhoto(ana, groupKind)).statusCode).toBe(422);

      const attachment = {
        uploadId: await uploadOne(ana, "attachment", JPEG),
        thumbnailUploadId: await uploadOne(ana, "attachment", PNG),
      };
      expect((await setMyPhoto(ana, attachment)).statusCode).toBe(422);

      const same = await uploadOne(ana, "profile_photo", JPEG);
      const duplicate = await setMyPhoto(ana, { uploadId: same, thumbnailUploadId: same });
      expect(duplicate.statusCode).toBe(400);

      expect(await peerPhotoId(ben, ana)).toBeNull();
    });

    it("refuses uploads that were never verified or whose session expired", async () => {
      const pending = await createSession(ana, "profile_photo", JPEG);
      const pendingId = pending.json<{ upload: { id: string } }>().upload.id;
      const thumb = await uploadOne(ana, "profile_photo", PNG);
      const notVerified = await setMyPhoto(ana, { uploadId: pendingId, thumbnailUploadId: thumb });
      expect(notVerified.statusCode).toBe(422);

      await pool.query(
        "UPDATE media_uploads SET upload_expires_at = NOW() - interval '1 minute' WHERE id = $1",
        [pendingId],
      );
      const expired = await api(ctx, ana, "POST", `/media/uploads/${pendingId}/complete`);
      expect(expired.statusCode).toBe(410);
      expect(
        (await setMyPhoto(ana, { uploadId: pendingId, thumbnailUploadId: thumb })).statusCode,
      ).toBe(422);

      const missing = await setMyPhoto(ana, { uploadId: randomUUID(), thumbnailUploadId: thumb });
      expect(missing.statusCode).toBe(422);
    });

    it("refuses a thumbnail over 1 MB", async () => {
      const big = { ...JPEG, body: Buffer.concat([SAMPLES.jpeg, Buffer.alloc(1024 * 1024)]) };
      const photo = {
        uploadId: await uploadOne(ana, "profile_photo", JPEG),
        thumbnailUploadId: await uploadOne(ana, "profile_photo", big),
      };
      expect((await setMyPhoto(ana, photo)).statusCode).toBe(422);
    });

    it("treats a retried update as a no-op and never reuses a replaced photo", async () => {
      const first = await uploadPhoto(ana);
      expect((await setMyPhoto(ana, first)).statusCode).toBe(200);
      const retry = await setMyPhoto(ana, first);
      expect(retry.statusCode).toBe(200);
      expect(retry.json()).toMatchObject({ user: { photoId: first.uploadId } });

      const second = await uploadPhoto(ana);
      expect((await setMyPhoto(ana, second)).statusCode).toBe(200);
      const back = await setMyPhoto(ana, first);
      expect(back.statusCode).toBe(422);
      expect(await peerPhotoId(ben, ana)).toBe(second.uploadId);
    });

    it("keeps the current photo when a replacement is refused", async () => {
      const current = await uploadPhoto(ana);
      await setMyPhoto(ana, current);
      const refused = await setMyPhoto(ana, await uploadPhoto(ben));
      expect(refused.statusCode).toBe(422);
      expect(await peerPhotoId(ben, ana)).toBe(current.uploadId);
      expect((await photoUrl(ben, `/users/${ana.user.id}`)).statusCode).toBe(200);
    });

    it("removes the photo; every reader falls back", async () => {
      await setMyPhoto(ana, await uploadPhoto(ana));
      const removed = await api(ctx, ana, "DELETE", "/users/me/photo");
      expect(removed.statusCode).toBe(200);
      expect(removed.json()).toMatchObject({ user: { photoId: null } });
      expect(await peerPhotoId(ben, ana)).toBeNull();
      const gone = await photoUrl(ben, `/users/${ana.user.id}`);
      expect(gone.statusCode).toBe(404);
      expect(gone.json()).toMatchObject({ error: { code: "PHOTO_NOT_FOUND" } });
      expect((await photoUrl(ana, `/users/${ana.user.id}`)).statusCode).toBe(404);
      // Idempotent.
      expect((await api(ctx, ana, "DELETE", "/users/me/photo")).statusCode).toBe(200);
    });

    it("cleans up replaced photos but never the current one", async () => {
      const first = await uploadPhoto(ana);
      await setMyPhoto(ana, first);
      const second = await uploadPhoto(ana);
      await setMyPhoto(ana, second);
      const firstKeys = [
        await storageKeyOf(first.uploadId),
        await storageKeyOf(first.thumbnailUploadId),
      ];
      const secondKeys = [
        await storageKeyOf(second.uploadId),
        await storageKeyOf(second.thumbnailUploadId),
      ];
      await ageUploads([...idsOf(first), ...idsOf(second)]);

      await ctx.app.mediaSweeper.sweep();
      expect(storage.deleted.sort()).toEqual(firstKeys.sort());
      for (const key of secondKeys) expect(storage.objects.has(key)).toBe(true);

      // Running again changes nothing.
      await ctx.app.mediaSweeper.sweep();
      expect(storage.deleted).toHaveLength(2);
      expect((await photoUrl(ben, `/users/${ana.user.id}`)).statusCode).toBe(200);

      await api(ctx, ana, "DELETE", "/users/me/photo");
      await ctx.app.mediaSweeper.sweep();
      expect(storage.deleted.sort()).toEqual([...firstKeys, ...secondKeys].sort());
    });

    it("reconciles orphans under the photo prefixes", async () => {
      storage.plant(
        "profile-photos/0123456789abcdef0123456789abcdef/original",
        JPEG.body,
        "image/jpeg",
      );
      const kept = await uploadPhoto(ana);
      await setMyPhoto(ana, kept);
      const report = await ctx.app.mediaSweeper.reconcileOrphans({ dryRun: true, minAgeMs: -1000 });
      expect(report.orphans).toEqual(["profile-photos/0123456789abcdef0123456789abcdef/original"]);
    });
  });

  // ---- Privacy -------------------------------------------------------------

  describe("privacy", () => {
    it("reads and changes only the visibility options the server enforces", async () => {
      const initial = await api(ctx, ana, "GET", "/privacy/settings");
      expect(initial.json()).toEqual({ settings: { profilePhotoVisibility: "everyone" } });
      for (const value of ["contacts", "contacts_except", "", null]) {
        const refused = await api(ctx, ana, "PATCH", "/privacy/settings", {
          profilePhotoVisibility: value,
        });
        expect(refused.statusCode).toBe(400);
      }
      const changed = await api(ctx, ana, "PATCH", "/privacy/settings", {
        profilePhotoVisibility: "nobody",
      });
      expect(changed.json()).toEqual({ settings: { profilePhotoVisibility: "nobody" } });
    });

    it("hides the photo from everyone else when set to nobody, everywhere", async () => {
      const photo = await uploadPhoto(ana);
      await setMyPhoto(ana, photo);
      const chatId = await openChat(ctx, ben, ana);
      await sendText(ctx, ana, chatId, "hi");
      await api(ctx, ana, "PATCH", "/privacy/settings", { profilePhotoVisibility: "nobody" });

      expect((await photoUrl(ben, `/users/${ana.user.id}`)).statusCode).toBe(404);
      expect(await peerPhotoId(ben, ana)).toBeNull();
      const chats = await api(ctx, ben, "GET", "/chats");
      expect(chats.body).not.toContain(photo.uploadId);
      const matches = await api(ctx, ben, "POST", "/contacts/match", { phoneNumbers: [ana.phone] });
      expect(matches.statusCode, matches.body).toBe(200);
      expect(matches.body).toContain(ana.user.id);
      expect(matches.body).not.toContain(photo.uploadId);

      // The owner still sees their own photo.
      expect((await photoUrl(ana, `/users/${ana.user.id}`)).statusCode).toBe(200);
      const self = await api(ctx, ana, "GET", `/users/${ana.user.id}`);
      expect(self.json()).toMatchObject({ user: { photoId: photo.uploadId } });

      await api(ctx, ana, "PATCH", "/privacy/settings", { profilePhotoVisibility: "everyone" });
      expect((await photoUrl(ben, `/users/${ana.user.id}`)).statusCode).toBe(200);
    });

    it("hides photos in both directions once either user blocks the other", async () => {
      const anas = await uploadPhoto(ana);
      await setMyPhoto(ana, anas);
      const bens = await uploadPhoto(ben);
      await setMyPhoto(ben, bens);

      await api(ctx, ana, "PUT", `/privacy/blocks/${ben.user.id}`);
      expect((await photoUrl(ben, `/users/${ana.user.id}`)).statusCode).toBe(404);
      expect((await photoUrl(ana, `/users/${ben.user.id}`)).statusCode).toBe(404);
      expect(await peerPhotoId(ben, ana)).toBeNull();
      expect(await peerPhotoId(ana, ben)).toBeNull();
      // Unrelated people are unaffected.
      expect((await photoUrl(cara, `/users/${ana.user.id}`)).statusCode).toBe(200);

      await api(ctx, ana, "DELETE", `/privacy/blocks/${ben.user.id}`);
      expect((await photoUrl(ben, `/users/${ana.user.id}`)).statusCode).toBe(200);
    });

    it("hides the photo of an account that is no longer active", async () => {
      await setMyPhoto(ana, await uploadPhoto(ana));
      await pool.query("UPDATE users SET status = 'disabled' WHERE id = $1", [ana.user.id]);
      expect((await photoUrl(ben, `/users/${ana.user.id}`)).statusCode).toBe(404);
    });

    it("applies member photo privacy inside group details", async () => {
      const photo = await uploadPhoto(ana);
      await setMyPhoto(ana, photo);
      const group = await createGroup(ben, [ana, cara]);
      const visible = await api(ctx, cara, "GET", `/groups/${group}`);
      expect(visible.body).toContain(photo.uploadId);
      await api(ctx, ana, "PUT", `/privacy/blocks/${cara.user.id}`);
      const hidden = await api(ctx, cara, "GET", `/groups/${group}`);
      expect(hidden.body).not.toContain(photo.uploadId);
    });
  });

  // ---- Group photos --------------------------------------------------------

  async function createGroup(owner: TestUser, members: TestUser[], photo?: Photo): Promise<string> {
    const response = await api(ctx, owner, "POST", "/groups", {
      clientRequestId: randomUUID(),
      name: "Team",
      memberIds: members.map((member) => member.user.id),
      ...(photo ? { photo } : {}),
    });
    expect(response.statusCode, response.body).toBe(201);
    return response.json<{ chat: { id: string } }>().chat.id;
  }

  async function groupPhotoId(user: TestUser, chatId: string): Promise<string | null> {
    const response = await api(ctx, user, "GET", `/groups/${chatId}`);
    return response.json<{ group: { photoId: string | null } }>().group.photoId;
  }

  describe("group photo", () => {
    it("can be set at creation and is shown to members only", async () => {
      const photo = await uploadPhoto(ana, "group_photo");
      const chatId = await createGroup(ana, [ben], photo);

      const chats = await api(ctx, ben, "GET", "/chats");
      const summary = chats
        .json<{ chats: { id: string; group?: { photoId: string | null } }[] }>()
        .chats.find((chat) => chat.id === chatId);
      expect(summary?.group?.photoId).toBe(photo.uploadId);
      expect(await groupPhotoId(ben, chatId)).toBe(photo.uploadId);

      const url = await photoUrl(ben, `/groups/${chatId}`);
      expect(url.statusCode).toBe(200);
      expect(storage.get(url.json<{ url: string }>().url)).toEqual(PNG.body);
      expect((await photoUrl(cara, `/groups/${chatId}`)).statusCode).toBe(404);
    });

    it("creates nothing when the photo can't be used", async () => {
      const response = await api(ctx, ana, "POST", "/groups", {
        clientRequestId: randomUUID(),
        name: "Team",
        memberIds: [ben.user.id],
        photo: await uploadPhoto(ben, "group_photo"),
      });
      expect(response.statusCode).toBe(422);
      const { rows } = await pool.query("SELECT 1 FROM groups");
      expect(rows).toHaveLength(0);
    });

    it("lets whoever may edit group info change it, announces it once, and removes it", async () => {
      const chatId = await createGroup(ana, [ben, cara]);
      const photo = await uploadPhoto(ben, "group_photo");
      const set = await api(ctx, ben, "PUT", `/groups/${chatId}/photo`, { ...photo });
      expect(set.statusCode, set.body).toBe(200);
      expect(set.json()).toMatchObject({ group: { photoId: photo.uploadId } });
      // A retried request doesn't announce again.
      expect((await api(ctx, ben, "PUT", `/groups/${chatId}/photo`, { ...photo })).statusCode).toBe(
        200,
      );

      const removed = await api(ctx, ana, "DELETE", `/groups/${chatId}/photo`);
      expect(removed.json()).toMatchObject({ group: { photoId: null } });
      expect((await photoUrl(cara, `/groups/${chatId}`)).statusCode).toBe(404);

      const { rows } = await pool.query<{
        event: { kind: string; removed: boolean; actorId: string };
      }>(
        `SELECT system_event AS event FROM messages
         WHERE chat_id = $1 AND system_event->>'kind' = 'photo.changed' ORDER BY sequence`,
        [chatId],
      );
      expect(rows.map((row) => [row.event.actorId, row.event.removed])).toEqual([
        [ben.user.id, false],
        [ana.user.id, true],
      ]);
    });

    it("refuses members when only admins may edit info, and non-members always", async () => {
      const chatId = await createGroup(ana, [ben]);
      await api(ctx, ana, "PATCH", `/groups/${chatId}/settings`, { onlyAdminsCanEditInfo: true });

      const denied = await api(ctx, ben, "PUT", `/groups/${chatId}/photo`, {
        ...(await uploadPhoto(ben, "group_photo")),
      });
      expect(denied.statusCode).toBe(403);
      expect((await api(ctx, ben, "DELETE", `/groups/${chatId}/photo`)).statusCode).toBe(403);

      const outsider = await api(ctx, cara, "PUT", `/groups/${chatId}/photo`, {
        ...(await uploadPhoto(cara, "group_photo")),
      });
      expect(outsider.statusCode).toBe(404);

      await api(ctx, ana, "PUT", `/groups/${chatId}/members/${ben.user.id}/role`, {
        role: "admin",
      });
      const admin = await api(ctx, ben, "PUT", `/groups/${chatId}/photo`, {
        ...(await uploadPhoto(ben, "group_photo")),
      });
      expect(admin.statusCode).toBe(200);
    });

    it("stops serving a former member and releases the photo when the group is deleted", async () => {
      const photo = await uploadPhoto(ana, "group_photo");
      const chatId = await createGroup(ana, [ben, cara], photo);
      await api(ctx, ana, "DELETE", `/groups/${chatId}/members/${cara.user.id}`);
      expect((await photoUrl(cara, `/groups/${chatId}`)).statusCode).toBe(404);

      await api(ctx, ana, "DELETE", `/groups/${chatId}`);
      expect((await photoUrl(ana, `/groups/${chatId}`)).statusCode).toBe(404);
      await ageUploads(idsOf(photo));
      await ctx.app.mediaSweeper.sweep();
      expect(storage.deleted).toContain(await storageKeyOf(photo.uploadId));
    });
  });

  // ---- Broadcast list photos -----------------------------------------------

  async function createList(owner: TestUser, recipients: TestUser[], photo?: Photo) {
    const response = await api(ctx, owner, "POST", "/broadcasts", {
      clientRequestId: randomUUID(),
      name: "Customers",
      recipientIds: recipients.map((recipient) => recipient.user.id),
      ...(photo ? { photo } : {}),
    });
    expect(response.statusCode, response.body).toBe(201);
    return response.json<{ list: { id: string; photoId: string | null } }>().list;
  }

  describe("broadcast list photo", () => {
    it("can be set at creation, changed and removed by the owner", async () => {
      const photo = await uploadPhoto(ana, "broadcast_list_photo");
      const list = await createList(ana, [ben], photo);
      expect(list.photoId).toBe(photo.uploadId);
      const lists = await api(ctx, ana, "GET", "/broadcasts");
      expect(lists.json()).toMatchObject({ lists: [{ id: list.id, photoId: photo.uploadId }] });
      expect((await photoUrl(ana, `/broadcasts/${list.id}`)).statusCode).toBe(200);

      const next = await uploadPhoto(ana, "broadcast_list_photo");
      const changed = await api(ctx, ana, "PUT", `/broadcasts/${list.id}/photo`, { ...next });
      expect(changed.json()).toMatchObject({ list: { photoId: next.uploadId } });

      const removed = await api(ctx, ana, "DELETE", `/broadcasts/${list.id}/photo`);
      expect(removed.json()).toMatchObject({ list: { photoId: null } });
      expect((await photoUrl(ana, `/broadcasts/${list.id}`)).statusCode).toBe(404);
    });

    it("is invisible and unchangeable for anyone but the owner, recipients included", async () => {
      const list = await createList(ana, [ben], await uploadPhoto(ana, "broadcast_list_photo"));
      expect((await photoUrl(ben, `/broadcasts/${list.id}`)).statusCode).toBe(404);
      const change = await api(ctx, ben, "PUT", `/broadcasts/${list.id}/photo`, {
        ...(await uploadPhoto(ben, "broadcast_list_photo")),
      });
      expect(change.statusCode).toBe(404);
      expect((await api(ctx, ben, "DELETE", `/broadcasts/${list.id}/photo`)).statusCode).toBe(404);

      // The recipient's direct chat with the owner never carries it.
      await api(ctx, ana, "POST", `/broadcasts/${list.id}/messages`, {
        clientMessageId: randomUUID(),
        type: "text",
        ciphertext: encodeText("news"),
      });
      const chats = await api(ctx, ben, "GET", "/chats");
      expect(chats.body).not.toContain(list.photoId ?? "none");
    });

    it("refuses a profile photo upload as a list photo", async () => {
      const list = await createList(ana, [ben]);
      const response = await api(ctx, ana, "PUT", `/broadcasts/${list.id}/photo`, {
        ...(await uploadPhoto(ana, "profile_photo")),
      });
      expect(response.statusCode).toBe(422);
    });

    it("releases the photo when the list is deleted", async () => {
      const photo = await uploadPhoto(ana, "broadcast_list_photo");
      const list = await createList(ana, [ben], photo);
      await api(ctx, ana, "DELETE", `/broadcasts/${list.id}`);
      await ageUploads(idsOf(photo));
      await ctx.app.mediaSweeper.sweep();
      expect(storage.deleted).toContain(await storageKeyOf(photo.thumbnailUploadId));
    });
  });
});
