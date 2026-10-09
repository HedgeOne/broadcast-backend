CREATE TYPE "public"."verification_identifier_type" AS ENUM('email', 'phone');--> statement-breakpoint
CREATE TABLE "verification_challenges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"identifier_type" "verification_identifier_type" NOT NULL,
	"identifier" text NOT NULL,
	"code_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer NOT NULL,
	"last_sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	"consumed_at" timestamp with time zone,
	"invalidated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "verification_challenges_attempts_check" CHECK ("verification_challenges"."max_attempts" > 0 AND "verification_challenges"."attempt_count" >= 0 AND "verification_challenges"."attempt_count" <= "verification_challenges"."max_attempts")
);
--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "phone_number" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "email" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "email_verified_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "verification_challenges_active_idx" ON "verification_challenges" USING btree ("identifier_type","identifier","created_at" DESC NULLS FIRST) WHERE "verification_challenges"."consumed_at" IS NULL AND "verification_challenges"."invalidated_at" IS NULL;--> statement-breakpoint
CREATE INDEX "verification_challenges_expires_idx" ON "verification_challenges" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_unique" ON "users" USING btree ("email");--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_email_lowercase_check" CHECK ("users"."email" IS NULL OR "users"."email" = lower("users"."email"));--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_identifier_present_check" CHECK ("users"."email" IS NOT NULL OR "users"."phone_number" IS NOT NULL);