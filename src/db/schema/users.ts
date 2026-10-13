import { sql } from "drizzle-orm";
import {
  check,
  date,
  foreignKey,
  index,
  pgEnum,
  pgTable,
  type PgTableExtraConfigValue,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { mediaUploads } from "./media.js";
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

    // Profile photo: a verified 'profile_photo' upload and its avatar-sized
    // thumbnail, always set together. Who may download them is decided by
    // privacy_settings.profile_photo_visibility and blocks.
    photoUploadId: uuid("photo_upload_id"),
    photoThumbnailUploadId: uuid("photo_thumbnail_upload_id"),

    status: userStatus("status").notNull().default("active"),

    lastSeenAt: timestamptz("last_seen_at"),

    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
    deletedAt: timestamptz("deleted_at"),
  },
  // Annotated: users and media_uploads reference each other, which TS
  // can't infer through.
  (t): PgTableExtraConfigValue[] => [
    check("users_phone_number_e164_check", sql`${t.phoneNumber} ~ '^\\+[1-9][0-9]{6,14}$'`),
    check(
      "users_date_of_birth_range_check",
      sql`${t.dateOfBirth} IS NULL OR ${t.dateOfBirth} >= DATE '1900-01-01'`,
    ),

    foreignKey({
      name: "users_photo_upload_id_fkey",
      columns: [t.photoUploadId],
      foreignColumns: [mediaUploads.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "users_photo_thumbnail_upload_id_fkey",
      columns: [t.photoThumbnailUploadId],
      foreignColumns: [mediaUploads.id],
    }).onDelete("restrict"),
    check(
      "users_photo_pair_check",
      sql`(${t.photoUploadId} IS NULL) = (${t.photoThumbnailUploadId} IS NULL)`,
    ),

    uniqueIndex("users_phone_number_unique").on(t.phoneNumber),
    uniqueIndex("users_username_unique")
      .on(sql`lower(${t.username})`)
      .where(sql`${t.username} IS NOT NULL`),
    index("users_status_idx").on(t.status),
    index("users_photo_upload_idx")
      .on(t.photoUploadId)
      .where(sql`${t.photoUploadId} IS NOT NULL`),
    index("users_photo_thumbnail_upload_idx")
      .on(t.photoThumbnailUploadId)
      .where(sql`${t.photoThumbnailUploadId} IS NOT NULL`),
  ],
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
