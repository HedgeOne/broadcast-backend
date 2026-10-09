CREATE TYPE "public"."user_report_reason" AS ENUM('spam', 'harassment', 'inappropriate', 'impersonation', 'other');--> statement-breakpoint
CREATE TABLE "user_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reporter_id" uuid NOT NULL,
	"reported_user_id" uuid NOT NULL,
	"chat_id" uuid,
	"reason" "user_report_reason" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_reports_self_check" CHECK ("user_reports"."reporter_id" <> "user_reports"."reported_user_id")
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "phone_number_sha256" "bytea" GENERATED ALWAYS AS (digest(phone_number, 'sha256')) STORED;--> statement-breakpoint
ALTER TABLE "user_reports" ADD CONSTRAINT "user_reports_reporter_id_fkey" FOREIGN KEY ("reporter_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_reports" ADD CONSTRAINT "user_reports_reported_user_id_fkey" FOREIGN KEY ("reported_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_reports" ADD CONSTRAINT "user_reports_chat_id_fkey" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "user_reports_reported_user_idx" ON "user_reports" USING btree ("reported_user_id","created_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "users_phone_number_sha256_idx" ON "users" USING btree ("phone_number_sha256") WHERE "users"."phone_number_sha256" IS NOT NULL;