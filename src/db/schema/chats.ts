import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { timestamptz } from "./types.js";
import { users } from "./users.js";

export const chatType = pgEnum("chat_type", ["direct", "group"]);

export const chatMemberRole = pgEnum("chat_member_role", ["member", "admin", "owner"]);

// Direct and group conversations share this entity.
// Broadcast lists are separate entities.
// updated_at is maintained by the set_updated_at() trigger.
export const chats = pgTable(
  "chats",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    type: chatType("type").notNull(),

    createdBy: uuid("created_by").notNull(),

    // Direct chats only. Pair uniqueness is order-independent via
    // direct_chat_pair_unique.
    directUserAId: uuid("direct_user_a_id"),
    directUserBId: uuid("direct_user_b_id"),

    // Client-generated key making creation idempotent per creator.
    clientRequestId: uuid("client_request_id"),

    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),

    archivedAt: timestamptz("archived_at"),
  },
  (t) => [
    foreignKey({
      name: "chats_created_by_fkey",
      columns: [t.createdBy],
      foreignColumns: [users.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "chats_direct_user_a_id_fkey",
      columns: [t.directUserAId],
      foreignColumns: [users.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "chats_direct_user_b_id_fkey",
      columns: [t.directUserBId],
      foreignColumns: [users.id],
    }).onDelete("cascade"),

    check(
      "direct_chat_users_check",
      sql`${t.type} = 'group' OR (${t.directUserAId} IS NOT NULL AND ${t.directUserBId} IS NOT NULL AND ${t.directUserAId} <> ${t.directUserBId})`,
    ),
    check(
      "group_chat_users_check",
      sql`${t.type} = 'direct' OR (${t.directUserAId} IS NULL AND ${t.directUserBId} IS NULL)`,
    ),

    index("chats_created_by_idx").on(t.createdBy),
    index("chats_type_idx").on(t.type),
    uniqueIndex("direct_chat_pair_unique")
      .on(
        sql`LEAST(${t.directUserAId}, ${t.directUserBId})`,
        sql`GREATEST(${t.directUserAId}, ${t.directUserBId})`,
      )
      .where(sql`${t.type} = 'direct'`),
    uniqueIndex("chats_creator_request_unique")
      .on(t.createdBy, t.clientRequestId)
      .where(sql`${t.clientRequestId} IS NOT NULL`),
  ],
);

export const chatMembers = pgTable(
  "chat_members",
  {
    chatId: uuid("chat_id").notNull(),
    userId: uuid("user_id").notNull(),

    role: chatMemberRole("role").notNull().default("member"),

    joinedAt: timestamptz("joined_at").notNull().defaultNow(),
    // Set when the member left or was removed (then removed_by is set).
    leftAt: timestamptz("left_at"),
    removedBy: uuid("removed_by"),

    // Messages at or below this sequence are hidden from the member.
    historyFromSequence: bigint("history_from_sequence", { mode: "number" }).notNull().default(0),
    // Clear Chat: the member's own view ends at this sequence. It only ever
    // grows and is folded into history_from_sequence, including on rejoin.
    clearedThroughSequence: bigint("cleared_through_sequence", { mode: "number" })
      .notNull()
      .default(0),
    clearedAt: timestamptz("cleared_at"),

    lastDeliveredSequence: bigint("last_delivered_sequence", { mode: "number" })
      .notNull()
      .default(0),
    lastReadSequence: bigint("last_read_sequence", { mode: "number" }).notNull().default(0),

    // Notifications are muted while NOW() < muted_until (server time).
    // 9999-12-31 means "Always". Expired values are equivalent to NULL;
    // the notification sweep clears them, but nothing depends on that.
    mutedUntil: timestamptz("muted_until"),

    disappearingMessagesSeconds: integer("disappearing_messages_seconds"),
  },
  (t) => [
    primaryKey({ name: "chat_members_pkey", columns: [t.chatId, t.userId] }),

    foreignKey({
      name: "chat_members_chat_id_fkey",
      columns: [t.chatId],
      foreignColumns: [chats.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "chat_members_user_id_fkey",
      columns: [t.userId],
      foreignColumns: [users.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "chat_members_removed_by_fkey",
      columns: [t.removedBy],
      foreignColumns: [users.id],
    }).onDelete("set null"),

    check("chat_members_history_check", sql`${t.historyFromSequence} >= 0`),
    check(
      "chat_members_cleared_check",
      sql`${t.clearedThroughSequence} >= 0 AND ${t.clearedThroughSequence} <= ${t.historyFromSequence}`,
    ),
    check(
      "chat_members_sequence_check",
      sql`${t.lastDeliveredSequence} >= 0 AND ${t.lastReadSequence} >= 0 AND ${t.lastReadSequence} <= ${t.lastDeliveredSequence}`,
    ),
    check(
      "chat_members_disappearing_check",
      sql`${t.disappearingMessagesSeconds} IS NULL OR ${t.disappearingMessagesSeconds} > 0`,
    ),

    index("chat_members_user_id_idx").on(t.userId),
    index("chat_members_active_idx")
      .on(t.userId, t.chatId)
      .where(sql`${t.leftAt} IS NULL`),
    index("chat_members_user_recent_idx").on(t.userId, t.joinedAt.desc().nullsFirst()),
    uniqueIndex("chat_members_one_owner")
      .on(t.chatId)
      .where(sql`${t.role} = 'owner' AND ${t.leftAt} IS NULL`),
    index("chat_members_chat_active_idx")
      .on(t.chatId)
      .where(sql`${t.leftAt} IS NULL`),
    index("chat_members_muted_until_idx")
      .on(t.mutedUntil)
      .where(sql`${t.mutedUntil} IS NOT NULL`),
  ],
);

export type Chat = typeof chats.$inferSelect;
export type NewChat = typeof chats.$inferInsert;
export type ChatMember = typeof chatMembers.$inferSelect;
export type NewChatMember = typeof chatMembers.$inferInsert;
