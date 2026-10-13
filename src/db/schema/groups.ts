import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { chats } from "./chats.js";
import { mediaUploads } from "./media.js";
import { bytea, timestamptz } from "./types.js";
import { users } from "./users.js";

// A group is a chats row (type 'group') plus this row. Membership and roles
// live in chat_members. updated_at is maintained by the set_updated_at()
// trigger.
export const groups = pgTable(
  "groups",
  {
    chatId: uuid("chat_id").primaryKey(),

    name: text("name").notNull(),
    description: text("description"),

    // Group photo: a verified 'group_photo' upload and its thumbnail, always
    // set together. Only current members may download them.
    photoUploadId: uuid("photo_upload_id"),
    photoThumbnailUploadId: uuid("photo_thumbnail_upload_id"),

    approvalRequired: boolean("approval_required").notNull().default(false),

    onlyAdminsCanMessage: boolean("only_admins_can_message").notNull().default(false),
    onlyAdminsCanEditInfo: boolean("only_admins_can_edit_info").notNull().default(false),
    onlyAdminsCanAddMembers: boolean("only_admins_can_add_members").notNull().default(true),
    inviteLinksEnabled: boolean("invite_links_enabled").notNull().default(false),
    historyVisibleToNewMembers: boolean("history_visible_to_new_members").notNull().default(false),

    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
    deletedAt: timestamptz("deleted_at"),
  },
  (t) => [
    foreignKey({
      name: "groups_chat_id_fkey",
      columns: [t.chatId],
      foreignColumns: [chats.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "groups_photo_upload_id_fkey",
      columns: [t.photoUploadId],
      foreignColumns: [mediaUploads.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "groups_photo_thumbnail_upload_id_fkey",
      columns: [t.photoThumbnailUploadId],
      foreignColumns: [mediaUploads.id],
    }).onDelete("restrict"),
    check(
      "groups_photo_pair_check",
      sql`(${t.photoUploadId} IS NULL) = (${t.photoThumbnailUploadId} IS NULL)`,
    ),
    index("groups_photo_upload_idx")
      .on(t.photoUploadId)
      .where(sql`${t.photoUploadId} IS NOT NULL`),
    index("groups_photo_thumbnail_upload_idx")
      .on(t.photoThumbnailUploadId)
      .where(sql`${t.photoThumbnailUploadId} IS NOT NULL`),

    check("groups_name_not_empty", sql`length(trim(${t.name})) > 0`),
    check("groups_name_length", sql`char_length(${t.name}) <= 100`),
    check(
      "groups_description_length",
      sql`${t.description} IS NULL OR char_length(${t.description}) <= 512`,
    ),
  ],
);

// Only the SHA-256 of the 32-byte token is stored.
export const groupInvites = pgTable(
  "group_invites",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    chatId: uuid("chat_id").notNull(),

    tokenHash: bytea("token_hash").notNull(),

    createdBy: uuid("created_by").notNull(),

    createdAt: timestamptz("created_at").notNull().defaultNow(),
    expiresAt: timestamptz("expires_at"),

    maxUses: integer("max_uses"),
    useCount: integer("use_count").notNull().default(0),

    revokedAt: timestamptz("revoked_at"),
  },
  (t) => [
    foreignKey({
      name: "group_invites_chat_id_fkey",
      columns: [t.chatId],
      foreignColumns: [groups.chatId],
    }).onDelete("cascade"),
    foreignKey({
      name: "group_invites_created_by_fkey",
      columns: [t.createdBy],
      foreignColumns: [users.id],
    }).onDelete("cascade"),

    check("group_invites_token_hash_length", sql`octet_length(${t.tokenHash}) = 32`),
    check("group_invites_max_uses_check", sql`${t.maxUses} IS NULL OR ${t.maxUses} > 0`),
    check("group_invites_use_count_check", sql`${t.useCount} >= 0`),

    uniqueIndex("group_invites_token_hash_unique").on(t.tokenHash),
    uniqueIndex("group_invites_one_active")
      .on(t.chatId)
      .where(sql`${t.revokedAt} IS NULL`),
  ],
);

export const groupJoinRequests = pgTable(
  "group_join_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    chatId: uuid("chat_id").notNull(),
    userId: uuid("user_id").notNull(),
    inviteId: uuid("invite_id"),

    status: text("status", { enum: ["pending", "approved", "rejected", "cancelled"] })
      .notNull()
      .default("pending"),

    createdAt: timestamptz("created_at").notNull().defaultNow(),
    decidedAt: timestamptz("decided_at"),
    decidedBy: uuid("decided_by"),
  },
  (t) => [
    foreignKey({
      name: "group_join_requests_chat_id_fkey",
      columns: [t.chatId],
      foreignColumns: [groups.chatId],
    }).onDelete("cascade"),
    foreignKey({
      name: "group_join_requests_user_id_fkey",
      columns: [t.userId],
      foreignColumns: [users.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "group_join_requests_invite_id_fkey",
      columns: [t.inviteId],
      foreignColumns: [groupInvites.id],
    }).onDelete("set null"),
    foreignKey({
      name: "group_join_requests_decided_by_fkey",
      columns: [t.decidedBy],
      foreignColumns: [users.id],
    }).onDelete("set null"),

    check(
      "group_join_requests_status_check",
      sql`${t.status} IN ('pending', 'approved', 'rejected', 'cancelled')`,
    ),

    uniqueIndex("group_join_requests_pending_unique")
      .on(t.chatId, t.userId)
      .where(sql`${t.status} = 'pending'`),
    index("group_join_requests_chat_pending_idx")
      .on(t.chatId, t.createdAt)
      .where(sql`${t.status} = 'pending'`),
  ],
);

export type Group = typeof groups.$inferSelect;
export type NewGroup = typeof groups.$inferInsert;
export type GroupInvite = typeof groupInvites.$inferSelect;
export type GroupJoinRequest = typeof groupJoinRequests.$inferSelect;
