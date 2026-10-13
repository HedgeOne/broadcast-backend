CREATE TYPE "public"."media_purpose" AS ENUM('attachment', 'profile_photo', 'group_photo', 'broadcast_list_photo');--> statement-breakpoint
CREATE TYPE "public"."profile_photo_visibility" AS ENUM('everyone', 'nobody');--> statement-breakpoint
ALTER TABLE "broadcast_lists" ADD COLUMN "photo_upload_id" uuid;--> statement-breakpoint
ALTER TABLE "broadcast_lists" ADD COLUMN "photo_thumbnail_upload_id" uuid;--> statement-breakpoint
ALTER TABLE "groups" ADD COLUMN "photo_upload_id" uuid;--> statement-breakpoint
ALTER TABLE "groups" ADD COLUMN "photo_thumbnail_upload_id" uuid;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "photo_upload_id" uuid;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "photo_thumbnail_upload_id" uuid;--> statement-breakpoint
ALTER TABLE "media_uploads" ADD COLUMN "purpose" "media_purpose" DEFAULT 'attachment' NOT NULL;--> statement-breakpoint
ALTER TABLE "privacy_settings" ADD COLUMN "profile_photo_visibility" "profile_photo_visibility" DEFAULT 'everyone' NOT NULL;--> statement-breakpoint
ALTER TABLE "broadcast_lists" ADD CONSTRAINT "broadcast_lists_photo_upload_id_fkey" FOREIGN KEY ("photo_upload_id") REFERENCES "public"."media_uploads"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broadcast_lists" ADD CONSTRAINT "broadcast_lists_photo_thumbnail_upload_id_fkey" FOREIGN KEY ("photo_thumbnail_upload_id") REFERENCES "public"."media_uploads"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "groups" ADD CONSTRAINT "groups_photo_upload_id_fkey" FOREIGN KEY ("photo_upload_id") REFERENCES "public"."media_uploads"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "groups" ADD CONSTRAINT "groups_photo_thumbnail_upload_id_fkey" FOREIGN KEY ("photo_thumbnail_upload_id") REFERENCES "public"."media_uploads"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_photo_upload_id_fkey" FOREIGN KEY ("photo_upload_id") REFERENCES "public"."media_uploads"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_photo_thumbnail_upload_id_fkey" FOREIGN KEY ("photo_thumbnail_upload_id") REFERENCES "public"."media_uploads"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "broadcast_lists_photo_upload_idx" ON "broadcast_lists" USING btree ("photo_upload_id") WHERE "broadcast_lists"."photo_upload_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "broadcast_lists_photo_thumbnail_upload_idx" ON "broadcast_lists" USING btree ("photo_thumbnail_upload_id") WHERE "broadcast_lists"."photo_thumbnail_upload_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "groups_photo_upload_idx" ON "groups" USING btree ("photo_upload_id") WHERE "groups"."photo_upload_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "groups_photo_thumbnail_upload_idx" ON "groups" USING btree ("photo_thumbnail_upload_id") WHERE "groups"."photo_thumbnail_upload_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "users_photo_upload_idx" ON "users" USING btree ("photo_upload_id") WHERE "users"."photo_upload_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "users_photo_thumbnail_upload_idx" ON "users" USING btree ("photo_thumbnail_upload_id") WHERE "users"."photo_thumbnail_upload_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "groups" DROP COLUMN "avatar_media_id";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "avatar_media_id";--> statement-breakpoint
ALTER TABLE "broadcast_lists" ADD CONSTRAINT "broadcast_lists_photo_pair_check" CHECK (("broadcast_lists"."photo_upload_id" IS NULL) = ("broadcast_lists"."photo_thumbnail_upload_id" IS NULL));--> statement-breakpoint
ALTER TABLE "groups" ADD CONSTRAINT "groups_photo_pair_check" CHECK (("groups"."photo_upload_id" IS NULL) = ("groups"."photo_thumbnail_upload_id" IS NULL));--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_photo_pair_check" CHECK (("users"."photo_upload_id" IS NULL) = ("users"."photo_thumbnail_upload_id" IS NULL));--> statement-breakpoint
ALTER TABLE "media_uploads" ADD CONSTRAINT "media_uploads_photo_category_check" CHECK ("media_uploads"."purpose" = 'attachment' OR "media_uploads"."category" = 'image');