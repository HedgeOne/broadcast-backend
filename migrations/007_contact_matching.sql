-- ============================================================
-- BROADCAST
-- Migration 007: Contact matching by E.164 number
--
-- Contact matching now looks up normalised E.164 numbers directly on
-- users_phone_number_unique. Unsalted SHA-256 of a phone number is
-- trivially reversible by enumerating the number space, so the hashed
-- lookup offered no real privacy and is retired. The column was generated
-- from phone_number, so dropping it loses no data.
-- ============================================================

DROP INDEX IF EXISTS users_phone_number_sha256_idx;

ALTER TABLE users DROP COLUMN IF EXISTS phone_number_sha256;
