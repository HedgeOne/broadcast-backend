import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  uuid,
} from "drizzle-orm/pg-core";

import { messages } from "./messages.js";
import { bytea, timestamptz } from "./types.js";

export const attachmentType = pgEnum("attachment_type", [
  "image",
  "video",
  "document",
  "audio",
  "sticker",
]);

// File bytes live in S3; only metadata is stored here.
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

    encryptionMetadata: bytea("encryption_metadata"),

    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "message_attachments_message_id_fkey",
      columns: [t.messageId],
      foreignColumns: [messages.id],
    }).onDelete("cascade"),

    check("message_attachments_file_size_check", sql`${t.fileSize} IS NULL OR ${t.fileSize} >= 0`),
    check(
      "message_attachments_dimensions_check",
      sql`(${t.width} IS NULL OR ${t.width} > 0) AND (${t.height} IS NULL OR ${t.height} > 0)`,
    ),
    check(
      "message_attachments_duration_check",
      sql`${t.durationMs} IS NULL OR ${t.durationMs} >= 0`,
    ),

    index("message_attachments_message_idx").on(t.messageId),
  ],
);

export type MessageAttachment = typeof messageAttachments.$inferSelect;
export type NewMessageAttachment = typeof messageAttachments.$inferInsert;
