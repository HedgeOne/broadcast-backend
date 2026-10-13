-- ============================================================
-- BROADCAST
-- Migration 011: Profile, group and broadcast-list photos
--
-- Photos reuse the media upload pipeline from 010. Each upload now
-- records its purpose, and photo uploads are stored under their own key
-- prefix (profile-photos/, group-photos/, broadcast-list-photos/) instead
-- of attachments/. Photos are never message attachments.
--
-- A user, group or broadcast list points at two verified uploads: the
-- cropped full image and an avatar-sized thumbnail. Both are set together
-- or not at all. Rows store upload references only, never URLs; download
-- URLs are short-lived and issued after an access check:
--   user photo   owner always; others only when the owner's
--                profile_photo_visibility allows it and neither side has
--                blocked the other
--   group photo  current members only
--   list photo   the list owner only (recipients never see it)
--
-- Replacing or removing a photo just clears or moves the reference. The
-- media sweeper deletes uploads nothing references any more, so a photo
-- object is never deleted while a row still points at it (the foreign
-- keys are ON DELETE RESTRICT).
--
-- profile_photo_visibility offers 'everyone' and 'nobody'. "My contacts"
-- is not offered: the server keeps no contact relationships (address
-- books are matched on request and never stored), so it couldn't be
-- enforced.
--
-- The unused avatar_media_id columns from 001 (never written, no FK) are
-- replaced by the new references.
-- ============================================================

-- Refuse to drop avatar_media_id if anything ever wrote to it.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM users WHERE avatar_media_id IS NOT NULL)
       OR EXISTS (SELECT 1 FROM groups WHERE avatar_media_id IS NOT NULL) THEN
        RAISE EXCEPTION 'avatar_media_id has data; migrate it before dropping';
    END IF;
END
$$;

-- ------------------------------------------------------------
-- Upload purpose
-- ------------------------------------------------------------

CREATE TYPE media_purpose AS ENUM (
    'attachment',
    'profile_photo',
    'group_photo',
    'broadcast_list_photo'
);

-- Existing uploads are all message attachments.
ALTER TABLE media_uploads
    ADD COLUMN purpose media_purpose NOT NULL DEFAULT 'attachment';

-- Photos are always images.
ALTER TABLE media_uploads
    ADD CONSTRAINT media_uploads_photo_category_check
    CHECK (purpose = 'attachment' OR category = 'image');

-- ------------------------------------------------------------
-- Profile photo visibility
-- ------------------------------------------------------------

CREATE TYPE profile_photo_visibility AS ENUM ('everyone', 'nobody');

ALTER TABLE privacy_settings
    ADD COLUMN profile_photo_visibility profile_photo_visibility NOT NULL DEFAULT 'everyone';

-- ------------------------------------------------------------
-- Users
-- ------------------------------------------------------------

ALTER TABLE users DROP COLUMN avatar_media_id;

ALTER TABLE users
    ADD COLUMN photo_upload_id           UUID,
    ADD COLUMN photo_thumbnail_upload_id UUID;

ALTER TABLE users
    ADD CONSTRAINT users_photo_upload_id_fkey
    FOREIGN KEY (photo_upload_id) REFERENCES media_uploads(id) ON DELETE RESTRICT;
ALTER TABLE users
    ADD CONSTRAINT users_photo_thumbnail_upload_id_fkey
    FOREIGN KEY (photo_thumbnail_upload_id) REFERENCES media_uploads(id) ON DELETE RESTRICT;
ALTER TABLE users
    ADD CONSTRAINT users_photo_pair_check
    CHECK ((photo_upload_id IS NULL) = (photo_thumbnail_upload_id IS NULL));

-- Cleanup asks "is this upload still referenced?".
CREATE INDEX users_photo_upload_idx
    ON users (photo_upload_id) WHERE photo_upload_id IS NOT NULL;
CREATE INDEX users_photo_thumbnail_upload_idx
    ON users (photo_thumbnail_upload_id) WHERE photo_thumbnail_upload_id IS NOT NULL;

-- ------------------------------------------------------------
-- Groups
-- ------------------------------------------------------------

ALTER TABLE groups DROP COLUMN avatar_media_id;

ALTER TABLE groups
    ADD COLUMN photo_upload_id           UUID,
    ADD COLUMN photo_thumbnail_upload_id UUID;

ALTER TABLE groups
    ADD CONSTRAINT groups_photo_upload_id_fkey
    FOREIGN KEY (photo_upload_id) REFERENCES media_uploads(id) ON DELETE RESTRICT;
ALTER TABLE groups
    ADD CONSTRAINT groups_photo_thumbnail_upload_id_fkey
    FOREIGN KEY (photo_thumbnail_upload_id) REFERENCES media_uploads(id) ON DELETE RESTRICT;
ALTER TABLE groups
    ADD CONSTRAINT groups_photo_pair_check
    CHECK ((photo_upload_id IS NULL) = (photo_thumbnail_upload_id IS NULL));

CREATE INDEX groups_photo_upload_idx
    ON groups (photo_upload_id) WHERE photo_upload_id IS NOT NULL;
CREATE INDEX groups_photo_thumbnail_upload_idx
    ON groups (photo_thumbnail_upload_id) WHERE photo_thumbnail_upload_id IS NOT NULL;

-- ------------------------------------------------------------
-- Broadcast lists
-- ------------------------------------------------------------

ALTER TABLE broadcast_lists
    ADD COLUMN photo_upload_id           UUID,
    ADD COLUMN photo_thumbnail_upload_id UUID;

ALTER TABLE broadcast_lists
    ADD CONSTRAINT broadcast_lists_photo_upload_id_fkey
    FOREIGN KEY (photo_upload_id) REFERENCES media_uploads(id) ON DELETE RESTRICT;
ALTER TABLE broadcast_lists
    ADD CONSTRAINT broadcast_lists_photo_thumbnail_upload_id_fkey
    FOREIGN KEY (photo_thumbnail_upload_id) REFERENCES media_uploads(id) ON DELETE RESTRICT;
ALTER TABLE broadcast_lists
    ADD CONSTRAINT broadcast_lists_photo_pair_check
    CHECK ((photo_upload_id IS NULL) = (photo_thumbnail_upload_id IS NULL));

CREATE INDEX broadcast_lists_photo_upload_idx
    ON broadcast_lists (photo_upload_id) WHERE photo_upload_id IS NOT NULL;
CREATE INDEX broadcast_lists_photo_thumbnail_upload_idx
    ON broadcast_lists (photo_thumbnail_upload_id) WHERE photo_thumbnail_upload_id IS NOT NULL;
