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
  uuid,
} from "drizzle-orm/pg-core";

import { chats } from "./chats.js";
import { messages } from "./messages.js";
import { timestamptz } from "./types.js";
import { users } from "./users.js";

export const blockedUsers = pgTable(
  "blocked_users",
  {
    userId: uuid("user_id").notNull(),
    blockedUserId: uuid("blocked_user_id").notNull(),

    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: "blocked_users_pkey", columns: [t.userId, t.blockedUserId] }),

    foreignKey({
      name: "blocked_users_user_id_fkey",
      columns: [t.userId],
      foreignColumns: [users.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "blocked_users_blocked_user_id_fkey",
      columns: [t.blockedUserId],
      foreignColumns: [users.id],
    }).onDelete("cascade"),

    check("blocked_users_self_check", sql`${t.userId} <> ${t.blockedUserId}`),

    index("blocked_users_blocked_user_idx").on(t.blockedUserId),
  ],
);

// Rows are created automatically when a user is inserted.
// updated_at is maintained by the set_updated_at() trigger.
export const privacySettings = pgTable(
  "privacy_settings",
  {
    userId: uuid("user_id").primaryKey(),

    showLastSeen: boolean("show_last_seen").notNull().default(true),
    showOnlineStatus: boolean("show_online_status").notNull().default(true),
    showReadReceipts: boolean("show_read_receipts").notNull().default(true),
    showTypingIndicator: boolean("show_typing_indicator").notNull().default(true),

    allowGroupInvites: boolean("allow_group_invites").notNull().default(true),

    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "privacy_settings_user_id_fkey",
      columns: [t.userId],
      foreignColumns: [users.id],
    }).onDelete("cascade"),
  ],
);

// Rows are created automatically when a user is inserted.
// updated_at is maintained by the set_updated_at() trigger.
export const userSettings = pgTable(
  "user_settings",
  {
    userId: uuid("user_id").primaryKey(),

    notificationsEnabled: boolean("notifications_enabled").notNull().default(true),
    notificationPreviewEnabled: boolean("notification_preview_enabled").notNull().default(true),

    mediaAutoDownloadImages: boolean("media_auto_download_images").notNull().default(true),
    mediaAutoDownloadVideos: boolean("media_auto_download_videos").notNull().default(false),
    mediaAutoDownloadDocuments: boolean("media_auto_download_documents").notNull().default(false),

    readReceiptsEnabled: boolean("read_receipts_enabled").notNull().default(true),

    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "user_settings_user_id_fkey",
      columns: [t.userId],
      foreignColumns: [users.id],
    }).onDelete("cascade"),
  ],
);

// App-level contact relationships. Device address books stay on-device.
// updated_at is maintained by the set_updated_at() trigger.
export const userContacts = pgTable(
  "user_contacts",
  {
    userId: uuid("user_id").notNull(),
    contactUserId: uuid("contact_user_id").notNull(),

    contactName: text("contact_name"),

    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: "user_contacts_pkey", columns: [t.userId, t.contactUserId] }),

    foreignKey({
      name: "user_contacts_user_id_fkey",
      columns: [t.userId],
      foreignColumns: [users.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "user_contacts_contact_user_id_fkey",
      columns: [t.contactUserId],
      foreignColumns: [users.id],
    }).onDelete("cascade"),

    check("user_contacts_self_check", sql`${t.userId} <> ${t.contactUserId}`),

    index("user_contacts_contact_idx").on(t.contactUserId),
  ],
);

export const userReportReason = pgEnum("user_report_reason", [
  "spam",
  "harassment",
  "inappropriate",
  "impersonation",
  "other",
]);

// Abuse reports about a user, a group, or both. Message content is never
// attached (bodies are ciphertext); message_id only points at the message.
export const userReports = pgTable(
  "user_reports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    reporterId: uuid("reporter_id").notNull(),
    reportedUserId: uuid("reported_user_id"),
    chatId: uuid("chat_id"),
    messageId: uuid("message_id"),
    reason: userReportReason("reason").notNull(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "user_reports_reporter_id_fkey",
      columns: [t.reporterId],
      foreignColumns: [users.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "user_reports_reported_user_id_fkey",
      columns: [t.reportedUserId],
      foreignColumns: [users.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "user_reports_chat_id_fkey",
      columns: [t.chatId],
      foreignColumns: [chats.id],
    }).onDelete("set null"),
    foreignKey({
      name: "user_reports_message_id_fkey",
      columns: [t.messageId],
      foreignColumns: [messages.id],
    }).onDelete("set null"),

    check("user_reports_self_check", sql`${t.reporterId} <> ${t.reportedUserId}`),
    check(
      "user_reports_target_check",
      sql`${t.reportedUserId} IS NOT NULL OR ${t.chatId} IS NOT NULL`,
    ),

    index("user_reports_reported_user_idx").on(t.reportedUserId, t.createdAt.desc().nullsFirst()),
  ],
);

export type BlockedUser = typeof blockedUsers.$inferSelect;
export type UserReport = typeof userReports.$inferSelect;
export type PrivacySettings = typeof privacySettings.$inferSelect;
export type UserSettings = typeof userSettings.$inferSelect;
export type UserContact = typeof userContacts.$inferSelect;
