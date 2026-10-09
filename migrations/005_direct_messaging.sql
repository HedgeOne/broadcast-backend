-- ============================================================
-- BROADCAST
-- Migration 005: Direct messaging
--
-- Contact discovery matches SHA-256 hashes of E.164 phone numbers, so
-- clients never upload raw address-book numbers. The hash is derived from
-- users.phone_number and indexed for lookup.
-- ============================================================

ALTER TABLE users
    ADD COLUMN phone_number_sha256 BYTEA
        GENERATED ALWAYS AS (digest(phone_number, 'sha256')) STORED;

CREATE INDEX users_phone_number_sha256_idx
    ON users (phone_number_sha256)
    WHERE phone_number_sha256 IS NOT NULL;

-- ============================================================
-- USER REPORTS
--
-- Abuse reports for moderation. Message content is never attached:
-- bodies are end-to-end encrypted ciphertext.
-- ============================================================

CREATE TYPE user_report_reason AS ENUM (
    'spam',
    'harassment',
    'inappropriate',
    'impersonation',
    'other'
);

CREATE TABLE user_reports (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    reporter_id UUID NOT NULL
        REFERENCES users(id)
        ON DELETE CASCADE,

    reported_user_id UUID NOT NULL
        REFERENCES users(id)
        ON DELETE CASCADE,

    chat_id UUID
        REFERENCES chats(id)
        ON DELETE SET NULL,

    reason user_report_reason NOT NULL,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT user_reports_self_check
        CHECK (reporter_id <> reported_user_id)
);

CREATE INDEX user_reports_reported_user_idx
    ON user_reports (reported_user_id, created_at DESC);
