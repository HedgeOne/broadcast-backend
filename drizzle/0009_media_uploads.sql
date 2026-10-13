CREATE TYPE "public"."media_upload_status" AS ENUM('pending', 'ready', 'failed', 'deleted');--> statement-breakpoint
CREATE TABLE "media_uploads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid,
	"client_upload_id" uuid NOT NULL,
	"category" "attachment_type" NOT NULL,
	"mime_type" text NOT NULL,
	"file_name" text,
	"declared_size" bigint NOT NULL,
	"file_size" bigint,
	"storage_key" text NOT NULL,
	"width" integer,
	"height" integer,
	"duration_ms" integer,
	"status" "media_upload_status" DEFAULT 'pending' NOT NULL,
	"failure_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"upload_expires_at" timestamp with time zone NOT NULL,
	"finalized_at" timestamp with time zone,
	"attached_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"object_deleted_at" timestamp with time zone,
	CONSTRAINT "media_uploads_storage_key_key" UNIQUE("storage_key"),
	CONSTRAINT "media_uploads_declared_size_check" CHECK ("media_uploads"."declared_size" > 0),
	CONSTRAINT "media_uploads_file_size_check" CHECK ("media_uploads"."file_size" IS NULL OR "media_uploads"."file_size" > 0),
	CONSTRAINT "media_uploads_file_name_length" CHECK ("media_uploads"."file_name" IS NULL OR char_length("media_uploads"."file_name") <= 255),
	CONSTRAINT "media_uploads_dimensions_check" CHECK (("media_uploads"."width" IS NULL OR "media_uploads"."width" > 0) AND ("media_uploads"."height" IS NULL OR "media_uploads"."height" > 0)),
	CONSTRAINT "media_uploads_duration_check" CHECK ("media_uploads"."duration_ms" IS NULL OR "media_uploads"."duration_ms" >= 0),
	CONSTRAINT "media_uploads_ready_check" CHECK ("media_uploads"."status" <> 'ready' OR ("media_uploads"."file_size" IS NOT NULL AND "media_uploads"."finalized_at" IS NOT NULL)),
	CONSTRAINT "media_uploads_failure_check" CHECK (("media_uploads"."status" = 'failed') = ("media_uploads"."failure_code" IS NOT NULL)),
	CONSTRAINT "media_uploads_deleted_check" CHECK (("media_uploads"."status" = 'deleted') = ("media_uploads"."deleted_at" IS NOT NULL))
);
--> statement-breakpoint
DROP INDEX "message_attachments_message_idx";--> statement-breakpoint
ALTER TABLE "broadcast_messages" ADD COLUMN "attachment_upload_id" uuid;--> statement-breakpoint
ALTER TABLE "broadcast_messages" ADD COLUMN "thumbnail_upload_id" uuid;--> statement-breakpoint
ALTER TABLE "message_attachments" ADD COLUMN "upload_id" uuid;--> statement-breakpoint
ALTER TABLE "message_attachments" ADD COLUMN "thumbnail_upload_id" uuid;--> statement-breakpoint
ALTER TABLE "media_uploads" ADD CONSTRAINT "media_uploads_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "media_uploads_owner_client_unique" ON "media_uploads" USING btree ("owner_id","client_upload_id");--> statement-breakpoint
CREATE INDEX "media_uploads_cleanup_idx" ON "media_uploads" USING btree ("status","created_at") WHERE "media_uploads"."object_deleted_at" IS NULL;--> statement-breakpoint
ALTER TABLE "broadcast_messages" ADD CONSTRAINT "broadcast_messages_attachment_upload_id_fkey" FOREIGN KEY ("attachment_upload_id") REFERENCES "public"."media_uploads"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broadcast_messages" ADD CONSTRAINT "broadcast_messages_thumbnail_upload_id_fkey" FOREIGN KEY ("thumbnail_upload_id") REFERENCES "public"."media_uploads"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_attachments" ADD CONSTRAINT "message_attachments_upload_id_fkey" FOREIGN KEY ("upload_id") REFERENCES "public"."media_uploads"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_attachments" ADD CONSTRAINT "message_attachments_thumbnail_upload_id_fkey" FOREIGN KEY ("thumbnail_upload_id") REFERENCES "public"."media_uploads"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "broadcast_messages_attachment_upload_idx" ON "broadcast_messages" USING btree ("attachment_upload_id") WHERE "broadcast_messages"."attachment_upload_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "broadcast_messages_thumbnail_upload_idx" ON "broadcast_messages" USING btree ("thumbnail_upload_id") WHERE "broadcast_messages"."thumbnail_upload_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "message_attachments_message_unique" ON "message_attachments" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "message_attachments_upload_idx" ON "message_attachments" USING btree ("upload_id") WHERE "message_attachments"."upload_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "message_attachments_thumbnail_upload_idx" ON "message_attachments" USING btree ("thumbnail_upload_id") WHERE "message_attachments"."thumbnail_upload_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "broadcast_messages" ADD CONSTRAINT "broadcast_messages_thumbnail_check" CHECK ("broadcast_messages"."thumbnail_upload_id" IS NULL OR "broadcast_messages"."attachment_upload_id" IS NOT NULL);