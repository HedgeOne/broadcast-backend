-- ============================================================
-- BROADCAST
-- Migration 001: Initial Database Schema
-- PostgreSQL 17
-- ============================================================

BEGIN;

-- ============================================================
-- EXTENSIONS
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ============================================================
-- ENUM TYPES
-- ============================================================

CREATE TYPE user_status AS ENUM (
    'active',
    'disabled',
    'deleted'
);

CREATE TYPE device_platform AS ENUM (
    'ios',
    'android'
);

CREATE TYPE chat_type AS ENUM (
    'direct',
    'group'
);

CREATE TYPE chat_member_role AS ENUM (
    'member',
    'admin',
    'owner'
);

CREATE TYPE message_type AS ENUM (
    'text',
    'image',
    'video',
    'document',
    'audio',
    'sticker',
    'gif',
    'system'
);

CREATE TYPE attachment_type AS ENUM (
    'image',
    'video',
    'document',
    'audio',
    'sticker'
);

CREATE TYPE group_member_status AS ENUM (
    'active',
    'left',
    'removed'
);

CREATE TYPE broadcast_recipient_status AS ENUM (
    'pending',
    'sent',
    'delivered',
    'read',
    'failed'
);

-- ============================================================
-- USERS
-- ============================================================

CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    phone_number TEXT NOT NULL,
    phone_number_verified_at TIMESTAMPTZ,

    display_name TEXT,
    username TEXT,

    avatar_media_id UUID,

    status user_status NOT NULL DEFAULT 'active',

    last_seen_at TIMESTAMPTZ,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX users_phone_number_unique
    ON users (phone_number);

CREATE UNIQUE INDEX users_username_unique
    ON users (LOWER(username))
    WHERE username IS NOT NULL;

CREATE INDEX users_status_idx
    ON users (status);

-- ============================================================
-- DEVICES
-- ============================================================

CREATE TABLE devices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    user_id UUID NOT NULL
        REFERENCES users(id)
        ON DELETE CASCADE,

    platform device_platform NOT NULL,

    device_name TEXT,

    app_version TEXT,
    os_version TEXT,

    push_token TEXT,

    last_active_at TIMESTAMPTZ,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    revoked_at TIMESTAMPTZ
);

CREATE INDEX devices_user_id_idx
    ON devices (user_id);

CREATE INDEX devices_active_idx
    ON devices (user_id)
    WHERE revoked_at IS NULL;

CREATE UNIQUE INDEX devices_push_token_unique
    ON devices (push_token)
    WHERE push_token IS NOT NULL;

-- ============================================================
-- DEVICE CRYPTOGRAPHIC IDENTITY
--
-- Foundation for Signal-style E2EE.
-- Cryptographic implementation comes later.
-- ============================================================

CREATE TABLE device_keys (
    device_id UUID PRIMARY KEY
        REFERENCES devices(id)
        ON DELETE CASCADE,

    identity_key_public BYTEA NOT NULL,

    signed_prekey_public BYTEA,
    signed_prekey_signature BYTEA,
    signed_prekey_id BIGINT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE one_time_prekeys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    device_id UUID NOT NULL
        REFERENCES devices(id)
        ON DELETE CASCADE,

    key_id BIGINT NOT NULL,
    public_key BYTEA NOT NULL,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    consumed_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX one_time_prekeys_device_key_unique
    ON one_time_prekeys (device_id, key_id);

CREATE INDEX one_time_prekeys_available_idx
    ON one_time_prekeys (device_id)
    WHERE consumed_at IS NULL;

-- ============================================================
-- SESSIONS
-- ============================================================

CREATE TABLE sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    user_id UUID NOT NULL
        REFERENCES users(id)
        ON DELETE CASCADE,

    device_id UUID NOT NULL
        REFERENCES devices(id)
        ON DELETE CASCADE,

    refresh_token_hash TEXT NOT NULL,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,

    revoked_at TIMESTAMPTZ,

    last_used_at TIMESTAMPTZ
);

CREATE INDEX sessions_user_id_idx
    ON sessions (user_id);

