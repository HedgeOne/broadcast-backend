ALTER TABLE "users" DROP CONSTRAINT "users_email_lowercase_check";--> statement-breakpoint
ALTER TABLE "users" DROP CONSTRAINT "users_identifier_present_check";--> statement-breakpoint
DROP INDEX "users_email_unique";--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "phone_number" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "phone_number_verified_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "email";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "email_verified_at";--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_phone_number_e164_check" CHECK ("users"."phone_number" ~ '^\+[1-9][0-9]{6,14}$');