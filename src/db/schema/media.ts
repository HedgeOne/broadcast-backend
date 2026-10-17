import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { messages } from "./messages.js";
import { bytea, timestamptz } from "./types.js";
import { users } from "./users.js";

export const attachmentType = pgEnum("attachment_type", [
  "image",
  "video",
  "document",
  "audio",
  "sticker",
]);

// pending = presigned PUT issued, not verified. ready = object verified
// against S3. failed = verification refused it (failure_code). deleted =
// removed; object_deleted_at is set once the S3 object is gone.
export const mediaUploadStatus = pgEnum("media_upload_status", [
  "pending",
  "ready",
  "failed",
  "deleted",
]);

// What an upload is for. Each purpose has its own key prefix, type and size
// rules, and can only be used for that purpose: a profile photo can never
// be attached to a message, nor an attachment become a profile photo.
export const mediaPurpose = pgEnum("media_purpose", [
  "attachment",
  "profile_photo",
  "group_photo",
  "broadcast_list_photo",
]);

// One uploaded object in the private media bucket: the upload session and,
// once verified, the object's metadata and lifecycle. Access to the bytes
// is always decided through what references the upload (a message, a
// profile, a group or a broadcast list).
export const mediaUploads = pgTable(
  "media_uploads",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    // NULL once the account is deleted; cleanup still removes the object.
    ownerId: uuid("owner_id"),

    // Client-generated key making session creation idempotent per owner.
    clientUploadId: uuid("client_upload_id").notNull(),

    purpose: mediaPurpose("purpose").notNull().default("attachment"),
    category: attachmentType("category").notNull(),
    mimeType: text("mime_type").notNull(),
    fileName: text("file_name"),
    // The presigned PUT only accepts exactly this many bytes.
    declaredSize: bigint("declared_size", { mode: "number" }).notNull(),
    // Size S3 reports for the stored object, set when verified.
    fileSize: bigint("file_size", { mode: "number" }),

    // Server-generated ({purpose prefix}/{opaque id}/...); never derived
    // from user data.
    storageKey: text("storage_key").notNull().unique("media_uploads_storage_key_key"),

    width: integer("width"),
    height: integer("height"),
    durationMs: integer("duration_ms"),

    status: mediaUploadStatus("status").notNull().default("pending"),
    failureCode: text("failure_code"),

    // True when the S3 object is client-side ciphertext (message attachments).
    // Logical mimeType remains for UI; verification skips plaintext magic sniffing.
    contentEncrypted: boolean("content_encrypted").notNull().default(false),

    createdAt: timestamptz("created_at").notNull().defaultNow(),
    uploadExpiresAt: timestamptz("upload_expires_at").notNull(),
    finalizedAt: timestamptz("finalized_at"),
    // First time a message, profile, group or list used this upload.
    attachedAt: timestamptz("attached_at"),
    deletedAt: timestamptz("deleted_at"),
    objectDeletedAt: timestamptz("object_deleted_at"),
  },
  (t) => [
    foreignKey({
      name: "media_uploads_owner_id_fkey",
      columns: [t.ownerId],
      foreignColumns: [users.id],
    }).onDelete("set null"),

    check("media_uploads_declared_size_check", sql`${t.declaredSize} > 0`),
    check("media_uploads_file_size_check", sql`${t.fileSize} IS NULL OR ${t.fileSize} > 0`),
    check(
      "media_uploads_file_name_length",
      sql`${t.fileName} IS NULL OR char_length(${t.fileName}) <= 255`,
    ),
    check(
      "media_uploads_dimensions_check",
      sql`(${t.width} IS NULL OR ${t.width} > 0) AND (${t.height} IS NULL OR ${t.height} > 0)`,
    ),
    check("media_uploads_duration_check", sql`${t.durationMs} IS NULL OR ${t.durationMs} >= 0`),
    check(
      "media_uploads_ready_check",
      sql`${t.status} <> 'ready' OR (${t.fileSize} IS NOT NULL AND ${t.finalizedAt} IS NOT NULL)`,
    ),
    check(
      "media_uploads_failure_check",
      sql`(${t.status} = 'failed') = (${t.failureCode} IS NOT NULL)`,
    ),
    check(
      "media_uploads_deleted_check",
      sql`(${t.status} = 'deleted') = (${t.deletedAt} IS NOT NULL)`,
    ),

    check(
      "media_uploads_photo_category_check",
      sql`${t.purpose} = 'attachment' OR ${t.category} = 'image'`,
    ),

    uniqueIndex("media_uploads_owner_client_unique").on(t.ownerId, t.clientUploadId),
    index("media_uploads_cleanup_idx")
      .on(t.status, t.createdAt)
      .where(sql`${t.objectDeletedAt} IS NULL`),
  ],
);

// What a message carries. File bytes live in S3 (the referenced upload);
// only metadata is stored here. One attachment per message.
export const messageAttachments = pgTable(
  "message_attachments",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    messageId: uuid("message_id").notNull(),

    type: attachmentType("type").notNull(),

    storageKey: text("storage_key").notNull(),

    mimeType: text("mime_type").notNull(),

    fileName: text("file_name"),

    fileSize: bigint("file_size", { mode: "number" }),

    width: integer("width"),
    height: integer("height"),

    durationMs: integer("duration_ms"),

    thumbnailStorageKey: text("thumbnail_storage_key"),

    // Reserved for client-side (end-to-end) encryption of the file; unused
    // while attachments are protected only by HTTPS and S3 encryption.
    encryptionMetadata: bytea("encryption_metadata"),

    // The upload holding the bytes; several attachments (one per broadcast
    // recipient) may share one upload.
    uploadId: uuid("upload_id"),
    thumbnailUploadId: uuid("thumbnail_upload_id"),

    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "message_attachments_message_id_fkey",
      columns: [t.messageId],
      foreignColumns: [messages.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "message_attachments_upload_id_fkey",
      columns: [t.uploadId],
      foreignColumns: [mediaUploads.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "message_attachments_thumbnail_upload_id_fkey",
      columns: [t.thumbnailUploadId],
      foreignColumns: [mediaUploads.id],
    }).onDelete("restrict"),

    check("message_attachments_file_size_check", sql`${t.fileSize} IS NULL OR ${t.fileSize} >= 0`),
    check(
      "message_attachments_dimensions_check",
      sql`(${t.width} IS NULL OR ${t.width} > 0) AND (${t.height} IS NULL OR ${t.height} > 0)`,
    ),
    check(
      "message_attachments_duration_check",
      sql`${t.durationMs} IS NULL OR ${t.durationMs} >= 0`,
    ),

    uniqueIndex("message_attachments_message_unique").on(t.messageId),
    index("message_attachments_upload_idx")
      .on(t.uploadId)
      .where(sql`${t.uploadId} IS NOT NULL`),
    index("message_attachments_thumbnail_upload_idx")
      .on(t.thumbnailUploadId)
      .where(sql`${t.thumbnailUploadId} IS NOT NULL`),
  ],
);

export type MediaUpload = typeof mediaUploads.$inferSelect;
export type NewMediaUpload = typeof mediaUploads.$inferInsert;
export type MessageAttachment = typeof messageAttachments.$inferSelect;
export type NewMessageAttachment = typeof messageAttachments.$inferInsert;
