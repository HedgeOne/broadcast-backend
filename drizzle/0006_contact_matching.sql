DROP INDEX "users_phone_number_sha256_idx";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "phone_number_sha256";