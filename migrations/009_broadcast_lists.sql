-- ============================================================
-- BROADCAST
-- Migration 009: Broadcast lists
--
-- A broadcast list is a saved set of recipients owned by one user. It is
-- not a conversation: sending to a list writes one ordinary direct
-- message per recipient, in the recipient's existing (or newly created)
-- direct chat with the sender.
--
-- broadcast_messages is the send operation; broadcast_message_recipients
-- is its recipient snapshot, taken under the list lock when the send is
-- accepted, and maps each recipient to the direct message written for
-- them (message_id). The direct message is the only durable copy of the
-- body: broadcast_messages.ciphertext is kept only while a recipient is
-- pending or retryable, then cleared.
--
-- Recipient status ('pending' is the queued state):
--   pending   accepted, direct message not yet written
--   sent      direct message committed (message_id set)
--   delivered recipient's delivered pointer passed that message
--   read      recipient's read pointer passed that message (reported
--             only while both users allow read receipts)
--   failed    failure_code set; retryable says whether a retry may help
-- Status only moves forward (pending -> sent -> delivered -> read); only a
-- retry moves a retryable failure back to pending.
--
-- Deleting a list sets deleted_at. The list, its members and its history
-- stop being readable through the API; the direct messages already sent
-- and their recipient records are kept.
-- ============================================================

-- ------------------------------------------------------------
-- Lists: idempotent creation, mute, soft deletion
-- ------------------------------------------------------------

ALTER TABLE broadcast_lists
    -- Client-generated key so a retried "create list" returns the list
    -- created by the first attempt.
    ADD COLUMN client_request_id UUID,
    ADD COLUMN muted BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN deleted_at TIMESTAMPTZ;

UPDATE broadcast_lists SET name = left(name, 100) WHERE char_length(name) > 100;

ALTER TABLE broadcast_lists
    ADD CONSTRAINT broadcast_lists_name_length
        CHECK (char_length(name) <= 100);

CREATE UNIQUE INDEX broadcast_lists_owner_request_unique
    ON broadcast_lists (owner_id, client_request_id)
    WHERE client_request_id IS NOT NULL;

-- The owner's active lists.
DROP INDEX IF EXISTS broadcast_lists_owner_idx;
CREATE INDEX broadcast_lists_owner_active_idx
    ON broadcast_lists (owner_id, updated_at DESC)
    WHERE deleted_at IS NULL;

-- ------------------------------------------------------------
-- Broadcast messages: transient body, sending device, completion
-- ------------------------------------------------------------

ALTER TABLE broadcast_messages
    ALTER COLUMN ciphertext DROP NOT NULL,
    -- Recorded as the sending device of every direct message written.
    ADD COLUMN sender_device_id UUID
        REFERENCES devices(id)
        ON DELETE SET NULL,
    -- Set once no recipient is pending; cleared when a retry re-queues.
    ADD COLUMN completed_at TIMESTAMPTZ;

-- ------------------------------------------------------------
-- Recipients: direct-message mapping, attempts, failure metadata
-- ------------------------------------------------------------

ALTER TABLE broadcast_message_recipients
    RENAME COLUMN failure_reason TO failure_code;

ALTER TABLE broadcast_message_recipients
    -- client_message_id of the recipient's direct message, fixed when the
    -- broadcast is accepted, so re-processing can never write a second one.
    ADD COLUMN client_message_id UUID NOT NULL DEFAULT gen_random_uuid(),
    ADD COLUMN message_id UUID
        REFERENCES messages(id)
        ON DELETE SET NULL,
    ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN last_attempt_at TIMESTAMPTZ,
    ADD COLUMN retryable BOOLEAN NOT NULL DEFAULT FALSE;

UPDATE broadcast_message_recipients
SET failure_code = 'DELIVERY_FAILED'
WHERE status = 'failed' AND failure_code IS NULL;

UPDATE broadcast_message_recipients
SET failure_code = NULL
WHERE status <> 'failed' AND failure_code IS NOT NULL;

ALTER TABLE broadcast_message_recipients
    ADD CONSTRAINT broadcast_recipients_attempts_check
        CHECK (attempt_count >= 0),
    ADD CONSTRAINT broadcast_recipients_failure_check
        CHECK ((status = 'failed') = (failure_code IS NOT NULL)),
    ADD CONSTRAINT broadcast_recipients_retryable_check
        CHECK (NOT retryable OR status = 'failed');

-- One recipient record per direct message.
CREATE UNIQUE INDEX broadcast_recipients_message_unique
    ON broadcast_message_recipients (message_id)
    WHERE message_id IS NOT NULL;

-- Pending work, for the dispatcher and its restart sweep.
DROP INDEX IF EXISTS broadcast_recipients_pending_idx;
CREATE INDEX broadcast_recipients_work_idx
    ON broadcast_message_recipients (broadcast_message_id)
    WHERE status = 'pending';

-- Receipt pointers in a direct chat -> the recipient records they advance.
CREATE INDEX broadcast_recipients_receipt_idx
    ON broadcast_message_recipients (target_chat_id, recipient_id)
    WHERE status IN ('sent', 'delivered');
