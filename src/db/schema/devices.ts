import { sql } from "drizzle-orm";
import { foreignKey, index, pgEnum, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { timestamptz } from "./types.js";
import { users } from "./users.js";

export const devicePlatform = pgEnum("device_platform", ["ios", "android"]);

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

    pushToken: text("push_token"),

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
  ],
);

export type Device = typeof devices.$inferSelect;
export type NewDevice = typeof devices.$inferInsert;
