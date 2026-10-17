-- ============================================================
-- BROADCAST
-- Migration 014: Client-side E2EE for message attachments
--
-- Message attachment bytes are encrypted on device before the
-- presigned PUT. The server stores only ciphertext and must not
-- sniff plaintext MIME magic. Logical mimeType remains for UI.
-- File decryption keys stay in the OpenE2EE message envelope,
-- never in this column or in S3 object metadata.
-- ============================================================

ALTER TABLE media_uploads
  ADD COLUMN content_encrypted BOOLEAN NOT NULL DEFAULT FALSE;

-- Marker only (algorithm / segment size). Never store file keys here.
COMMENT ON COLUMN message_attachments.encryption_metadata IS
  'Opaque client E2EE file metadata marker; keys live in the protocol envelope.';
