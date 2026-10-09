import { sql } from "drizzle-orm";
import {
  boolean,
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
import { timestamptz } from "./types.js";
import { users } from "./users.js";

export const groupMemberStatus = pgEnum("group_member_status", ["active", "left", "removed"]);

// updated_at is maintained by the set_updated_at() trigger.
export const groups = pgTable(
  "groups",
  {
    chatId: uuid("chat_id").primaryKey(),

    name: text("name").notNull(),
    description: text("description"),

    // No FK yet: the media table does not exist.
    avatarMediaId: uuid("avatar_media_id"),

    inviteCode: text("invite_code"),

    approvalRequired: boolean("approval_required").notNull().default(false),

    onlyAdminsCanMessage: boolean("only_admins_can_message").notNull().default(false),
    onlyAdminsCanEditInfo: boolean("only_admins_can_edit_info").notNull().default(false),

    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "groups_chat_id_fkey",
      columns: [t.chatId],
      foreignColumns: [chats.id],
    }).onDelete("cascade"),

    check("groups_name_not_empty", sql`length(trim(${t.name})) > 0`),

    uniqueIndex("groups_invite_code_unique")
      .on(t.inviteCode)
      .where(sql`${t.inviteCode} IS NOT NULL`),
  ],
);

export const groupMembers = pgTable(
  "group_members",
  {
    chatId: uuid("chat_id").notNull(),
    userId: uuid("user_id").notNull(),

    status: groupMemberStatus("status").notNull().default("active"),

    joinedAt: timestamptz("joined_at").notNull().defaultNow(),
    leftAt: timestamptz("left_at"),
  },
  (t) => [
    primaryKey({ name: "group_members_pkey", columns: [t.chatId, t.userId] }),

    foreignKey({
      name: "group_members_chat_id_fkey",
      columns: [t.chatId],
      foreignColumns: [groups.chatId],
    }).onDelete("cascade"),
    foreignKey({
      name: "group_members_user_id_fkey",
      columns: [t.userId],
      foreignColumns: [users.id],
    }).onDelete("cascade"),

    index("group_members_user_id_idx").on(t.userId),
  ],
);

export type Group = typeof groups.$inferSelect;
export type NewGroup = typeof groups.$inferInsert;
export type GroupMember = typeof groupMembers.$inferSelect;
export type NewGroupMember = typeof groupMembers.$inferInsert;
