import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  index,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { chats } from "./chats.js";
import { devices } from "./devices.js";
import { bytea, timestamptz } from "./types.js";
import { users } from "./users.js";

export const messageType = pgEnum("message_type", [
  "text",
  "image",
  "video",
  "document",
  "audio",
  "sticker",
  "gif",
  "system",
]);

// Bodies are opaque ciphertext; the server must not depend on plaintext.
export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    chatId: uuid("chat_id").notNull(),

    senderId: uuid("sender_id").notNull(),
    senderDeviceId: uuid("sender_device_id"),

    // Client-generated idempotency key, unique per sending device.
    clientMessageId: uuid("client_message_id").notNull(),

    // Monotonically increasing within a chat; the authoritative ordering.
    sequence: bigint("sequence", { mode: "number" }).notNull(),

    type: messageType("type").notNull(),

    ciphertext: bytea("ciphertext").notNull(),
    encryptedMetadata: bytea("encrypted_metadata"),

    replyToMessageId: uuid("reply_to_message_id"),

    // Server-generated payload of a 'system' message (group events).
    systemEvent: jsonb("system_event").$type<Record<string, unknown>>(),

    createdAt: timestamptz("created_at").notNull().defaultNow(),
    editedAt: timestamptz("edited_at"),
    deletedAt: timestamptz("deleted_at"),
    deletedBy: uuid("deleted_by"),
    expiresAt: timestamptz("expires_at"),
  },
  (t) => [
    foreignKey({
      name: "messages_chat_id_fkey",
      columns: [t.chatId],
      foreignColumns: [chats.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "messages_sender_id_fkey",
      columns: [t.senderId],
      foreignColumns: [users.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "messages_sender_device_id_fkey",
      columns: [t.senderDeviceId],
      foreignColumns: [devices.id],
    }).onDelete("set null"),
    foreignKey({
      name: "messages_reply_to_message_id_fkey",
      columns: [t.replyToMessageId],
      foreignColumns: [t.id],
    }).onDelete("set null"),
    foreignKey({
      name: "messages_deleted_by_fkey",
      columns: [t.deletedBy],
      foreignColumns: [users.id],
    }).onDelete("set null"),

    check("messages_sequence_check", sql`${t.sequence} > 0`),
    check(
      "messages_system_event_check",
      sql`(${t.type} = 'system') = (${t.systemEvent} IS NOT NULL)`,
    ),

    uniqueIndex("messages_chat_sequence_unique").on(t.chatId, t.sequence),
    uniqueIndex("messages_sender_client_id_unique")
      .on(t.senderDeviceId, t.clientMessageId)
      .where(sql`${t.senderDeviceId} IS NOT NULL`),
    index("messages_chat_sequence_idx").on(t.chatId, t.sequence.desc().nullsFirst()),
    // Shared media and documents in a conversation, newest first.
    index("messages_chat_media_idx")
      .on(t.chatId, t.sequence.desc().nullsFirst())
      .where(sql`${t.type} IN ('image', 'video', 'audio') AND ${t.deletedAt} IS NULL`),
    index("messages_chat_documents_idx")
      .on(t.chatId, t.sequence.desc().nullsFirst())
      .where(sql`${t.type} = 'document' AND ${t.deletedAt} IS NULL`),
    index("messages_sender_idx").on(t.senderId),
    index("messages_reply_idx").on(t.replyToMessageId),
    index("messages_expires_idx")
      .on(t.expiresAt)
      .where(sql`${t.expiresAt} IS NOT NULL`),
  ],
);

export const messageReactions = pgTable(
  "message_reactions",
  {
    messageId: uuid("message_id").notNull(),
    userId: uuid("user_id").notNull(),

    emoji: text("emoji").notNull(),

    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: "message_reactions_pkey", columns: [t.messageId, t.userId] }),

    foreignKey({
      name: "message_reactions_message_id_fkey",
      columns: [t.messageId],
      foreignColumns: [messages.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "message_reactions_user_id_fkey",
      columns: [t.userId],
      foreignColumns: [users.id],
    }).onDelete("cascade"),

    check("message_reactions_emoji_length", sql`char_length(${t.emoji}) BETWEEN 1 AND 16`),

    index("message_reactions_message_idx").on(t.messageId),
  ],
);

// Mentioned members, validated against active membership on send.
export const messageMentions = pgTable(
  "message_mentions",
  {
    messageId: uuid("message_id").notNull(),
    userId: uuid("user_id").notNull(),
  },
  (t) => [
    primaryKey({ name: "message_mentions_pkey", columns: [t.messageId, t.userId] }),

    foreignKey({
      name: "message_mentions_message_id_fkey",
      columns: [t.messageId],
      foreignColumns: [messages.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "message_mentions_user_id_fkey",
      columns: [t.userId],
      foreignColumns: [users.id],
    }).onDelete("cascade"),

    index("message_mentions_user_idx").on(t.userId),
  ],
);

export const starredMessages = pgTable(
  "starred_messages",
  {
    userId: uuid("user_id").notNull(),
    messageId: uuid("message_id").notNull(),

    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: "starred_messages_pkey", columns: [t.userId, t.messageId] }),

    foreignKey({
      name: "starred_messages_user_id_fkey",
      columns: [t.userId],
      foreignColumns: [users.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "starred_messages_message_id_fkey",
      columns: [t.messageId],
      foreignColumns: [messages.id],
    }).onDelete("cascade"),

    // Unstarring every copy of a broadcast, and the cascade on delete.
    index("starred_messages_message_idx").on(t.messageId),
  ],
);

export const pinnedMessages = pgTable(
  "pinned_messages",
  {
    chatId: uuid("chat_id").notNull(),
    messageId: uuid("message_id").notNull(),

    pinnedBy: uuid("pinned_by").notNull(),

    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: "pinned_messages_pkey", columns: [t.chatId, t.messageId] }),

    foreignKey({
      name: "pinned_messages_chat_id_fkey",
      columns: [t.chatId],
      foreignColumns: [chats.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "pinned_messages_message_id_fkey",
      columns: [t.messageId],
      foreignColumns: [messages.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "pinned_messages_pinned_by_fkey",
      columns: [t.pinnedBy],
      foreignColumns: [users.id],
    }).onDelete("restrict"),

    index("pinned_messages_chat_idx").on(t.chatId),
  ],
);

export type Message = typeof messages.$inferSelect;
export type NewMessage = typeof messages.$inferInsert;
export type MessageReaction = typeof messageReactions.$inferSelect;
export type NewMessageReaction = typeof messageReactions.$inferInsert;
export type StarredMessage = typeof starredMessages.$inferSelect;
export type PinnedMessage = typeof pinnedMessages.$inferSelect;
