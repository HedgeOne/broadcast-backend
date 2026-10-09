import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { chats } from "./chats.js";
import { messageType } from "./messages.js";
import { bytea, timestamptz } from "./types.js";
import { users } from "./users.js";

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

    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "broadcast_lists_owner_id_fkey",
      columns: [t.ownerId],
      foreignColumns: [users.id],
    }).onDelete("cascade"),

    check("broadcast_lists_name_not_empty", sql`length(trim(${t.name})) > 0`),

    index("broadcast_lists_owner_idx").on(t.ownerId),
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

// The logical message is stored once; per-recipient state lives in
// broadcast_message_recipients.
export const broadcastMessages = pgTable(
  "broadcast_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    broadcastListId: uuid("broadcast_list_id").notNull(),

    senderId: uuid("sender_id").notNull(),

    clientMessageId: uuid("client_message_id").notNull(),

    type: messageType("type").notNull(),

    ciphertext: bytea("ciphertext").notNull(),
    encryptedMetadata: bytea("encrypted_metadata"),

    createdAt: timestamptz("created_at").notNull().defaultNow(),
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

    uniqueIndex("broadcast_messages_client_id_unique").on(t.senderId, t.clientMessageId),
    index("broadcast_messages_list_idx").on(t.broadcastListId, t.createdAt.desc().nullsFirst()),
  ],
);

export const broadcastMessageRecipients = pgTable(
  "broadcast_message_recipients",
  {
    broadcastMessageId: uuid("broadcast_message_id").notNull(),
    recipientId: uuid("recipient_id").notNull(),

    // The recipient's direct chat with the sender.
    targetChatId: uuid("target_chat_id"),

    status: broadcastRecipientStatus("status").notNull().default("pending"),

    sentAt: timestamptz("sent_at"),
    deliveredAt: timestamptz("delivered_at"),
    readAt: timestamptz("read_at"),

    failedAt: timestamptz("failed_at"),
    failureReason: text("failure_reason"),
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

    index("broadcast_recipients_recipient_idx").on(t.recipientId),
    index("broadcast_recipients_chat_idx").on(t.targetChatId),
    index("broadcast_recipients_pending_idx")
      .on(t.recipientId, t.status)
      .where(sql`${t.status} IN ('pending', 'sent')`),
  ],
);

export type BroadcastList = typeof broadcastLists.$inferSelect;
export type NewBroadcastList = typeof broadcastLists.$inferInsert;
export type BroadcastListMember = typeof broadcastListMembers.$inferSelect;
export type BroadcastMessage = typeof broadcastMessages.$inferSelect;
export type NewBroadcastMessage = typeof broadcastMessages.$inferInsert;
export type BroadcastMessageRecipient = typeof broadcastMessageRecipients.$inferSelect;