CREATE INDEX sessions_device_id_idx
    ON sessions (device_id);

CREATE INDEX sessions_active_idx
    ON sessions (device_id)
    WHERE revoked_at IS NULL;

-- ============================================================
-- CHATS
--
-- Direct and group conversations share this entity.
-- Broadcast lists are separate entities.
-- ============================================================

CREATE TABLE chats (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    type chat_type NOT NULL,

    created_by UUID NOT NULL
        REFERENCES users(id)
        ON DELETE RESTRICT,

    -- Used only for direct chats.
    -- Stored in canonical order via the unique index below.
    direct_user_a_id UUID
        REFERENCES users(id)
        ON DELETE CASCADE,

    direct_user_b_id UUID
        REFERENCES users(id)
        ON DELETE CASCADE,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    archived_at TIMESTAMPTZ,

    CONSTRAINT direct_chat_users_check
        CHECK (
            type = 'group'
            OR (
                direct_user_a_id IS NOT NULL
                AND direct_user_b_id IS NOT NULL
                AND direct_user_a_id <> direct_user_b_id
            )
        ),

    CONSTRAINT group_chat_users_check
        CHECK (
            type = 'direct'
            OR (
                direct_user_a_id IS NULL
                AND direct_user_b_id IS NULL
            )
        )
);

CREATE INDEX chats_created_by_idx
    ON chats (created_by);

CREATE INDEX chats_type_idx
    ON chats (type);

CREATE UNIQUE INDEX direct_chat_pair_unique
    ON chats (
        LEAST(direct_user_a_id, direct_user_b_id),
        GREATEST(direct_user_a_id, direct_user_b_id)
    )
    WHERE type = 'direct';

-- ============================================================
-- CHAT MEMBERS
-- ============================================================

CREATE TABLE chat_members (
    chat_id UUID NOT NULL
        REFERENCES chats(id)
        ON DELETE CASCADE,

    user_id UUID NOT NULL
        REFERENCES users(id)
        ON DELETE CASCADE,

    role chat_member_role NOT NULL DEFAULT 'member',

    joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    left_at TIMESTAMPTZ,

    -- Highest message sequence delivered to this member.
    last_delivered_sequence BIGINT NOT NULL DEFAULT 0,

    -- Highest message sequence read by this member.
    last_read_sequence BIGINT NOT NULL DEFAULT 0,

    muted_until TIMESTAMPTZ,

    disappearing_messages_seconds INTEGER,

    PRIMARY KEY (chat_id, user_id),

    CONSTRAINT chat_members_sequence_check
        CHECK (
            last_delivered_sequence >= 0
            AND last_read_sequence >= 0
            AND last_read_sequence <= last_delivered_sequence
        ),

    CONSTRAINT chat_members_disappearing_check
        CHECK (
            disappearing_messages_seconds IS NULL
            OR disappearing_messages_seconds > 0
        )
);

CREATE INDEX chat_members_user_id_idx
    ON chat_members (user_id);

CREATE INDEX chat_members_active_idx
    ON chat_members (user_id, chat_id)
    WHERE left_at IS NULL;

CREATE INDEX chat_members_user_recent_idx
    ON chat_members (user_id, joined_at DESC);

-- ============================================================
-- GROUPS
-- ============================================================

CREATE TABLE groups (
    chat_id UUID PRIMARY KEY
        REFERENCES chats(id)
        ON DELETE CASCADE,

    name TEXT NOT NULL,
    description TEXT,

    avatar_media_id UUID,

    invite_code TEXT,

    approval_required BOOLEAN NOT NULL DEFAULT FALSE,

    only_admins_can_message BOOLEAN NOT NULL DEFAULT FALSE,
    only_admins_can_edit_info BOOLEAN NOT NULL DEFAULT FALSE,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT groups_name_not_empty
        CHECK (length(trim(name)) > 0)
);

CREATE UNIQUE INDEX groups_invite_code_unique
    ON groups (invite_code)
    WHERE invite_code IS NOT NULL;

-- ============================================================
-- GROUP MEMBERS
-- ============================================================

