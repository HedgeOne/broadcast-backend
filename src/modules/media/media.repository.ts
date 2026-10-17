import { and, eq, inArray, sql, type SQL } from "drizzle-orm";

import type { Database } from "../../db/client.js";
import {
  mediaUploads,
  messageAttachments,
  type MediaUpload,
  type MessageAttachment,
  type NewMediaUpload,
} from "../../db/schema/index.js";
import type { Executor, Tx } from "../chats/chat-tx.js";
import { mediaErrors } from "./media.errors.js";
import { PHOTO_MIME_TYPES, type MediaCategory, type PhotoPurpose } from "./media.policy.js";

const THUMBNAIL_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
export const THUMBNAIL_MAX_BYTES = 1024 * 1024;

// An attachment with what's needed to authorize and serve a download.
export interface AttachmentAccess {
  attachment: MessageAttachment;
  chatId: string;
  sequence: number;
  messageDeleted: boolean;
  // The reader starred the message (a star kept through Clear Chat).
  starred: boolean;
  thumbnailMimeType: string | null;
}

export interface ClaimedMedia {
  upload: MediaUpload;
  thumbnail: MediaUpload | null;
}

// Locks the sender's verified upload (and optional thumbnail) for use in a
// message being written in `tx`. Cleanup locks the same rows before
// deleting, so an upload is either claimed or deleted, never both.
export async function claimMedia(
  tx: Tx,
  ownerId: string,
  input: {
    uploadId: string;
    thumbnailUploadId?: string | null | undefined;
    category: MediaCategory;
  },
): Promise<ClaimedMedia> {
  const ids = [input.uploadId, ...(input.thumbnailUploadId ? [input.thumbnailUploadId] : [])];
  if (new Set(ids).size !== ids.length) throw mediaErrors.attachmentInvalid();

  // Photo uploads can never be sent as messages.
  const rows = await tx
    .select()
    .from(mediaUploads)
    .where(
      and(
        inArray(mediaUploads.id, ids),
        eq(mediaUploads.ownerId, ownerId),
        eq(mediaUploads.purpose, "attachment"),
      ),
    )
    .orderBy(mediaUploads.id)
    .for("update");
  const upload = rows.find((row) => row.id === input.uploadId);
  if (!upload || upload.status !== "ready" || upload.category !== input.category) {
    throw mediaErrors.attachmentInvalid();
  }

  let thumbnail: MediaUpload | null = null;
  if (input.thumbnailUploadId) {
    thumbnail = rows.find((row) => row.id === input.thumbnailUploadId) ?? null;
    if (
      !thumbnail ||
      thumbnail.status !== "ready" ||
      thumbnail.category !== "image" ||
      !THUMBNAIL_TYPES.has(thumbnail.mimeType) ||
      (thumbnail.fileSize ?? 0) > THUMBNAIL_MAX_BYTES
    ) {
      throw mediaErrors.attachmentInvalid();
    }
  }

  await tx
    .update(mediaUploads)
    .set({ attachedAt: sql`COALESCE(${mediaUploads.attachedAt}, NOW())` })
    .where(inArray(mediaUploads.id, ids));
  return { upload, thumbnail };
}

export interface ClaimedPhoto {
  upload: MediaUpload;
  thumbnail: MediaUpload;
}

