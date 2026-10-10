-- ============================================================
-- BROADCAST
-- Migration 008: Groups
--
-- A group is a chats row (type 'group') plus its groups row. Membership,
-- role, read pointers and mute live in chat_members for every chat type,
-- so the unused group_members table (a second membership record) is
-- dropped. Lifecycle: left_at NULL = active; left_at set with removed_by
-- = removed by an admin; left_at set without removed_by = left.
--
-- Group system events (created, added, removed, role changes, settings
-- changes) are messages of type 'system' whose server-generated payload is
-- in system_event; clients cannot send them. They are the group's audit
-- trail, including ownership transfers.
--
-- Invite tokens are 32 random bytes; only their SHA-256 is stored.
-- ============================================================

-- ------------------------------------------------------------
-- group_members duplicated chat_members and was never written.
-- ------------------------------------------------------------

DROP TABLE IF EXISTS group_members;
DROP TYPE IF EXISTS group_member_status;

-- Replaced by group_invites (hashed, revocable, expiring tokens).
DROP INDEX IF EXISTS groups_invite_code_unique;
ALTER TABLE groups DROP COLUMN IF EXISTS invite_code;

-- ------------------------------------------------------------
-- Chats: idempotent creation
-- ------------------------------------------------------------

-- A client-generated key so a retried "create group" returns the group
-- created by the first attempt instead of creating a second one.
ALTER TABLE chats ADD COLUMN client_request_id UUID;

CREATE UNIQUE INDEX chats_creator_request_unique
    ON chats (created_by, client_request_id)
    WHERE client_request_id IS NOT NULL;

-- ------------------------------------------------------------
-- Groups: settings and status
-- ------------------------------------------------------------

ALTER TABLE groups
    ADD COLUMN only_admins_can_add_members BOOLEAN NOT NULL DEFAULT TRUE,
    ADD COLUMN invite_links_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    -- When false, people who join see only messages sent after they joined.
    ADD COLUMN history_visible_to_new_members BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN deleted_at TIMESTAMPTZ,
    ADD CONSTRAINT groups_name_length
        CHECK (char_length(name) <= 100),
    ADD CONSTRAINT groups_description_length
        CHECK (description IS NULL OR char_length(description) <= 512);

-- ------------------------------------------------------------
-- Chat members: lifecycle and history boundary
-- ------------------------------------------------------------

ALTER TABLE chat_members
    ADD COLUMN removed_by UUID
        REFERENCES users(id)
        ON DELETE SET NULL,
    -- Messages with a sequence at or below this are hidden from the member
    -- (history from before they joined, per the group's setting).
    ADD COLUMN history_from_sequence BIGINT NOT NULL DEFAULT 0,
    ADD CONSTRAINT chat_members_history_check
        CHECK (history_from_sequence >= 0);

-- At most one active owner per chat. The service never leaves an active
-- group without one (ownership moves atomically on transfer or leave).
CREATE UNIQUE INDEX chat_members_one_owner
    ON chat_members (chat_id)
    WHERE role = 'owner' AND left_at IS NULL;

-- Member lists and realtime fan-out.
CREATE INDEX chat_members_chat_active_idx
    ON chat_members (chat_id)
    WHERE left_at IS NULL;

-- ------------------------------------------------------------
-- Messages: system events, moderation, mentions
-- ------------------------------------------------------------

ALTER TABLE messages
    ADD COLUMN system_event JSONB,
    ADD COLUMN deleted_by UUID
        REFERENCES users(id)
        ON DELETE SET NULL,
    ADD CONSTRAINT messages_system_event_check
        CHECK ((type = 'system') = (system_event IS NOT NULL));

-- Mentioned members, validated against active membership on send. The
-- body stays opaque; this is the only mention data the server trusts.
CREATE TABLE message_mentions (
    message_id UUID NOT NULL
        REFERENCES messages(id)
        ON DELETE CASCADE,

    user_id UUID NOT NULL
        REFERENCES users(id)
        ON DELETE CASCADE,

    PRIMARY KEY (message_id, user_id)
);

CREATE INDEX message_mentions_user_idx
    ON message_mentions (user_id);

ALTER TABLE message_reactions
    ADD CONSTRAINT message_reactions_emoji_length
        CHECK (char_length(emoji) BETWEEN 1 AND 16);

-- ------------------------------------------------------------
-- Group invites
-- ------------------------------------------------------------

CREATE TABLE group_invites (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    chat_id UUID NOT NULL
        REFERENCES groups(chat_id)
        ON DELETE CASCADE,

    -- SHA-256 of the 32-byte random token. The token itself is shown to
    -- the admin once and never stored.
    token_hash BYTEA NOT NULL,

    created_by UUID NOT NULL
        REFERENCES users(id)
        ON DELETE CASCADE,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ,

    max_uses INTEGER,
    use_count INTEGER NOT NULL DEFAULT 0,

    revoked_at TIMESTAMPTZ,

    CONSTRAINT group_invites_token_hash_length
        CHECK (octet_length(token_hash) = 32),
    CONSTRAINT group_invites_max_uses_check
        CHECK (max_uses IS NULL OR max_uses > 0),
    CONSTRAINT group_invites_use_count_check
        CHECK (use_count >= 0)
);

CREATE UNIQUE INDEX group_invites_token_hash_unique
    ON group_invites (token_hash);

-- One live link per group; creating a new one revokes the old one.
CREATE UNIQUE INDEX group_invites_one_active
    ON group_invites (chat_id)
    WHERE revoked_at IS NULL;

-- ------------------------------------------------------------
-- Join requests (approval-required groups)
-- ------------------------------------------------------------

CREATE TABLE group_join_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    chat_id UUID NOT NULL
        REFERENCES groups(chat_id)
        ON DELETE CASCADE,

    user_id UUID NOT NULL
        REFERENCES users(id)
        ON DELETE CASCADE,

    invite_id UUID
        REFERENCES group_invites(id)
        ON DELETE SET NULL,

    status TEXT NOT NULL DEFAULT 'pending',

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    decided_at TIMESTAMPTZ,

    decided_by UUID
        REFERENCES users(id)
        ON DELETE SET NULL,

    CONSTRAINT group_join_requests_status_check
        CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled'))
);

CREATE UNIQUE INDEX group_join_requests_pending_unique
    ON group_join_requests (chat_id, user_id)
    WHERE status = 'pending';

CREATE INDEX group_join_requests_chat_pending_idx
    ON group_join_requests (chat_id, created_at)
    WHERE status = 'pending';

-- ------------------------------------------------------------
-- Reports: groups and messages
-- ------------------------------------------------------------

-- A report concerns a user, a group, or both; message_id pins the message.
ALTER TABLE user_reports
    ALTER COLUMN reported_user_id DROP NOT NULL,
    ADD COLUMN message_id UUID
        REFERENCES messages(id)
        ON DELETE SET NULL,
    ADD CONSTRAINT user_reports_target_check
        CHECK (reported_user_id IS NOT NULL OR chat_id IS NOT NULL);
