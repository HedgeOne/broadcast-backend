import { sql } from "drizzle-orm";
import { check, date, index, pgEnum, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { timestamptz } from "./types.js";

export const userStatus = pgEnum("user_status", ["active", "disabled", "deleted"]);

// updated_at is maintained by the set_updated_at() trigger.
// Inserting a user fires create_default_user_settings(), which creates
// the matching privacy_settings and user_settings rows.
export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    // The sign-in identifier, in E.164. Users are only created after the
    // number has been verified by OTP, so both columns are always set.
    phoneNumber: text("phone_number").notNull(),
    phoneNumberVerifiedAt: timestamptz("phone_number_verified_at").notNull(),

    displayName: text("display_name"),
    username: text("username"),

    // Collected at onboarding as a calendar date (YYYY-MM-DD, no time zone).
    // The minimum age is an application rule, not a constraint.
    dateOfBirth: date("date_of_birth", { mode: "string" }),

    // No FK yet: the media table does not exist.
    avatarMediaId: uuid("avatar_media_id"),

    status: userStatus("status").notNull().default("active"),

    lastSeenAt: timestamptz("last_seen_at"),

    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
    deletedAt: timestamptz("deleted_at"),
  },
  (t) => [
    check("users_phone_number_e164_check", sql`${t.phoneNumber} ~ '^\\+[1-9][0-9]{6,14}$'`),
    check(
      "users_date_of_birth_range_check",
      sql`${t.dateOfBirth} IS NULL OR ${t.dateOfBirth} >= DATE '1900-01-01'`,
    ),

    uniqueIndex("users_phone_number_unique").on(t.phoneNumber),
    uniqueIndex("users_username_unique")
      .on(sql`lower(${t.username})`)
      .where(sql`${t.username} IS NOT NULL`),
    index("users_status_idx").on(t.status),
  ],
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
