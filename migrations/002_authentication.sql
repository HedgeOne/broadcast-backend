-- ============================================================
-- BROADCAST
-- Migration 002: Authentication
--
-- Email is the first verified identifier; phone OTP comes later.
-- A user may hold either or both identifiers on the same row, so
-- verifying a phone later attaches to the existing user.
-- ============================================================

-- ============================================================
-- USER IDENTIFIERS
-- ============================================================

ALTER TABLE users
    ALTER COLUMN phone_number DROP NOT NULL;

ALTER TABLE users
    ADD COLUMN email TEXT,
    ADD COLUMN email_verified_at TIMESTAMPTZ;

-- Emails are normalised (trimmed, lowercased) by the application.
ALTER TABLE users
    ADD CONSTRAINT users_email_lowercase_check
        CHECK (email IS NULL OR email = lower(email));

ALTER TABLE users
    ADD CONSTRAINT users_identifier_present_check
        CHECK (email IS NOT NULL OR phone_number IS NOT NULL);

CREATE UNIQUE INDEX users_email_unique
    ON users (email);

-- ============================================================
-- VERIFICATION CHALLENGES
--
-- One row per code sent. Requesting a new code invalidates any
-- earlier active challenge for the same identifier.
-- Codes are stored only as keyed hashes.
-- ============================================================

CREATE TYPE verification_identifier_type AS ENUM (
    'email',
    'phone'
);

CREATE TABLE verification_challenges (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    identifier_type verification_identifier_type NOT NULL,

    -- Normalised email address or E.164 phone number.
    identifier TEXT NOT NULL,

    code_hash TEXT NOT NULL,

    expires_at TIMESTAMPTZ NOT NULL,

    attempt_count INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL,

    last_sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    consumed_at TIMESTAMPTZ,
    invalidated_at TIMESTAMPTZ,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT verification_challenges_attempts_check
        CHECK (
            max_attempts > 0
            AND attempt_count >= 0
            AND attempt_count <= max_attempts
        )
);

CREATE INDEX verification_challenges_active_idx
    ON verification_challenges (identifier_type, identifier, created_at DESC)
    WHERE consumed_at IS NULL AND invalidated_at IS NULL;

CREATE INDEX verification_challenges_expires_idx
    ON verification_challenges (expires_at);