CREATE TABLE group_members (
    chat_id UUID NOT NULL
        REFERENCES groups(chat_id)
        ON DELETE CASCADE,

    user_id UUID NOT NULL
        REFERENCES users(id)
        ON DELETE CASCADE,

    status group_member_status NOT NULL DEFAULT 'active',

    joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    left_at TIMESTAMPTZ,

    PRIMARY KEY (chat_id, user_id)
);

CREATE INDEX group_members_user_id_idx
    ON group_members (user_id);

-- ============================================================
-- MESSAGES
--
-- Messages are stored as opaque ciphertext.
-- The server should not depend on plaintext content.
-- ============================================================

CREATE TABLE messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    chat_id UUID NOT NULL
        REFERENCES chats(id)
        ON DELETE CASCADE,

    sender_id UUID NOT NULL
        REFERENCES users(id)
        ON DELETE RESTRICT,

    sender_device_id UUID
        REFERENCES devices(id)
        ON DELETE SET NULL,

    -- Client-generated idempotency key.
    client_message_id UUID NOT NULL,

    -- Monotonically increasing within a chat.
    sequence BIGINT NOT NULL,

    type message_type NOT NULL,

    ciphertext BYTEA NOT NULL,

    encrypted_metadata BYTEA,

    reply_to_message_id UUID
        REFERENCES messages(id)
        ON DELETE SET NULL,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    edited_at TIMESTAMPTZ,

    deleted_at TIMESTAMPTZ,

    expires_at TIMESTAMPTZ,

    CONSTRAINT messages_sequence_check
        CHECK (sequence > 0)
);

CREATE UNIQUE INDEX messages_chat_sequence_unique
    ON messages (chat_id, sequence);

CREATE UNIQUE INDEX messages_sender_client_id_unique
    ON messages (sender_device_id, client_message_id)
    WHERE sender_device_id IS NOT NULL;

CREATE INDEX messages_chat_sequence_idx
    ON messages (chat_id, sequence DESC);

CREATE INDEX messages_sender_idx
    ON messages (sender_id);

CREATE INDEX messages_reply_idx
    ON messages (reply_to_message_id);

CREATE INDEX messages_expires_idx
    ON messages (expires_at)
    WHERE expires_at IS NOT NULL;

-- ============================================================
-- MESSAGE ATTACHMENTS
-- ============================================================

CREATE TABLE message_attachments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    message_id UUID NOT NULL
        REFERENCES messages(id)
        ON DELETE CASCADE,

    type attachment_type NOT NULL,

    -- S3 object key.
    storage_key TEXT NOT NULL,

    mime_type TEXT NOT NULL,

    file_name TEXT,

    file_size BIGINT,

    width INTEGER,
    height INTEGER,

    duration_ms INTEGER,

    thumbnail_storage_key TEXT,

    -- Encrypted file metadata / encryption information.
    encryption_metadata BYTEA,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT message_attachments_file_size_check
        CHECK (
            file_size IS NULL OR file_size >= 0
        ),

    CONSTRAINT message_attachments_dimensions_check
        CHECK (
            (width IS NULL OR width > 0)
            AND
            (height IS NULL OR height > 0)
        ),

    CONSTRAINT message_attachments_duration_check
        CHECK (
            duration_ms IS NULL OR duration_ms >= 0
        )
);

CREATE INDEX message_attachments_message_idx
    ON message_attachments (message_id);

-- ============================================================
-- MESSAGE REACTIONS
-- ============================================================

CREATE TABLE message_reactions (
    message_id UUID NOT NULL
        REFERENCES messages(id)
        ON DELETE CASCADE,

    user_id UUID NOT NULL
        REFERENCES users(id)
        ON DELETE CASCADE,

    emoji TEXT NOT NULL,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    PRIMARY KEY (message_id, user_id)
);

CREATE INDEX message_reactions_message_idx
    ON message_reactions (message_id);

-- ============================================================
-- STARRED MESSAGES
-- ============================================================

