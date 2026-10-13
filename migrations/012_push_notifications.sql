-- ============================================================
-- BROADCAST
-- Migration 012: Push notifications and timed mutes
--
-- Device tokens: an Expo push token is registered for the device of the
-- authenticated session and stored in devices.push_token (the column and
-- its unique index exist since 001 but were never written). A token
-- addresses one app install, so it lives on at most one device row; when
-- another account registers the same install, the old row's token is
-- revoked ('replaced'). Signing out revokes the session's token
-- ('logout'). Tokens the provider reports as unregistered are revoked
-- ('invalid').
--
-- Outbox: every user message (direct, group, and the direct messages a
-- broadcast creates) inserts one notification_jobs row in the same
-- transaction as the message. A rolled-back message therefore never
-- produces a push, and a committed one is never lost: workers claim due
-- jobs with FOR UPDATE SKIP LOCKED, and a crashed worker's claim lapses
-- (locked_until) so another claims it again. message_id is unique, so a
-- message has exactly one logical notification.
--
-- When a job is processed its recipients are resolved from the database
-- as it is then: current members other than the sender, who can see the
-- message, whose account is active, who have notifications enabled, who
-- have no active mute for the chat (muted_until > NOW(), server time),
-- and between whom and the sender there is no block in either direction.
-- Each recipient device with a token and a live session gets one
-- push_deliveries row (unique per job and device).
--
-- Mutes: chat_members.muted_until (since 001) is now set to an expiry the
-- server computes (8 hours, 1 week) or 9999-12-31 for "Always". A mute is
-- active only while NOW() < muted_until, so expiry needs no job.
--
-- Rollback (the runner is forward-only; run by hand if ever needed):
--   DROP TABLE push_deliveries;
--   DROP TABLE notification_jobs;
--   DROP TYPE push_delivery_status;
--   DROP TYPE notification_job_status;
--   DROP INDEX chat_members_muted_until_idx;
--   ALTER TABLE devices DROP CONSTRAINT devices_push_token_format_check;
--   ALTER TABLE devices
--       DROP COLUMN push_token_registered_at,
--       DROP COLUMN push_token_revoked_at,
--       DROP COLUMN push_token_revoked_reason,
--       DROP COLUMN push_last_success_at,
--       DROP COLUMN push_last_error_code,
--       DROP COLUMN push_last_error_at;
--   DROP TYPE device_push_revocation;
-- ============================================================

-- Nothing wrote push_token before this migration; refuse to add the format
-- check over values of unknown origin.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM devices
        WHERE push_token IS NOT NULL
          AND (char_length(push_token) > 255
               OR push_token !~ '^(Expo|Exponent)PushToken\[[A-Za-z0-9_:.-]+\]$')
    ) THEN
        RAISE EXCEPTION 'devices.push_token has values that are not Expo push tokens';
    END IF;
END
$$;

-- ------------------------------------------------------------
-- Device push tokens
-- ------------------------------------------------------------

CREATE TYPE device_push_revocation AS ENUM ('unregistered', 'logout', 'replaced', 'invalid');

ALTER TABLE devices
    ADD COLUMN push_token_registered_at  TIMESTAMPTZ,
    ADD COLUMN push_token_revoked_at     TIMESTAMPTZ,
    ADD COLUMN push_token_revoked_reason device_push_revocation,
    ADD COLUMN push_last_success_at      TIMESTAMPTZ,
    ADD COLUMN push_last_error_code      TEXT,
    ADD COLUMN push_last_error_at        TIMESTAMPTZ;

ALTER TABLE devices
    ADD CONSTRAINT devices_push_token_format_check
    CHECK (push_token IS NULL OR (
        char_length(push_token) <= 255
        AND push_token ~ '^(Expo|Exponent)PushToken\[[A-Za-z0-9_:.-]+\]$'
    ));

-- ------------------------------------------------------------
-- Notification outbox
-- ------------------------------------------------------------

CREATE TYPE notification_job_status AS ENUM (
    'queued',
    'processing',
    'completed',
    'expired',
    'failed'
);

CREATE TABLE notification_jobs (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    message_id   UUID NOT NULL,
    chat_id      UUID NOT NULL,
    status       notification_job_status NOT NULL DEFAULT 'queued',
    attempts     INTEGER NOT NULL DEFAULT 0,
    available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    locked_until TIMESTAMPTZ,
    planned_at   TIMESTAMPTZ,
    last_error   TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ,

    CONSTRAINT notification_jobs_message_id_fkey
        FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
    CONSTRAINT notification_jobs_chat_id_fkey
        FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE,
    CONSTRAINT notification_jobs_attempts_check CHECK (attempts >= 0)
);

CREATE UNIQUE INDEX notification_jobs_message_unique ON notification_jobs (message_id);
CREATE INDEX notification_jobs_due_idx
    ON notification_jobs (available_at) WHERE status IN ('queued', 'processing');
CREATE INDEX notification_jobs_finished_idx
    ON notification_jobs (completed_at) WHERE completed_at IS NOT NULL;

-- ------------------------------------------------------------
-- Per-device deliveries
-- ------------------------------------------------------------

CREATE TYPE push_delivery_status AS ENUM (
    'pending',
    'accepted',
    'provider_delivered',
    'failed',
    'skipped'
);

CREATE TABLE push_deliveries (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id             UUID NOT NULL,
    device_id          UUID NOT NULL,
    user_id            UUID NOT NULL,
    token              TEXT NOT NULL,
    status             push_delivery_status NOT NULL DEFAULT 'pending',
    attempts           INTEGER NOT NULL DEFAULT 0,
    next_attempt_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ticket_id          TEXT,
    accepted_at        TIMESTAMPTZ,
    receipt_checked_at TIMESTAMPTZ,
    error_code         TEXT,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT push_deliveries_job_id_fkey
        FOREIGN KEY (job_id) REFERENCES notification_jobs(id) ON DELETE CASCADE,
    CONSTRAINT push_deliveries_device_id_fkey
        FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE,
    CONSTRAINT push_deliveries_user_id_fkey
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT push_deliveries_attempts_check CHECK (attempts >= 0)
);

CREATE UNIQUE INDEX push_deliveries_job_device_unique ON push_deliveries (job_id, device_id);
CREATE UNIQUE INDEX push_deliveries_ticket_unique
    ON push_deliveries (ticket_id) WHERE ticket_id IS NOT NULL;
CREATE INDEX push_deliveries_pending_idx
    ON push_deliveries (job_id, next_attempt_at) WHERE status = 'pending';
CREATE INDEX push_deliveries_receipt_idx
    ON push_deliveries (accepted_at) WHERE status = 'accepted' AND receipt_checked_at IS NULL;
CREATE INDEX push_deliveries_device_idx ON push_deliveries (device_id);

-- ------------------------------------------------------------
-- Timed mutes
-- ------------------------------------------------------------

CREATE INDEX chat_members_muted_until_idx
    ON chat_members (muted_until) WHERE muted_until IS NOT NULL;
