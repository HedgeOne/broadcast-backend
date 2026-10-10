CREATE TABLE "group_invites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chat_id" uuid NOT NULL,
	"token_hash" "bytea" NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"max_uses" integer,
	"use_count" integer DEFAULT 0 NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "group_invites_token_hash_length" CHECK (octet_length("group_invites"."token_hash") = 32),
	CONSTRAINT "group_invites_max_uses_check" CHECK ("group_invites"."max_uses" IS NULL OR "group_invites"."max_uses" > 0),
	CONSTRAINT "group_invites_use_count_check" CHECK ("group_invites"."use_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "group_join_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chat_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"invite_id" uuid,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	"decided_by" uuid,
	CONSTRAINT "group_join_requests_status_check" CHECK ("group_join_requests"."status" IN ('pending', 'approved', 'rejected', 'cancelled'))
);
--> statement-breakpoint
CREATE TABLE "message_mentions" (
	"message_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	CONSTRAINT "message_mentions_pkey" PRIMARY KEY("message_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "group_members" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "group_members" CASCADE;--> statement-breakpoint
DROP INDEX "groups_invite_code_unique";--> statement-breakpoint
ALTER TABLE "user_reports" ALTER COLUMN "reported_user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_members" ADD COLUMN "removed_by" uuid;--> statement-breakpoint
ALTER TABLE "chat_members" ADD COLUMN "history_from_sequence" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "chats" ADD COLUMN "client_request_id" uuid;--> statement-breakpoint
ALTER TABLE "groups" ADD COLUMN "only_admins_can_add_members" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "groups" ADD COLUMN "invite_links_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "groups" ADD COLUMN "history_visible_to_new_members" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "groups" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "system_event" jsonb;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "deleted_by" uuid;--> statement-breakpoint
ALTER TABLE "user_reports" ADD COLUMN "message_id" uuid;--> statement-breakpoint
ALTER TABLE "group_invites" ADD CONSTRAINT "group_invites_chat_id_fkey" FOREIGN KEY ("chat_id") REFERENCES "public"."groups"("chat_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_invites" ADD CONSTRAINT "group_invites_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_join_requests" ADD CONSTRAINT "group_join_requests_chat_id_fkey" FOREIGN KEY ("chat_id") REFERENCES "public"."groups"("chat_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_join_requests" ADD CONSTRAINT "group_join_requests_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_join_requests" ADD CONSTRAINT "group_join_requests_invite_id_fkey" FOREIGN KEY ("invite_id") REFERENCES "public"."group_invites"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_join_requests" ADD CONSTRAINT "group_join_requests_decided_by_fkey" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_mentions" ADD CONSTRAINT "message_mentions_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_mentions" ADD CONSTRAINT "message_mentions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "group_invites_token_hash_unique" ON "group_invites" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "group_invites_one_active" ON "group_invites" USING btree ("chat_id") WHERE "group_invites"."revoked_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "group_join_requests_pending_unique" ON "group_join_requests" USING btree ("chat_id","user_id") WHERE "group_join_requests"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "group_join_requests_chat_pending_idx" ON "group_join_requests" USING btree ("chat_id","created_at") WHERE "group_join_requests"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "message_mentions_user_idx" ON "message_mentions" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "chat_members" ADD CONSTRAINT "chat_members_removed_by_fkey" FOREIGN KEY ("removed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_deleted_by_fkey" FOREIGN KEY ("deleted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_reports" ADD CONSTRAINT "user_reports_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "chat_members_one_owner" ON "chat_members" USING btree ("chat_id") WHERE "chat_members"."role" = 'owner' AND "chat_members"."left_at" IS NULL;--> statement-breakpoint
CREATE INDEX "chat_members_chat_active_idx" ON "chat_members" USING btree ("chat_id") WHERE "chat_members"."left_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "chats_creator_request_unique" ON "chats" USING btree ("created_by","client_request_id") WHERE "chats"."client_request_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "groups" DROP COLUMN "invite_code";--> statement-breakpoint
ALTER TABLE "chat_members" ADD CONSTRAINT "chat_members_history_check" CHECK ("chat_members"."history_from_sequence" >= 0);--> statement-breakpoint
ALTER TABLE "groups" ADD CONSTRAINT "groups_name_length" CHECK (char_length("groups"."name") <= 100);--> statement-breakpoint
ALTER TABLE "groups" ADD CONSTRAINT "groups_description_length" CHECK ("groups"."description" IS NULL OR char_length("groups"."description") <= 512);--> statement-breakpoint
ALTER TABLE "message_reactions" ADD CONSTRAINT "message_reactions_emoji_length" CHECK (char_length("message_reactions"."emoji") BETWEEN 1 AND 16);--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_system_event_check" CHECK (("messages"."type" = 'system') = ("messages"."system_event" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "user_reports" ADD CONSTRAINT "user_reports_target_check" CHECK ("user_reports"."reported_user_id" IS NOT NULL OR "user_reports"."chat_id" IS NOT NULL);--> statement-breakpoint
DROP TYPE "public"."group_member_status";