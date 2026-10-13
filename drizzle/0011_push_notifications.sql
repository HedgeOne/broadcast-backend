CREATE TYPE "public"."device_push_revocation" AS ENUM('unregistered', 'logout', 'replaced', 'invalid');--> statement-breakpoint
CREATE TYPE "public"."notification_job_status" AS ENUM('queued', 'processing', 'completed', 'expired', 'failed');--> statement-breakpoint
CREATE TYPE "public"."push_delivery_status" AS ENUM('pending', 'accepted', 'provider_delivered', 'failed', 'skipped');--> statement-breakpoint
CREATE TABLE "notification_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_id" uuid NOT NULL,
	"chat_id" uuid NOT NULL,
	"status" "notification_job_status" DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_until" timestamp with time zone,
	"planned_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "notification_jobs_attempts_check" CHECK ("notification_jobs"."attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "push_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"token" text NOT NULL,
	"status" "push_delivery_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ticket_id" text,
	"accepted_at" timestamp with time zone,
	"receipt_checked_at" timestamp with time zone,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "push_deliveries_attempts_check" CHECK ("push_deliveries"."attempts" >= 0)
);
--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "push_token_registered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "push_token_revoked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "push_token_revoked_reason" "device_push_revocation";--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "push_last_success_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "push_last_error_code" text;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "push_last_error_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "notification_jobs" ADD CONSTRAINT "notification_jobs_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_jobs" ADD CONSTRAINT "notification_jobs_chat_id_fkey" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_deliveries" ADD CONSTRAINT "push_deliveries_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "public"."notification_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_deliveries" ADD CONSTRAINT "push_deliveries_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_deliveries" ADD CONSTRAINT "push_deliveries_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "notification_jobs_message_unique" ON "notification_jobs" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "notification_jobs_due_idx" ON "notification_jobs" USING btree ("available_at") WHERE "notification_jobs"."status" IN ('queued', 'processing');--> statement-breakpoint
CREATE INDEX "notification_jobs_finished_idx" ON "notification_jobs" USING btree ("completed_at") WHERE "notification_jobs"."completed_at" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "push_deliveries_job_device_unique" ON "push_deliveries" USING btree ("job_id","device_id");--> statement-breakpoint
CREATE UNIQUE INDEX "push_deliveries_ticket_unique" ON "push_deliveries" USING btree ("ticket_id") WHERE "push_deliveries"."ticket_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "push_deliveries_pending_idx" ON "push_deliveries" USING btree ("job_id","next_attempt_at") WHERE "push_deliveries"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "push_deliveries_receipt_idx" ON "push_deliveries" USING btree ("accepted_at") WHERE "push_deliveries"."status" = 'accepted' AND "push_deliveries"."receipt_checked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "push_deliveries_device_idx" ON "push_deliveries" USING btree ("device_id");--> statement-breakpoint
CREATE INDEX "chat_members_muted_until_idx" ON "chat_members" USING btree ("muted_until") WHERE "chat_members"."muted_until" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_push_token_format_check" CHECK ("devices"."push_token" IS NULL OR (char_length("devices"."push_token") <= 255 AND "devices"."push_token" ~ '^(Expo|Exponent)PushToken\[[A-Za-z0-9_:.-]+\]$'));