CREATE TABLE starred_messages (
    user_id UUID NOT NULL
        REFERENCES users(id)
        ON DELETE CASCADE,

    message_id UUID NOT NULL
        REFERENCES messages(id)
        ON DELETE CASCADE,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    PRIMARY KEY (user_id, message_id)
);

-- ============================================================
-- PINNED MESSAGES
-- ============================================================

CREATE TABLE pinned_messages (
    chat_id UUID NOT NULL
        REFERENCES chats(id)
        ON DELETE CASCADE,

    message_id UUID NOT NULL
        REFERENCES messages(id)
        ON DELETE CASCADE,

    pinned_by UUID NOT NULL
        REFERENCES users(id)
        ON DELETE RESTRICT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    PRIMARY KEY (chat_id, message_id)
);

CREATE INDEX pinned_messages_chat_idx
    ON pinned_messages (chat_id);

-- ============================================================
-- BROADCAST LISTS
--
-- A broadcast list is NOT a group chat.
-- Recipients receive the resulting message in their normal
-- direct conversation with the sender.
-- ============================================================

CREATE TABLE broadcast_lists (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    owner_id UUID NOT NULL
        REFERENCES users(id)
        ON DELETE CASCADE,

    name TEXT NOT NULL,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT broadcast_lists_name_not_empty
        CHECK (length(trim(name)) > 0)
);

CREATE INDEX broadcast_lists_owner_idx
    ON broadcast_lists (owner_id);

-- ============================================================
-- BROADCAST LIST MEMBERS
-- ============================================================

CREATE TABLE broadcast_list_members (
    broadcast_list_id UUID NOT NULL
        REFERENCES broadcast_lists(id)
        ON DELETE CASCADE,

    user_id UUID NOT NULL
        REFERENCES users(id)
        ON DELETE CASCADE,

    added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    removed_at TIMESTAMPTZ,

    PRIMARY KEY (broadcast_list_id, user_id)
);

CREATE INDEX broadcast_list_members_user_idx
    ON broadcast_list_members (user_id);

CREATE INDEX broadcast_list_members_active_idx
    ON broadcast_list_members (broadcast_list_id, user_id)
    WHERE removed_at IS NULL;

-- ============================================================
-- BROADCAST MESSAGES
-- ============================================================

CREATE TABLE broadcast_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    broadcast_list_id UUID NOT NULL
        REFERENCES broadcast_lists(id)
        ON DELETE CASCADE,

    sender_id UUID NOT NULL
        REFERENCES users(id)
        ON DELETE RESTRICT,

    client_message_id UUID NOT NULL,

    type message_type NOT NULL,

    ciphertext BYTEA NOT NULL,

    encrypted_metadata BYTEA,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX broadcast_messages_client_id_unique
    ON broadcast_messages (sender_id, client_message_id);

CREATE INDEX broadcast_messages_list_idx
    ON broadcast_messages (broadcast_list_id, created_at DESC);

-- ============================================================
-- BROADCAST MESSAGE RECIPIENTS
--
-- One row per recipient for delivery/read state.
-- ============================================================

CREATE TABLE broadcast_message_recipients (
    broadcast_message_id UUID NOT NULL
        REFERENCES broadcast_messages(id)
        ON DELETE CASCADE,

    recipient_id UUID NOT NULL
        REFERENCES users(id)
        ON DELETE CASCADE,

    -- Recipient's normal direct chat with sender.
    target_chat_id UUID
        REFERENCES chats(id)
        ON DELETE SET NULL,

    status broadcast_recipient_status NOT NULL DEFAULT 'pending',

    sent_at TIMESTAMPTZ,
    delivered_at TIMESTAMPTZ,
    read_at TIMESTAMPTZ,

    failed_at TIMESTAMPTZ,
    failure_reason TEXT,

    PRIMARY KEY (broadcast_message_id, recipient_id)
);

CREATE INDEX broadcast_recipients_recipient_idx
    ON broadcast_message_recipients (recipient_id);

CREATE INDEX broadcast_recipients_chat_idx
    ON broadcast_message_recipients (target_chat_id);

CREATE INDEX broadcast_recipients_pending_idx
    ON broadcast_message_recipients (recipient_id, status)
    WHERE status IN ('pending', 'sent');

