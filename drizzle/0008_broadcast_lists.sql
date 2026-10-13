ALTER TABLE "broadcast_message_recipients" RENAME COLUMN "failure_reason" TO "failure_code";--> statement-breakpoint
DROP INDEX "broadcast_lists_owner_idx";--> statement-breakpoint
DROP INDEX "broadcast_recipients_pending_idx";--> statement-breakpoint
ALTER TABLE "broadcast_messages" ALTER COLUMN "ciphertext" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "broadcast_lists" ADD COLUMN "client_request_id" uuid;--> statement-breakpoint
ALTER TABLE "broadcast_lists" ADD COLUMN "muted" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "broadcast_lists" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "broadcast_message_recipients" ADD COLUMN "client_message_id" uuid DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
ALTER TABLE "broadcast_message_recipients" ADD COLUMN "message_id" uuid;--> statement-breakpoint
ALTER TABLE "broadcast_message_recipients" ADD COLUMN "attempt_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "broadcast_message_recipients" ADD COLUMN "last_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "broadcast_message_recipients" ADD COLUMN "retryable" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "broadcast_messages" ADD COLUMN "sender_device_id" uuid;--> statement-breakpoint
ALTER TABLE "broadcast_messages" ADD COLUMN "completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "broadcast_message_recipients" ADD CONSTRAINT "broadcast_message_recipients_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broadcast_messages" ADD CONSTRAINT "broadcast_messages_sender_device_id_fkey" FOREIGN KEY ("sender_device_id") REFERENCES "public"."devices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "broadcast_lists_owner_active_idx" ON "broadcast_lists" USING btree ("owner_id","updated_at" DESC NULLS FIRST) WHERE "broadcast_lists"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "broadcast_lists_owner_request_unique" ON "broadcast_lists" USING btree ("owner_id","client_request_id") WHERE "broadcast_lists"."client_request_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "broadcast_recipients_message_unique" ON "broadcast_message_recipients" USING btree ("message_id") WHERE "broadcast_message_recipients"."message_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "broadcast_recipients_work_idx" ON "broadcast_message_recipients" USING btree ("broadcast_message_id") WHERE "broadcast_message_recipients"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "broadcast_recipients_receipt_idx" ON "broadcast_message_recipients" USING btree ("target_chat_id","recipient_id") WHERE "broadcast_message_recipients"."status" IN ('sent', 'delivered');--> statement-breakpoint
ALTER TABLE "broadcast_lists" ADD CONSTRAINT "broadcast_lists_name_length" CHECK (char_length("broadcast_lists"."name") <= 100);--> statement-breakpoint
ALTER TABLE "broadcast_message_recipients" ADD CONSTRAINT "broadcast_recipients_attempts_check" CHECK ("broadcast_message_recipients"."attempt_count" >= 0);--> statement-breakpoint
ALTER TABLE "broadcast_message_recipients" ADD CONSTRAINT "broadcast_recipients_failure_check" CHECK (("broadcast_message_recipients"."status" = 'failed') = ("broadcast_message_recipients"."failure_code" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "broadcast_message_recipients" ADD CONSTRAINT "broadcast_recipients_retryable_check" CHECK (NOT "broadcast_message_recipients"."retryable" OR "broadcast_message_recipients"."status" = 'failed');