ALTER TABLE "broadcast_lists" ADD COLUMN "cleared_through_seq" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "broadcast_lists" ADD COLUMN "cleared_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "broadcast_messages" ADD COLUMN "history_seq" bigint NOT NULL GENERATED ALWAYS AS IDENTITY (sequence name "broadcast_messages_history_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1);--> statement-breakpoint
ALTER TABLE "chat_members" ADD COLUMN "cleared_through_sequence" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_members" ADD COLUMN "cleared_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "broadcast_messages_list_seq_idx" ON "broadcast_messages" USING btree ("broadcast_list_id","history_seq" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "messages_chat_media_idx" ON "messages" USING btree ("chat_id","sequence" DESC NULLS FIRST) WHERE "messages"."type" IN ('image', 'video', 'audio') AND "messages"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "messages_chat_documents_idx" ON "messages" USING btree ("chat_id","sequence" DESC NULLS FIRST) WHERE "messages"."type" = 'document' AND "messages"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "starred_messages_message_idx" ON "starred_messages" USING btree ("message_id");--> statement-breakpoint
ALTER TABLE "broadcast_lists" ADD CONSTRAINT "broadcast_lists_cleared_check" CHECK ("broadcast_lists"."cleared_through_seq" >= 0);--> statement-breakpoint
ALTER TABLE "chat_members" ADD CONSTRAINT "chat_members_cleared_check" CHECK ("chat_members"."cleared_through_sequence" >= 0 AND "chat_members"."cleared_through_sequence" <= "chat_members"."history_from_sequence");