-- ============================================================
-- BLOCKED USERS
-- ============================================================

CREATE TABLE blocked_users (
    user_id UUID NOT NULL
        REFERENCES users(id)
        ON DELETE CASCADE,

    blocked_user_id UUID NOT NULL
        REFERENCES users(id)
        ON DELETE CASCADE,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    PRIMARY KEY (user_id, blocked_user_id),

    CONSTRAINT blocked_users_self_check
        CHECK (user_id <> blocked_user_id)
);

CREATE INDEX blocked_users_blocked_user_idx
    ON blocked_users (blocked_user_id);

-- ============================================================
-- PRIVACY SETTINGS
-- ============================================================

CREATE TABLE privacy_settings (
    user_id UUID PRIMARY KEY
        REFERENCES users(id)
        ON DELETE CASCADE,

    show_last_seen BOOLEAN NOT NULL DEFAULT TRUE,
    show_online_status BOOLEAN NOT NULL DEFAULT TRUE,
    show_read_receipts BOOLEAN NOT NULL DEFAULT TRUE,
    show_typing_indicator BOOLEAN NOT NULL DEFAULT TRUE,

    allow_group_invites BOOLEAN NOT NULL DEFAULT TRUE,

    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- USER SETTINGS
-- ============================================================

CREATE TABLE user_settings (
    user_id UUID PRIMARY KEY
        REFERENCES users(id)
        ON DELETE CASCADE,

    notifications_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    notification_preview_enabled BOOLEAN NOT NULL DEFAULT TRUE,

    media_auto_download_images BOOLEAN NOT NULL DEFAULT TRUE,
    media_auto_download_videos BOOLEAN NOT NULL DEFAULT FALSE,
    media_auto_download_documents BOOLEAN NOT NULL DEFAULT FALSE,

    read_receipts_enabled BOOLEAN NOT NULL DEFAULT TRUE,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- USER CONTACTS
--
-- Stores app-level contact relationships.
-- Device address books remain on-device.
-- ============================================================

CREATE TABLE user_contacts (
    user_id UUID NOT NULL
        REFERENCES users(id)
        ON DELETE CASCADE,

    contact_user_id UUID NOT NULL
        REFERENCES users(id)
        ON DELETE CASCADE,

    contact_name TEXT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    PRIMARY KEY (user_id, contact_user_id),

    CONSTRAINT user_contacts_self_check
        CHECK (user_id <> contact_user_id)
);

CREATE INDEX user_contacts_contact_idx
    ON user_contacts (contact_user_id);

-- ============================================================
-- UPDATED_AT TRIGGER
-- ============================================================

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;

CREATE TRIGGER users_set_updated_at
BEFORE UPDATE ON users
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER devices_set_updated_at
BEFORE UPDATE ON devices
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER device_keys_set_updated_at
BEFORE UPDATE ON device_keys
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER chats_set_updated_at
BEFORE UPDATE ON chats
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER groups_set_updated_at
BEFORE UPDATE ON groups
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER broadcast_lists_set_updated_at
BEFORE UPDATE ON broadcast_lists
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER privacy_settings_set_updated_at
BEFORE UPDATE ON privacy_settings
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER user_settings_set_updated_at
BEFORE UPDATE ON user_settings
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER user_contacts_set_updated_at
BEFORE UPDATE ON user_contacts
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

-- ============================================================
-- DEFAULT USER SETTINGS
-- ============================================================

CREATE OR REPLACE FUNCTION create_default_user_settings()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    INSERT INTO privacy_settings (user_id)
    VALUES (NEW.id);

    INSERT INTO user_settings (user_id)
    VALUES (NEW.id);

    RETURN NEW;
END;
$$;

CREATE TRIGGER users_create_default_settings
AFTER INSERT ON users
FOR EACH ROW
EXECUTE FUNCTION create_default_user_settings();

-- ============================================================
-- SCHEMA VERSION
-- ============================================================

CREATE TABLE schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO schema_migrations (version, name)
VALUES (1, 'initial_schema');

COMMIT;