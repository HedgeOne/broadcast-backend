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
  primaryKey,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { chats } from "./chats.js";
import { devices } from "./devices.js";
import { mediaUploads } from "./media.js";
import { messages, messageType } from "./messages.js";
import { bytea, timestamptz } from "./types.js";
import { users } from "./users.js";

// 'pending' = accepted into the durable pipeline, direct message not yet
// written. 'sent' = the recipient's direct message is committed. 'delivered'
// and 'read' follow the recipient's receipt pointers in that direct chat.
// 'failed' carries failure_code and whether a retry may succeed.
export const broadcastRecipientStatus = pgEnum("broadcast_recipient_status", [
  "pending",
  "sent",
  "delivered",
  "read",
  "failed",
]);

// A broadcast list is NOT a group chat. Recipients receive the message in
// their normal direct conversation with the sender.
// updated_at is maintained by the set_updated_at() trigger.
export const broadcastLists = pgTable(
  "broadcast_lists",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    ownerId: uuid("owner_id").notNull(),

    name: text("name").notNull(),

    // Client-generated key making creation idempotent per owner.
    clientRequestId: uuid("client_request_id"),

    muted: boolean("muted").notNull().default(false),

    // List photo: a verified 'broadcast_list_photo' upload and its
    // thumbnail, always set together. Private to the owner; recipients
    // never see it.
    photoUploadId: uuid("photo_upload_id"),
    photoThumbnailUploadId: uuid("photo_thumbnail_upload_id"),

    // Clear Chat for the owner's list view: broadcasts with history_seq at
    // or below this are hidden from the list. Recipients' chats are untouched.
    clearedThroughSeq: bigint("cleared_through_seq", { mode: "number" }).notNull().default(0),
    clearedAt: timestamptz("cleared_at"),

    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),

    // Deleted lists are kept for the history of broadcasts already sent but
    // are no longer readable or usable through the API.
    deletedAt: timestamptz("deleted_at"),
  },
  (t) => [
    foreignKey({
      name: "broadcast_lists_owner_id_fkey",
      columns: [t.ownerId],
      foreignColumns: [users.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "broadcast_lists_photo_upload_id_fkey",
      columns: [t.photoUploadId],
      foreignColumns: [mediaUploads.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "broadcast_lists_photo_thumbnail_upload_id_fkey",
      columns: [t.photoThumbnailUploadId],
      foreignColumns: [mediaUploads.id],
    }).onDelete("restrict"),
    check(
      "broadcast_lists_photo_pair_check",
      sql`(${t.photoUploadId} IS NULL) = (${t.photoThumbnailUploadId} IS NULL)`,
    ),
    index("broadcast_lists_photo_upload_idx")
      .on(t.photoUploadId)
      .where(sql`${t.photoUploadId} IS NOT NULL`),
    index("broadcast_lists_photo_thumbnail_upload_idx")
      .on(t.photoThumbnailUploadId)
      .where(sql`${t.photoThumbnailUploadId} IS NOT NULL`),

    check("broadcast_lists_cleared_check", sql`${t.clearedThroughSeq} >= 0`),
    check("broadcast_lists_name_not_empty", sql`length(trim(${t.name})) > 0`),
    check("broadcast_lists_name_length", sql`char_length(${t.name}) <= 100`),

    index("broadcast_lists_owner_active_idx")
      .on(t.ownerId, t.updatedAt.desc().nullsFirst())
      .where(sql`${t.deletedAt} IS NULL`),
    uniqueIndex("broadcast_lists_owner_request_unique")
      .on(t.ownerId, t.clientRequestId)
      .where(sql`${t.clientRequestId} IS NOT NULL`),
  ],
);

export const broadcastListMembers = pgTable(
  "broadcast_list_members",
  {
    broadcastListId: uuid("broadcast_list_id").notNull(),
    userId: uuid("user_id").notNull(),

    addedAt: timestamptz("added_at").notNull().defaultNow(),
    removedAt: timestamptz("removed_at"),
  },
  (t) => [
    primaryKey({
      name: "broadcast_list_members_pkey",
      columns: [t.broadcastListId, t.userId],
    }),

    foreignKey({
      name: "broadcast_list_members_broadcast_list_id_fkey",
      columns: [t.broadcastListId],
      foreignColumns: [broadcastLists.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "broadcast_list_members_user_id_fkey",
      columns: [t.userId],
      foreignColumns: [users.id],
    }).onDelete("cascade"),

    index("broadcast_list_members_user_idx").on(t.userId),
    index("broadcast_list_members_active_idx")
      .on(t.broadcastListId, t.userId)
      .where(sql`${t.removedAt} IS NULL`),
  ],
);

// One send operation. The body lives in each recipient's direct message;
// ciphertext here is only kept while some recipient may still need it
// (pending or retryable), then cleared.
export const broadcastMessages = pgTable(
  "broadcast_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    broadcastListId: uuid("broadcast_list_id").notNull(),

    senderId: uuid("sender_id").notNull(),
    senderDeviceId: uuid("sender_device_id"),

    clientMessageId: uuid("client_message_id").notNull(),

    // Commit-independent order of acceptance, for the list's clear marker
    // and shared-content paging (created_at is the transaction start).
    historySeq: bigint("history_seq", { mode: "number" }).notNull().generatedAlwaysAsIdentity(),

    type: messageType("type").notNull(),

    ciphertext: bytea("ciphertext"),
    encryptedMetadata: bytea("encrypted_metadata"),

    // The one uploaded object every recipient's message points at.
    attachmentUploadId: uuid("attachment_upload_id"),
    thumbnailUploadId: uuid("thumbnail_upload_id"),

    createdAt: timestamptz("created_at").notNull().defaultNow(),
    // Set once no recipient is pending; cleared when a retry re-queues.
    completedAt: timestamptz("completed_at"),
  },
  (t) => [
    foreignKey({
      name: "broadcast_messages_broadcast_list_id_fkey",
      columns: [t.broadcastListId],
      foreignColumns: [broadcastLists.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "broadcast_messages_sender_id_fkey",
      columns: [t.senderId],
      foreignColumns: [users.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "broadcast_messages_sender_device_id_fkey",
      columns: [t.senderDeviceId],
      foreignColumns: [devices.id],
    }).onDelete("set null"),
    foreignKey({
      name: "broadcast_messages_attachment_upload_id_fkey",
      columns: [t.attachmentUploadId],
      foreignColumns: [mediaUploads.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "broadcast_messages_thumbnail_upload_id_fkey",
      columns: [t.thumbnailUploadId],
      foreignColumns: [mediaUploads.id],
    }).onDelete("restrict"),

    check(
      "broadcast_messages_thumbnail_check",
      sql`${t.thumbnailUploadId} IS NULL OR ${t.attachmentUploadId} IS NOT NULL`,
    ),

    uniqueIndex("broadcast_messages_client_id_unique").on(t.senderId, t.clientMessageId),
    index("broadcast_messages_list_idx").on(t.broadcastListId, t.createdAt.desc().nullsFirst()),
    index("broadcast_messages_list_seq_idx").on(
      t.broadcastListId,
      t.historySeq.desc().nullsFirst(),
    ),
    index("broadcast_messages_attachment_upload_idx")
      .on(t.attachmentUploadId)
      .where(sql`${t.attachmentUploadId} IS NOT NULL`),
    index("broadcast_messages_thumbnail_upload_idx")
      .on(t.thumbnailUploadId)
      .where(sql`${t.thumbnailUploadId} IS NOT NULL`),
  ],
);

// The recipient snapshot of a broadcast: one row per intended recipient,
// mapped to the direct message written for them.
export const broadcastMessageRecipients = pgTable(
  "broadcast_message_recipients",
  {
    broadcastMessageId: uuid("broadcast_message_id").notNull(),
    recipientId: uuid("recipient_id").notNull(),

    // The recipient's direct chat with the sender.
    targetChatId: uuid("target_chat_id"),

    // client_message_id of the direct message, fixed at acceptance.
    clientMessageId: uuid("client_message_id").notNull().defaultRandom(),
    messageId: uuid("message_id"),

    status: broadcastRecipientStatus("status").notNull().default("pending"),

    attemptCount: integer("attempt_count").notNull().default(0),
    lastAttemptAt: timestamptz("last_attempt_at"),

    sentAt: timestamptz("sent_at"),
    deliveredAt: timestamptz("delivered_at"),
    readAt: timestamptz("read_at"),

    failedAt: timestamptz("failed_at"),
    // A stable code (never message content or other recipients' details).
    failureCode: text("failure_code"),
    retryable: boolean("retryable").notNull().default(false),
  },
  (t) => [
    primaryKey({
      name: "broadcast_message_recipients_pkey",
      columns: [t.broadcastMessageId, t.recipientId],
    }),

    foreignKey({
      name: "broadcast_message_recipients_broadcast_message_id_fkey",
      columns: [t.broadcastMessageId],
      foreignColumns: [broadcastMessages.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "broadcast_message_recipients_recipient_id_fkey",
      columns: [t.recipientId],
      foreignColumns: [users.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "broadcast_message_recipients_target_chat_id_fkey",
      columns: [t.targetChatId],
      foreignColumns: [chats.id],
    }).onDelete("set null"),
    foreignKey({
      name: "broadcast_message_recipients_message_id_fkey",
      columns: [t.messageId],
      foreignColumns: [messages.id],
    }).onDelete("set null"),

    check("broadcast_recipients_attempts_check", sql`${t.attemptCount} >= 0`),
    check(
      "broadcast_recipients_failure_check",
      sql`(${t.status} = 'failed') = (${t.failureCode} IS NOT NULL)`,
    ),
    check(
      "broadcast_recipients_retryable_check",
      sql`NOT ${t.retryable} OR ${t.status} = 'failed'`,
    ),

    index("broadcast_recipients_recipient_idx").on(t.recipientId),
    index("broadcast_recipients_chat_idx").on(t.targetChatId),
    uniqueIndex("broadcast_recipients_message_unique")
      .on(t.messageId)
      .where(sql`${t.messageId} IS NOT NULL`),
    index("broadcast_recipients_work_idx")
      .on(t.broadcastMessageId)
      .where(sql`${t.status} = 'pending'`),
    index("broadcast_recipients_receipt_idx")
      .on(t.targetChatId, t.recipientId)
      .where(sql`${t.status} IN ('sent', 'delivered')`),
  ],
);

export type BroadcastList = typeof broadcastLists.$inferSelect;
export type NewBroadcastList = typeof broadcastLists.$inferInsert;
export type BroadcastListMember = typeof broadcastListMembers.$inferSelect;
export type BroadcastMessage = typeof broadcastMessages.$inferSelect;
export type NewBroadcastMessage = typeof broadcastMessages.$inferInsert;
export type BroadcastMessageRecipient = typeof broadcastMessageRecipients.$inferSelect;
