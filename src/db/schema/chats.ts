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
  ],
);

export const chatMembers = pgTable(
  "chat_members",
  {
    chatId: uuid("chat_id").notNull(),
    userId: uuid("user_id").notNull(),

    role: chatMemberRole("role").notNull().default("member"),

    joinedAt: timestamptz("joined_at").notNull().defaultNow(),
    leftAt: timestamptz("left_at"),

    lastDeliveredSequence: bigint("last_delivered_sequence", { mode: "number" })
      .notNull()
      .default(0),
    lastReadSequence: bigint("last_read_sequence", { mode: "number" }).notNull().default(0),

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
  ],
);

export type Chat = typeof chats.$inferSelect;
export type NewChat = typeof chats.$inferInsert;
export type ChatMember = typeof chatMembers.$inferSelect;
export type NewChatMember = typeof chatMembers.$inferInsert;
