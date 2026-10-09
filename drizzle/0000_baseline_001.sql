CREATE TYPE "public"."broadcast_recipient_status" AS ENUM('pending', 'sent', 'delivered', 'read', 'failed');--> statement-breakpoint
CREATE TYPE "public"."chat_member_role" AS ENUM('member', 'admin', 'owner');--> statement-breakpoint
CREATE TYPE "public"."chat_type" AS ENUM('direct', 'group');--> statement-breakpoint
CREATE TYPE "public"."device_platform" AS ENUM('ios', 'android');--> statement-breakpoint
CREATE TYPE "public"."group_member_status" AS ENUM('active', 'left', 'removed');--> statement-breakpoint
CREATE TYPE "public"."user_status" AS ENUM('active', 'disabled', 'deleted');--> statement-breakpoint
CREATE TYPE "public"."message_type" AS ENUM('text', 'image', 'video', 'document', 'audio', 'sticker', 'gif', 'system');--> statement-breakpoint
CREATE TYPE "public"."attachment_type" AS ENUM('image', 'video', 'document', 'audio', 'sticker');--> statement-breakpoint
CREATE TABLE "broadcast_list_members" (
	"broadcast_list_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone,
	CONSTRAINT "broadcast_list_members_pkey" PRIMARY KEY("broadcast_list_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "broadcast_lists" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "broadcast_lists_name_not_empty" CHECK (length(trim("broadcast_lists"."name")) > 0)
);
--> statement-breakpoint
CREATE TABLE "broadcast_message_recipients" (
	"broadcast_message_id" uuid NOT NULL,
	"recipient_id" uuid NOT NULL,
	"target_chat_id" uuid,
	"status" "broadcast_recipient_status" DEFAULT 'pending' NOT NULL,
	"sent_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"read_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"failure_reason" text,
	CONSTRAINT "broadcast_message_recipients_pkey" PRIMARY KEY("broadcast_message_id","recipient_id")
);
--> statement-breakpoint
CREATE TABLE "broadcast_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"broadcast_list_id" uuid NOT NULL,
	"sender_id" uuid NOT NULL,
	"client_message_id" uuid NOT NULL,
	"type" "message_type" NOT NULL,
	"ciphertext" "bytea" NOT NULL,
	"encrypted_metadata" "bytea",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_members" (
	"chat_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "chat_member_role" DEFAULT 'member' NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"left_at" timestamp with time zone,
	"last_delivered_sequence" bigint DEFAULT 0 NOT NULL,
	"last_read_sequence" bigint DEFAULT 0 NOT NULL,
	"muted_until" timestamp with time zone,
	"disappearing_messages_seconds" integer,
	CONSTRAINT "chat_members_pkey" PRIMARY KEY("chat_id","user_id"),
	CONSTRAINT "chat_members_sequence_check" CHECK ("chat_members"."last_delivered_sequence" >= 0 AND "chat_members"."last_read_sequence" >= 0 AND "chat_members"."last_read_sequence" <= "chat_members"."last_delivered_sequence"),
	CONSTRAINT "chat_members_disappearing_check" CHECK ("chat_members"."disappearing_messages_seconds" IS NULL OR "chat_members"."disappearing_messages_seconds" > 0)
);
--> statement-breakpoint
CREATE TABLE "chats" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" "chat_type" NOT NULL,
	"created_by" uuid NOT NULL,
	"direct_user_a_id" uuid,
	"direct_user_b_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "direct_chat_users_check" CHECK ("chats"."type" = 'group' OR ("chats"."direct_user_a_id" IS NOT NULL AND "chats"."direct_user_b_id" IS NOT NULL AND "chats"."direct_user_a_id" <> "chats"."direct_user_b_id")),
	CONSTRAINT "group_chat_users_check" CHECK ("chats"."type" = 'direct' OR ("chats"."direct_user_a_id" IS NULL AND "chats"."direct_user_b_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "device_keys" (
	"device_id" uuid PRIMARY KEY NOT NULL,
	"identity_key_public" "bytea" NOT NULL,
	"signed_prekey_public" "bytea",
	"signed_prekey_signature" "bytea",
	"signed_prekey_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "one_time_prekeys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"device_id" uuid NOT NULL,
	"key_id" bigint NOT NULL,
	"public_key" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"consumed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"platform" "device_platform" NOT NULL,
	"device_name" text,
	"app_version" text,
	"os_version" text,
	"push_token" text,
	"last_active_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "group_members" (
	"chat_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"status" "group_member_status" DEFAULT 'active' NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"left_at" timestamp with time zone,
	CONSTRAINT "group_members_pkey" PRIMARY KEY("chat_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "groups" (
	"chat_id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"avatar_media_id" uuid,
	"invite_code" text,
	"approval_required" boolean DEFAULT false NOT NULL,
	"only_admins_can_message" boolean DEFAULT false NOT NULL,
	"only_admins_can_edit_info" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "groups_name_not_empty" CHECK (length(trim("groups"."name")) > 0)
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"phone_number" text NOT NULL,
	"phone_number_verified_at" timestamp with time zone,
	"display_name" text,
	"username" text,
	"avatar_media_id" uuid,
	"status" "user_status" DEFAULT 'active' NOT NULL,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"refresh_token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"last_used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "message_reactions" (
	"message_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"emoji" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_reactions_pkey" PRIMARY KEY("message_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chat_id" uuid NOT NULL,
	"sender_id" uuid NOT NULL,
	"sender_device_id" uuid,
	"client_message_id" uuid NOT NULL,
	"sequence" bigint NOT NULL,
	"type" "message_type" NOT NULL,
	"ciphertext" "bytea" NOT NULL,
	"encrypted_metadata" "bytea",
	"reply_to_message_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"edited_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	CONSTRAINT "messages_sequence_check" CHECK ("messages"."sequence" > 0)
);
--> statement-breakpoint
CREATE TABLE "pinned_messages" (
	"chat_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"pinned_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pinned_messages_pkey" PRIMARY KEY("chat_id","message_id")
);
--> statement-breakpoint
CREATE TABLE "starred_messages" (
	"user_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "starred_messages_pkey" PRIMARY KEY("user_id","message_id")
);
--> statement-breakpoint
CREATE TABLE "message_attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_id" uuid NOT NULL,
	"type" "attachment_type" NOT NULL,
	"storage_key" text NOT NULL,
	"mime_type" text NOT NULL,
	"file_name" text,
	"file_size" bigint,
	"width" integer,
	"height" integer,
	"duration_ms" integer,
	"thumbnail_storage_key" text,
	"encryption_metadata" "bytea",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_attachments_file_size_check" CHECK ("message_attachments"."file_size" IS NULL OR "message_attachments"."file_size" >= 0),
	CONSTRAINT "message_attachments_dimensions_check" CHECK (("message_attachments"."width" IS NULL OR "message_attachments"."width" > 0) AND ("message_attachments"."height" IS NULL OR "message_attachments"."height" > 0)),
	CONSTRAINT "message_attachments_duration_check" CHECK ("message_attachments"."duration_ms" IS NULL OR "message_attachments"."duration_ms" >= 0)
);
--> statement-breakpoint
CREATE TABLE "blocked_users" (
	"user_id" uuid NOT NULL,
	"blocked_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "blocked_users_pkey" PRIMARY KEY("user_id","blocked_user_id"),
	CONSTRAINT "blocked_users_self_check" CHECK ("blocked_users"."user_id" <> "blocked_users"."blocked_user_id")
);
--> statement-breakpoint
CREATE TABLE "privacy_settings" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"show_last_seen" boolean DEFAULT true NOT NULL,
	"show_online_status" boolean DEFAULT true NOT NULL,
	"show_read_receipts" boolean DEFAULT true NOT NULL,
	"show_typing_indicator" boolean DEFAULT true NOT NULL,
	"allow_group_invites" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_contacts" (
	"user_id" uuid NOT NULL,
	"contact_user_id" uuid NOT NULL,
	"contact_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_contacts_pkey" PRIMARY KEY("user_id","contact_user_id"),
	CONSTRAINT "user_contacts_self_check" CHECK ("user_contacts"."user_id" <> "user_contacts"."contact_user_id")
);
--> statement-breakpoint
CREATE TABLE "user_settings" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"notifications_enabled" boolean DEFAULT true NOT NULL,
	"notification_preview_enabled" boolean DEFAULT true NOT NULL,
	"media_auto_download_images" boolean DEFAULT true NOT NULL,
	"media_auto_download_videos" boolean DEFAULT false NOT NULL,
	"media_auto_download_documents" boolean DEFAULT false NOT NULL,
	"read_receipts_enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "schema_migrations" (
	"version" integer PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"applied_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "broadcast_list_members" ADD CONSTRAINT "broadcast_list_members_broadcast_list_id_fkey" FOREIGN KEY ("broadcast_list_id") REFERENCES "public"."broadcast_lists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broadcast_list_members" ADD CONSTRAINT "broadcast_list_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broadcast_lists" ADD CONSTRAINT "broadcast_lists_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broadcast_message_recipients" ADD CONSTRAINT "broadcast_message_recipients_broadcast_message_id_fkey" FOREIGN KEY ("broadcast_message_id") REFERENCES "public"."broadcast_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broadcast_message_recipients" ADD CONSTRAINT "broadcast_message_recipients_recipient_id_fkey" FOREIGN KEY ("recipient_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broadcast_message_recipients" ADD CONSTRAINT "broadcast_message_recipients_target_chat_id_fkey" FOREIGN KEY ("target_chat_id") REFERENCES "public"."chats"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broadcast_messages" ADD CONSTRAINT "broadcast_messages_broadcast_list_id_fkey" FOREIGN KEY ("broadcast_list_id") REFERENCES "public"."broadcast_lists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broadcast_messages" ADD CONSTRAINT "broadcast_messages_sender_id_fkey" FOREIGN KEY ("sender_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_members" ADD CONSTRAINT "chat_members_chat_id_fkey" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_members" ADD CONSTRAINT "chat_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chats" ADD CONSTRAINT "chats_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chats" ADD CONSTRAINT "chats_direct_user_a_id_fkey" FOREIGN KEY ("direct_user_a_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chats" ADD CONSTRAINT "chats_direct_user_b_id_fkey" FOREIGN KEY ("direct_user_b_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_keys" ADD CONSTRAINT "device_keys_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "one_time_prekeys" ADD CONSTRAINT "one_time_prekeys_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_members" ADD CONSTRAINT "group_members_chat_id_fkey" FOREIGN KEY ("chat_id") REFERENCES "public"."groups"("chat_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_members" ADD CONSTRAINT "group_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "groups" ADD CONSTRAINT "groups_chat_id_fkey" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_reactions" ADD CONSTRAINT "message_reactions_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_reactions" ADD CONSTRAINT "message_reactions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_chat_id_fkey" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_sender_id_fkey" FOREIGN KEY ("sender_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_sender_device_id_fkey" FOREIGN KEY ("sender_device_id") REFERENCES "public"."devices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_reply_to_message_id_fkey" FOREIGN KEY ("reply_to_message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pinned_messages" ADD CONSTRAINT "pinned_messages_chat_id_fkey" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pinned_messages" ADD CONSTRAINT "pinned_messages_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pinned_messages" ADD CONSTRAINT "pinned_messages_pinned_by_fkey" FOREIGN KEY ("pinned_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "starred_messages" ADD CONSTRAINT "starred_messages_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "starred_messages" ADD CONSTRAINT "starred_messages_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_attachments" ADD CONSTRAINT "message_attachments_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blocked_users" ADD CONSTRAINT "blocked_users_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blocked_users" ADD CONSTRAINT "blocked_users_blocked_user_id_fkey" FOREIGN KEY ("blocked_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "privacy_settings" ADD CONSTRAINT "privacy_settings_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_contacts" ADD CONSTRAINT "user_contacts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_contacts" ADD CONSTRAINT "user_contacts_contact_user_id_fkey" FOREIGN KEY ("contact_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_settings" ADD CONSTRAINT "user_settings_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "broadcast_list_members_user_idx" ON "broadcast_list_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "broadcast_list_members_active_idx" ON "broadcast_list_members" USING btree ("broadcast_list_id","user_id") WHERE "broadcast_list_members"."removed_at" IS NULL;--> statement-breakpoint
CREATE INDEX "broadcast_lists_owner_idx" ON "broadcast_lists" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "broadcast_recipients_recipient_idx" ON "broadcast_message_recipients" USING btree ("recipient_id");--> statement-breakpoint
CREATE INDEX "broadcast_recipients_chat_idx" ON "broadcast_message_recipients" USING btree ("target_chat_id");--> statement-breakpoint
CREATE INDEX "broadcast_recipients_pending_idx" ON "broadcast_message_recipients" USING btree ("recipient_id","status") WHERE "broadcast_message_recipients"."status" IN ('pending', 'sent');--> statement-breakpoint
CREATE UNIQUE INDEX "broadcast_messages_client_id_unique" ON "broadcast_messages" USING btree ("sender_id","client_message_id");--> statement-breakpoint
CREATE INDEX "broadcast_messages_list_idx" ON "broadcast_messages" USING btree ("broadcast_list_id","created_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "chat_members_user_id_idx" ON "chat_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "chat_members_active_idx" ON "chat_members" USING btree ("user_id","chat_id") WHERE "chat_members"."left_at" IS NULL;--> statement-breakpoint
CREATE INDEX "chat_members_user_recent_idx" ON "chat_members" USING btree ("user_id","joined_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "chats_created_by_idx" ON "chats" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "chats_type_idx" ON "chats" USING btree ("type");--> statement-breakpoint
CREATE UNIQUE INDEX "direct_chat_pair_unique" ON "chats" USING btree (LEAST("direct_user_a_id", "direct_user_b_id"),GREATEST("direct_user_a_id", "direct_user_b_id")) WHERE "chats"."type" = 'direct';--> statement-breakpoint
CREATE UNIQUE INDEX "one_time_prekeys_device_key_unique" ON "one_time_prekeys" USING btree ("device_id","key_id");--> statement-breakpoint
CREATE INDEX "one_time_prekeys_available_idx" ON "one_time_prekeys" USING btree ("device_id") WHERE "one_time_prekeys"."consumed_at" IS NULL;--> statement-breakpoint
CREATE INDEX "devices_user_id_idx" ON "devices" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "devices_active_idx" ON "devices" USING btree ("user_id") WHERE "devices"."revoked_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "devices_push_token_unique" ON "devices" USING btree ("push_token") WHERE "devices"."push_token" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "group_members_user_id_idx" ON "group_members" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "groups_invite_code_unique" ON "groups" USING btree ("invite_code") WHERE "groups"."invite_code" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "users_phone_number_unique" ON "users" USING btree ("phone_number");--> statement-breakpoint
CREATE UNIQUE INDEX "users_username_unique" ON "users" USING btree (lower("username")) WHERE "users"."username" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "users_status_idx" ON "users" USING btree ("status");--> statement-breakpoint
CREATE INDEX "sessions_user_id_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_device_id_idx" ON "sessions" USING btree ("device_id");--> statement-breakpoint
CREATE INDEX "sessions_active_idx" ON "sessions" USING btree ("device_id") WHERE "sessions"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "message_reactions_message_idx" ON "message_reactions" USING btree ("message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_chat_sequence_unique" ON "messages" USING btree ("chat_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_sender_client_id_unique" ON "messages" USING btree ("sender_device_id","client_message_id") WHERE "messages"."sender_device_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "messages_chat_sequence_idx" ON "messages" USING btree ("chat_id","sequence" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "messages_sender_idx" ON "messages" USING btree ("sender_id");--> statement-breakpoint
CREATE INDEX "messages_reply_idx" ON "messages" USING btree ("reply_to_message_id");--> statement-breakpoint
CREATE INDEX "messages_expires_idx" ON "messages" USING btree ("expires_at") WHERE "messages"."expires_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "pinned_messages_chat_idx" ON "pinned_messages" USING btree ("chat_id");--> statement-breakpoint
CREATE INDEX "message_attachments_message_idx" ON "message_attachments" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "blocked_users_blocked_user_idx" ON "blocked_users" USING btree ("blocked_user_id");--> statement-breakpoint
CREATE INDEX "user_contacts_contact_idx" ON "user_contacts" USING btree ("contact_user_id");