// Locks the caller's verified photo and thumbnail, made for `purpose`, for
// use as a profile, group or list photo in `tx`. Each photo upload is used
// once: one that was ever attached (to this or anything else) is refused,
// so two rows never share an object and replacing a photo leaves the old
// upload unreferenced for cleanup. The caller makes setting the current
// photo again a no-op before claiming.
export async function claimPhoto(
  tx: Tx,
  ownerId: string,
  purpose: PhotoPurpose,
  ref: { uploadId: string; thumbnailUploadId: string },
): Promise<ClaimedPhoto> {
  if (ref.uploadId === ref.thumbnailUploadId) throw mediaErrors.photoInvalid();
  const rows = await tx
    .select()
    .from(mediaUploads)
    .where(
      and(
        inArray(mediaUploads.id, [ref.uploadId, ref.thumbnailUploadId]),
        eq(mediaUploads.ownerId, ownerId),
        eq(mediaUploads.purpose, purpose),
      ),
    )
    .orderBy(mediaUploads.id)
    .for("update");
  const upload = rows.find((row) => row.id === ref.uploadId);
  const thumbnail = rows.find((row) => row.id === ref.thumbnailUploadId);
  const usable = (row: MediaUpload | undefined): row is MediaUpload =>
    row !== undefined &&
    row.status === "ready" &&
    row.attachedAt === null &&
    row.category === "image" &&
    PHOTO_MIME_TYPES.includes(row.mimeType);
  if (!usable(upload) || !usable(thumbnail) || (thumbnail.fileSize ?? 0) > THUMBNAIL_MAX_BYTES) {
    throw mediaErrors.photoInvalid();
  }

  await tx
    .update(mediaUploads)
    .set({ attachedAt: sql`NOW()` })
    .where(inArray(mediaUploads.id, [upload.id, thumbnail.id]));
  return { upload, thumbnail };
}

// A broadcast's shared upload, read under a share lock (cleanup takes an
// exclusive lock before deleting). Undefined when it is no longer
// verified; a missing thumbnail only drops the preview.
export async function sharedMedia(
  tx: Tx,
  uploadId: string,
  thumbnailUploadId: string | null,
): Promise<ClaimedMedia | undefined> {
  const ids = [uploadId, ...(thumbnailUploadId ? [thumbnailUploadId] : [])];
  const rows = await tx
    .select()
    .from(mediaUploads)
    .where(inArray(mediaUploads.id, ids))
    .orderBy(mediaUploads.id)
    .for("share");
  const upload = rows.find((row) => row.id === uploadId);
  if (!upload || upload.status !== "ready") return undefined;
  const thumbnail = rows.find((row) => row.id === thumbnailUploadId && row.status === "ready");
  return { upload, thumbnail: thumbnail ?? null };
}

// Marker only — never file keys. Keys stay inside the OpenE2EE envelope.
const E2EE_FILE_MARKER = Buffer.from(JSON.stringify({ v: 1, alg: "aes256-gcm-hkdf-1mb" }), "utf8");

// The message's attachment row, copying the verified upload metadata.
export async function insertAttachment(
  tx: Tx,
  messageId: string,
  media: ClaimedMedia,
): Promise<MessageAttachment> {
  const { upload, thumbnail } = media;
  const [attachment] = await tx
    .insert(messageAttachments)
    .values({
      messageId,
      type: upload.category,
      storageKey: upload.storageKey,
      mimeType: upload.mimeType,
      fileName: upload.fileName,
      fileSize: upload.fileSize,
      width: upload.width,
      height: upload.height,
      durationMs: upload.durationMs,
      thumbnailStorageKey: thumbnail?.storageKey ?? null,
      encryptionMetadata: upload.contentEncrypted ? E2EE_FILE_MARKER : null,
      uploadId: upload.id,
      thumbnailUploadId: thumbnail?.id ?? null,
    })
    .returning();
  if (!attachment) throw new Error("attachment insert returned no row");
  return attachment;
}

export async function attachmentsFor(
  executor: Executor,
  messageIds: string[],
): Promise<Map<string, MessageAttachment>> {
  if (messageIds.length === 0) return new Map();
  const rows = await executor
    .select()
    .from(messageAttachments)
    .where(inArray(messageAttachments.messageId, messageIds));
  return new Map(rows.map((row) => [row.messageId, row]));
}

