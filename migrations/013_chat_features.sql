-- ============================================================
-- BROADCAST
-- Migration 013: Clear Chat, starred messages, shared content
--
-- Clear Chat is per member and never deletes messages:
-- chat_members.cleared_through_sequence records the highest sequence the
-- member cleared (taken under the chat lock, so it is exactly the last
-- message that existed). It is folded into history_from_sequence, which
-- every read path already uses to hide older messages from the member
-- (history, unread counts, previews, replies, attachments, notifications).
-- The marker only grows, and rejoining a group never lowers it.
-- cleared_at keeps a cleared direct chat in the member's chat list.
--
-- Broadcast lists get the same marker for the owner's list view:
-- broadcast_lists.cleared_through_seq against broadcast_messages.history_seq,
-- an identity column (commit-independent order of acceptance; existing
-- rows are numbered by created_at, id). Recipients' direct chats are not
-- touched by clearing a list.
--
-- starred_messages (since 001) gets an index on message_id for unstarring
-- every copy of a broadcast and for the cascade when a message is deleted.
-- Partial indexes serve a conversation's shared media and documents,
-- newest first.
--
-- Rollback (the runner is forward-only; run by hand if ever needed):
--   DROP INDEX starred_messages_message_idx;
--   DROP INDEX messages_chat_documents_idx;
--   DROP INDEX messages_chat_media_idx;
--   DROP INDEX broadcast_messages_list_seq_idx;
--   ALTER TABLE broadcast_messages DROP COLUMN history_seq;
--   ALTER TABLE broadcast_lists DROP CONSTRAINT broadcast_lists_cleared_check;
--   ALTER TABLE broadcast_lists DROP COLUMN cleared_through_seq, DROP COLUMN cleared_at;
--   ALTER TABLE chat_members DROP CONSTRAINT chat_members_cleared_check;
--   ALTER TABLE chat_members DROP COLUMN cleared_through_sequence, DROP COLUMN cleared_at;
-- history_from_sequence values raised by Clear Chat stay raised after a
-- rollback, so cleared history remains hidden.
-- ============================================================

ALTER TABLE chat_members
    ADD COLUMN cleared_through_sequence bigint DEFAULT 0 NOT NULL,
    ADD COLUMN cleared_at timestamp with time zone;
ALTER TABLE chat_members ADD CONSTRAINT chat_members_cleared_check
    CHECK (cleared_through_sequence >= 0 AND cleared_through_sequence <= history_from_sequence);

ALTER TABLE broadcast_lists
    ADD COLUMN cleared_through_seq bigint DEFAULT 0 NOT NULL,
    ADD COLUMN cleared_at timestamp with time zone;
ALTER TABLE broadcast_lists ADD CONSTRAINT broadcast_lists_cleared_check
    CHECK (cleared_through_seq >= 0);

ALTER TABLE broadcast_messages ADD COLUMN history_seq bigint;
UPDATE broadcast_messages bm SET history_seq = numbered.n
FROM (
    SELECT id, row_number() OVER (ORDER BY created_at, id) AS n FROM broadcast_messages
) numbered
WHERE numbered.id = bm.id;
ALTER TABLE broadcast_messages ALTER COLUMN history_seq SET NOT NULL;
ALTER TABLE broadcast_messages ALTER COLUMN history_seq ADD GENERATED ALWAYS AS IDENTITY
    (SEQUENCE NAME broadcast_messages_history_seq_seq INCREMENT BY 1 MINVALUE 1
     MAXVALUE 9223372036854775807 START WITH 1 CACHE 1);
SELECT setval(
    'broadcast_messages_history_seq_seq',
    COALESCE((SELECT MAX(history_seq) FROM broadcast_messages), 0) + 1,
    false
);

CREATE INDEX broadcast_messages_list_seq_idx
    ON broadcast_messages USING btree (broadcast_list_id, history_seq DESC NULLS FIRST);
CREATE INDEX messages_chat_media_idx
    ON messages USING btree (chat_id, sequence DESC NULLS FIRST)
    WHERE type IN ('image', 'video', 'audio') AND deleted_at IS NULL;
CREATE INDEX messages_chat_documents_idx
    ON messages USING btree (chat_id, sequence DESC NULLS FIRST)
    WHERE type = 'document' AND deleted_at IS NULL;
CREATE INDEX starred_messages_message_idx
    ON starred_messages USING btree (message_id);
