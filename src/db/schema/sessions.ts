import { sql } from "drizzle-orm";
import { foreignKey, index, pgTable, text, uuid } from "drizzle-orm/pg-core";

import { devices } from "./devices.js";
import { timestamptz } from "./types.js";
import { users } from "./users.js";

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    userId: uuid("user_id").notNull(),
    deviceId: uuid("device_id").notNull(),

    refreshTokenHash: text("refresh_token_hash").notNull(),

    createdAt: timestamptz("created_at").notNull().defaultNow(),
    expiresAt: timestamptz("expires_at").notNull(),

    revokedAt: timestamptz("revoked_at"),

    lastUsedAt: timestamptz("last_used_at"),
  },
  (t) => [
    foreignKey({
      name: "sessions_user_id_fkey",
      columns: [t.userId],
      foreignColumns: [users.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "sessions_device_id_fkey",
      columns: [t.deviceId],
      foreignColumns: [devices.id],
    }).onDelete("cascade"),

    index("sessions_user_id_idx").on(t.userId),
    index("sessions_device_id_idx").on(t.deviceId),
    index("sessions_active_idx")
      .on(t.deviceId)
      .where(sql`${t.revokedAt} IS NULL`),
  ],
);

export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;