// An upload is in use while a message's attachment points at it, a
// broadcast still has recipients that may yet receive it, or it is the
// current photo of a user, group or broadcast list. Photos of deleted
// groups and lists are cleared when they are deleted.
const referenced = (id: SQL) => sql`(
  EXISTS (
    SELECT 1 FROM message_attachments a
    WHERE a.upload_id = ${id} OR a.thumbnail_upload_id = ${id}
  ) OR EXISTS (
    SELECT 1 FROM users p
    WHERE p.photo_upload_id = ${id} OR p.photo_thumbnail_upload_id = ${id}
  ) OR EXISTS (
    SELECT 1 FROM groups g
    WHERE g.photo_upload_id = ${id} OR g.photo_thumbnail_upload_id = ${id}
  ) OR EXISTS (
    SELECT 1 FROM broadcast_lists l
    WHERE l.photo_upload_id = ${id} OR l.photo_thumbnail_upload_id = ${id}
  ) OR EXISTS (
    SELECT 1 FROM broadcast_messages bm
    JOIN broadcast_message_recipients r ON r.broadcast_message_id = bm.id
    WHERE (bm.attachment_upload_id = ${id} OR bm.thumbnail_upload_id = ${id})
      AND (r.status = 'pending' OR (r.status = 'failed' AND r.retryable))
  )
)`;

export class MediaRepository {
  constructor(private readonly db: Database) {}

  transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.db.transaction(fn);
  }

  async findByClientId(ownerId: string, clientUploadId: string): Promise<MediaUpload | undefined> {
    const [row] = await this.db
      .select()
      .from(mediaUploads)
      .where(
        and(eq(mediaUploads.ownerId, ownerId), eq(mediaUploads.clientUploadId, clientUploadId)),
      );
    return row;
  }

  async findOwned(ownerId: string, id: string): Promise<MediaUpload | undefined> {
    const [row] = await this.db
      .select()
      .from(mediaUploads)
      .where(and(eq(mediaUploads.id, id), eq(mediaUploads.ownerId, ownerId)));
    return row;
  }

  async findById(id: string): Promise<MediaUpload | undefined> {
    const [row] = await this.db.select().from(mediaUploads).where(eq(mediaUploads.id, id));
    return row;
  }

  // Undefined when a concurrent request with the same client upload ID won.
  async insert(values: NewMediaUpload): Promise<MediaUpload | undefined> {
    const [row] = await this.db
      .insert(mediaUploads)
      .values(values)
      .onConflictDoNothing()
      .returning();
    return row;
  }

  // Moves a pending upload to ready; undefined if it is no longer pending.
  async markReady(id: string, fileSize: number): Promise<MediaUpload | undefined> {
    const [row] = await this.db
      .update(mediaUploads)
      .set({ status: "ready", fileSize, finalizedAt: new Date() })
      .where(and(eq(mediaUploads.id, id), eq(mediaUploads.status, "pending")))
      .returning();
    return row;
  }

  async markFailed(id: string, failureCode: string): Promise<MediaUpload | undefined> {
    const [row] = await this.db
      .update(mediaUploads)
      .set({ status: "failed", failureCode, finalizedAt: new Date() })
      .where(and(eq(mediaUploads.id, id), eq(mediaUploads.status, "pending")))
      .returning();
    return row;
  }

  // The owner discards an upload no message has used yet.
  async discard(ownerId: string, id: string): Promise<"discarded" | "in-use" | "missing"> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(mediaUploads)
        .where(and(eq(mediaUploads.id, id), eq(mediaUploads.ownerId, ownerId)))
        .for("update");
      if (!row || row.status === "deleted") return "missing";
      if (row.attachedAt !== null) return "in-use";
      await tx
        .update(mediaUploads)
        .set({ status: "deleted", failureCode: null, deletedAt: new Date() })
        .where(eq(mediaUploads.id, id));
      return "discarded";
    });
  }

  async markObjectDeleted(id: string): Promise<void> {
    await this.db
      .update(mediaUploads)
      .set({ objectDeletedAt: new Date() })
      .where(eq(mediaUploads.id, id));
  }

  // `starredBy` is the reader whose star on the message is looked up.
  async attachmentAccess(
    attachmentId: string,
    starredBy: string,
  ): Promise<AttachmentAccess | undefined> {
    const result = await this.db.execute<{
      id: string;
      chat_id: string;
      sequence: string;
      message_deleted: boolean;
      starred: boolean;
      thumbnail_mime_type: string | null;
      upload_ready: boolean;
    }>(sql`
      SELECT a.id, m.chat_id, m.sequence, m.deleted_at IS NOT NULL AS message_deleted,
        EXISTS (
          SELECT 1 FROM starred_messages s WHERE s.user_id = ${starredBy} AND s.message_id = m.id
        ) AS starred,
        t.mime_type AS thumbnail_mime_type,
        COALESCE(u.status = 'ready', TRUE) AS upload_ready
      FROM message_attachments a
      JOIN messages m ON m.id = a.message_id
      LEFT JOIN media_uploads u ON u.id = a.upload_id
      LEFT JOIN media_uploads t ON t.id = a.thumbnail_upload_id
      WHERE a.id = ${attachmentId}
    `);
    const row = result.rows[0];
    if (!row || !row.upload_ready) return undefined;
    const [attachment] = await this.db
      .select()
      .from(messageAttachments)
      .where(eq(messageAttachments.id, attachmentId));
    if (!attachment) return undefined;
    return {
      attachment,
      chatId: row.chat_id,
      sequence: Number(row.sequence),
      messageDeleted: row.message_deleted,
      starred: row.starred,
      thumbnailMimeType: row.thumbnail_mime_type,
    };
  }

  // ---- Cleanup -------------------------------------------------------------

  // Marks as deleted, under row locks, uploads that are abandoned (an
  // expired session never completed), never used within the unattached
  // window, or no longer referenced by any message or pending broadcast.
  // Returns how many were marked.
  async expireUnused(options: {
    pendingGraceSeconds: number;
    unattachedTtlSeconds: number;
    limit: number;
  }): Promise<number> {
    return this.db.transaction(async (tx) => {
      const candidates = await tx.execute<{ id: string; status: MediaUpload["status"] }>(sql`
        SELECT id, status FROM media_uploads u
        WHERE u.object_deleted_at IS NULL AND (
          (u.status = 'pending'
            AND u.upload_expires_at < NOW() - make_interval(secs => ${options.pendingGraceSeconds}))
          OR (u.status = 'ready'
            AND (u.attached_at IS NOT NULL
              OR u.finalized_at < NOW() - make_interval(secs => ${options.unattachedTtlSeconds}))
            AND NOT ${referenced(sql`u.id`)})
        )
        ORDER BY u.created_at
        LIMIT ${options.limit}
        FOR UPDATE SKIP LOCKED
      `);
      let marked = 0;
      for (const row of candidates.rows) {
        // Re-checked after locking: a send that committed between the scan
        // and the lock is visible to this new statement.
        const result = await tx.execute(sql`
          UPDATE media_uploads u SET status = 'deleted', failure_code = NULL, deleted_at = NOW()
          WHERE u.id = ${row.id} AND u.status = ${row.status}
            AND (u.status = 'pending' OR NOT ${referenced(sql`u.id`)})
          RETURNING u.id
        `);
        marked += result.rows.length;
      }
      return marked;
    });
  }

  // Uploads whose S3 object must be removed: refused or deleted ones not
  // yet removed, and ones removed while their upload URL still worked (a
  // late PUT could have re-created the object), once that URL expired.
  async objectsToDelete(limit: number): Promise<{ id: string; storageKey: string }[]> {
    const result = await this.db.execute<{ id: string; storage_key: string }>(sql`
      SELECT id, storage_key FROM media_uploads
      WHERE status IN ('failed', 'deleted')
        AND (object_deleted_at IS NULL
          OR (object_deleted_at <= upload_expires_at AND upload_expires_at < NOW()))
      ORDER BY created_at
      LIMIT ${limit}
    `);
    return result.rows.map((row) => ({ id: row.id, storageKey: row.storage_key }));
  }

  // Storage keys that should exist in the bucket (orphan reconciliation).
  async liveStorageKeys(keys: string[]): Promise<Set<string>> {
    if (keys.length === 0) return new Set();
    const rows = await this.db
      .select({ storageKey: mediaUploads.storageKey })
      .from(mediaUploads)
      .where(
        and(
          inArray(mediaUploads.storageKey, keys),
          inArray(mediaUploads.status, ["pending", "ready"]),
        ),
      );
    return new Set(rows.map((row) => row.storageKey));
  }
}
