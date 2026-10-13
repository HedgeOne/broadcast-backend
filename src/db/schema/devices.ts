import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  pgEnum,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { timestamptz } from "./types.js";
import { users } from "./users.js";

export const devicePlatform = pgEnum("device_platform", ["ios", "android"]);

// Why a device's push token was deactivated: the app unregistered it, the
// session signed out, another account registered the same install, or the
// provider reported the token as no longer valid.
export const devicePushRevocation = pgEnum("device_push_revocation", [
  "unregistered",
  "logout",
  "replaced",
  "invalid",
]);

// updated_at is maintained by the set_updated_at() trigger.
export const devices = pgTable(
  "devices",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    userId: uuid("user_id").notNull(),

    platform: devicePlatform("platform").notNull(),

    deviceName: text("device_name"),

    appVersion: text("app_version"),
    osVersion: text("os_version"),

    // Expo push token of the install signed in on this device. NULL when
    // there is none or it was deactivated (push_token_revoked_reason says
    // why). A token belongs to one install, so it is on at most one row.
    pushToken: text("push_token"),
    pushTokenRegisteredAt: timestamptz("push_token_registered_at"),
    pushTokenRevokedAt: timestamptz("push_token_revoked_at"),
    pushTokenRevokedReason: devicePushRevocation("push_token_revoked_reason"),
    // Last time Expo accepted a notification for the token, and the last
    // provider error code (never message content).
    pushLastSuccessAt: timestamptz("push_last_success_at"),
    pushLastErrorCode: text("push_last_error_code"),
    pushLastErrorAt: timestamptz("push_last_error_at"),

    lastActiveAt: timestamptz("last_active_at"),

    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),

    revokedAt: timestamptz("revoked_at"),
  },
  (t) => [
    foreignKey({
      name: "devices_user_id_fkey",
      columns: [t.userId],
      foreignColumns: [users.id],
    }).onDelete("cascade"),

    index("devices_user_id_idx").on(t.userId),
    index("devices_active_idx")
      .on(t.userId)
      .where(sql`${t.revokedAt} IS NULL`),
    uniqueIndex("devices_push_token_unique")
      .on(t.pushToken)
      .where(sql`${t.pushToken} IS NOT NULL`),
    check(
      "devices_push_token_format_check",
      sql`${t.pushToken} IS NULL OR (char_length(${t.pushToken}) <= 255 AND ${t.pushToken} ~ '^(Expo|Exponent)PushToken\\[[A-Za-z0-9_:.-]+\\]$')`,
    ),
  ],
);

export type Device = typeof devices.$inferSelect;
export type NewDevice = typeof devices.$inferInsert;
