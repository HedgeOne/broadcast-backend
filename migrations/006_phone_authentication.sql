-- ============================================================
-- BROADCAST
-- Migration 006: Phone number authentication
--
-- Sign-in moves from email OTP to mobile OTP. The phone number (E.164)
-- becomes the required, unique account identifier and email is removed
-- from the schema entirely; it had no use outside authentication.
--
-- Cutover policy:
--   * Accounts without a verified E.164 phone number cannot sign in any
--     more, so they are deleted together with the content they own
--     (chats they created, messages and broadcasts they sent, pins they
--     made). Their devices and sessions cascade.
--   * Every remaining session is revoked, so all users sign in again
--     through the phone flow and receive tokens issued under it.
-- ============================================================

CREATE TEMPORARY TABLE retired_users ON COMMIT DROP AS
    SELECT id
    FROM users
    WHERE phone_number IS NULL
       OR phone_number_verified_at IS NULL
       OR phone_number !~ '^\+[1-9][0-9]{6,14}$';

-- These references are ON DELETE RESTRICT, so they are cleared first.
-- Deleting a chat cascades to its members, messages and pins.
DELETE FROM chats
WHERE created_by IN (SELECT id FROM retired_users);

DELETE FROM pinned_messages
WHERE pinned_by IN (SELECT id FROM retired_users);

DELETE FROM messages
WHERE sender_id IN (SELECT id FROM retired_users);

DELETE FROM broadcast_messages
WHERE sender_id IN (SELECT id FROM retired_users);

DELETE FROM users
WHERE id IN (SELECT id FROM retired_users);

UPDATE sessions
SET revoked_at = now()
WHERE revoked_at IS NULL;

-- ------------------------------------------------------------
-- Schema
-- ------------------------------------------------------------

ALTER TABLE users DROP CONSTRAINT users_email_lowercase_check;
ALTER TABLE users DROP CONSTRAINT users_identifier_present_check;
DROP INDEX users_email_unique;

ALTER TABLE users DROP COLUMN email;
ALTER TABLE users DROP COLUMN email_verified_at;

ALTER TABLE users ALTER COLUMN phone_number SET NOT NULL;
ALTER TABLE users ALTER COLUMN phone_number_verified_at SET NOT NULL;

-- E.164: "+", a non-zero country code digit, 7–15 digits in total.
ALTER TABLE users
    ADD CONSTRAINT users_phone_number_e164_check
        CHECK (phone_number ~ '^\+[1-9][0-9]{6,14}$');
