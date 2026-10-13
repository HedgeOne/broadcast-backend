import { sql, type SQL } from "drizzle-orm";

import type { Database } from "../../db/client.js";
import { messages, type Message, type MessageAttachment } from "../../db/schema/index.js";
import {
  findOrCreateDirectChat,
  lockChat,
  nextSequence,
  type Executor,
  type Tx,
} from "../chats/chat-tx.js";
import { insertAttachment, sharedMedia } from "../media/media.repository.js";
import { enqueueMessageNotification } from "../notifications/notifications.outbox.js";
import { photoIdFor } from "../photos/photos.access.js";
import type {
  BroadcastAttachmentDto,
  BroadcastDto,
  BroadcastListDto,
  BroadcastRecipientDto,
  DeliverySummary,
  RecipientReportDto,
  RecipientStatus,
} from "./broadcasts.types.js";
import { stateOf } from "./broadcasts.types.js";

function isoTimestamp(column: SQL): SQL {
  return sql`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
}

function ids(values: readonly string[]): SQL {
  return sql`${sql.param([...values])}::uuid[]`;
}

// After this many attempts a delivery error stops being retryable.
export const MAX_DELIVERY_ATTEMPTS = 5;

export interface LockedList {
  id: string;
  name: string;
  muted: boolean;
  photoUploadId: string | null;
  photoThumbnailUploadId: string | null;
}

export interface RecipientCheck {
  // Inactive, or has blocked the owner.
  unavailable: string[];
  // The owner blocked them; they can unblock to add.
  blockedByOwner: string[];
}

export interface NewListInput {
  ownerId: string;
  clientRequestId: string;
  name: string;
  recipientIds: string[];
}

export interface NewBroadcastInput {
  listId: string;
  senderId: string;
  senderDeviceId: string;
  clientMessageId: string;
  type: Message["type"];
  ciphertext: Buffer;
  // Claimed by the caller in the same transaction.
  attachmentUploadId: string | null;
  thumbnailUploadId: string | null;
}

// Why a recipient in the snapshot can't be sent to. RECIPIENT_UNAVAILABLE
// covers both an inactive account and one that blocked the owner, so a
// block is never revealed.
export type FailureCode = "RECIPIENT_UNAVAILABLE" | "BLOCKED" | "DELIVERY_FAILED";

export type DeliveryOutcome =
  | { kind: "skipped" }
  | { kind: "sent"; message: Message; attachment: MessageAttachment | null }
  | { kind: "failed"; code: FailureCode; retryable: boolean };

export interface ReceiptChange {
  broadcastId: string;
  listId: string;
  ownerId: string;
  // Whether the owner can see the change (read changes are hidden unless
  // both users allow read receipts).
  visible: boolean;
  // The owner can now see that the recipient read it.
  read: boolean;
}

interface Eligibility extends Record<string, unknown> {
  active: boolean;
  blocked_owner: boolean;
  blocked_by_owner: boolean;
}

// Classifies a recipient against the owner, as direct messaging would.
function failureOf(row: Eligibility): { code: FailureCode; retryable: boolean } | null {
  if (!row.active || row.blocked_owner) return { code: "RECIPIENT_UNAVAILABLE", retryable: false };
  if (row.blocked_by_owner) return { code: "BLOCKED", retryable: true };
  return null;
}

function eligibilityColumns(ownerId: SQL, userId: SQL): SQL {
  return sql`
    u.status = 'active' AS active,
    EXISTS (SELECT 1 FROM blocked_users b WHERE b.user_id = ${userId} AND b.blocked_user_id = ${ownerId})
      AS blocked_owner,
    EXISTS (SELECT 1 FROM blocked_users b WHERE b.user_id = ${ownerId} AND b.blocked_user_id = ${userId})
      AS blocked_by_owner`;
}

interface BroadcastRow extends Record<string, unknown> {
  id: string;
  list_id: string;
  client_message_id: string;
  type: Message["type"];
  body: Buffer | null;
  seq: string;
  in_history: boolean;
  starred: boolean;
  created_at: string;
  completed_at: string | null;
  upload_id: string | null;
  thumbnail_upload_id: string | null;
  u_type: Message["type"] | null;
  u_mime_type: string | null;
  u_file_name: string | null;
  u_file_size: string | null;
  u_width: number | null;
  u_height: number | null;
  u_duration_ms: number | null;
  u_ready: boolean | null;
  t_ready: boolean | null;
}

// A broadcast is starred when the owner starred any of the direct messages
// it was delivered as (the copies are what the owner's stars point at).
function starredBroadcast(ownerId: string): SQL {
  return sql`EXISTS (
    SELECT 1 FROM broadcast_message_recipients sr
    JOIN starred_messages s ON s.message_id = sr.message_id AND s.user_id = ${ownerId}
    WHERE sr.broadcast_message_id = bm.id
  )`;
}

// The owner's list view starts after the list's clear marker.
function afterClearMarker(listId: string): SQL {
  return sql`bm.history_seq > (
    SELECT cleared_through_seq FROM broadcast_lists WHERE id = ${listId}
  )`;
}

function broadcastAttachmentOf(row: BroadcastRow): BroadcastAttachmentDto | null {
  if (!row.upload_id || !row.u_type || !row.u_mime_type) return null;
  return {
    uploadId: row.upload_id,
    thumbnailUploadId: row.t_ready ? row.thumbnail_upload_id : null,
    type: row.u_type,
    mimeType: row.u_mime_type,
    fileName: row.u_file_name,
    fileSize: row.u_file_size === null ? null : Number(row.u_file_size),
    width: row.u_width,
    height: row.u_height,
    durationMs: row.u_duration_ms,
    available: row.u_ready === true,
  };
}

interface SummaryRow extends Record<string, unknown> {
  id: string;
  total: number;
  pending: number;
  accepted: number;
  delivered: number;
  read: number;
  failed: number;
  retryable: number;
}

function emptySummary(): DeliverySummary {
  return { total: 0, pending: 0, accepted: 0, delivered: 0, read: 0, failed: 0, retryable: 0 };
}

export class BroadcastsRepository {
  constructor(private readonly db: Database) {}

  get executor(): Database {
    return this.db;
  }

  transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.db.transaction(fn);
  }

  // ---- Lists ---------------------------------------------------------------

  // The owner's live list. `lock` takes the list row lock, which serialises
  // membership changes, renames, deletion and send acceptance.
  async findList(
    executor: Executor,
    ownerId: string,
    listId: string,
    lock = false,
  ): Promise<LockedList | undefined> {
    const result = await executor.execute<{
      id: string;
      name: string;
      muted: boolean;
      photo_upload_id: string | null;
      photo_thumbnail_upload_id: string | null;
    }>(sql`
      SELECT id, name, muted, photo_upload_id, photo_thumbnail_upload_id FROM broadcast_lists
      WHERE id = ${listId} AND owner_id = ${ownerId} AND deleted_at IS NULL
      ${lock ? sql`FOR UPDATE` : sql``}
    `);
    const row = result.rows[0];
    if (!row) return undefined;
    return {
      id: row.id,
      name: row.name,
      muted: row.muted,
      photoUploadId: row.photo_upload_id,
      photoThumbnailUploadId: row.photo_thumbnail_upload_id,
    };
  }

  async findCreatedByRequest(
    ownerId: string,
    clientRequestId: string,
  ): Promise<{ id: string; deleted: boolean } | undefined> {
    const result = await this.db.execute<{ id: string; deleted: boolean }>(sql`
      SELECT id, deleted_at IS NOT NULL AS deleted FROM broadcast_lists
      WHERE owner_id = ${ownerId} AND client_request_id = ${clientRequestId}
    `);
    return result.rows[0];
  }

  async checkRecipients(ownerId: string, userIds: string[]): Promise<RecipientCheck> {
    if (userIds.length === 0) return { unavailable: [], blockedByOwner: [] };
    const result = await this.db.execute<Eligibility & { id: string }>(sql`
      SELECT u.id, ${eligibilityColumns(sql`${ownerId}::uuid`, sql`u.id`)}
      FROM users u
      WHERE u.id = ANY(${ids(userIds)})
    `);
    const found = new Map(result.rows.map((row) => [row.id, row]));
    const unavailable: string[] = [];
    const blockedByOwner: string[] = [];
    for (const id of userIds) {
      const row = found.get(id);
      const failure = row ? failureOf(row) : { code: "RECIPIENT_UNAVAILABLE" };
      if (failure?.code === "RECIPIENT_UNAVAILABLE") unavailable.push(id);
      else if (failure?.code === "BLOCKED") blockedByOwner.push(id);
    }
    return { unavailable, blockedByOwner };
  }

  // Undefined when a concurrent request with the same key won.
  async insertList(tx: Tx, input: NewListInput): Promise<string | undefined> {
    const inserted = await tx.execute<{ id: string }>(sql`
      INSERT INTO broadcast_lists (owner_id, name, client_request_id)
      VALUES (${input.ownerId}, ${input.name}, ${input.clientRequestId})
      ON CONFLICT (owner_id, client_request_id) WHERE client_request_id IS NOT NULL
      DO NOTHING
      RETURNING id
    `);
    const id = inserted.rows[0]?.id;
    if (!id) return undefined;
    await this.addRecipients(tx, id, input.recipientIds);
    return id;
  }

  async activeRecipientIds(executor: Executor, listId: string): Promise<string[]> {
    const result = await executor.execute<{ user_id: string }>(sql`
      SELECT user_id FROM broadcast_list_members
      WHERE broadcast_list_id = ${listId} AND removed_at IS NULL
    `);
    return result.rows.map((row) => row.user_id);
  }

  // Adds new recipients and re-activates removed ones; current ones are
  // left as they are.
  async addRecipients(tx: Tx, listId: string, userIds: string[]): Promise<void> {
    if (userIds.length === 0) return;
    await tx.execute(sql`
      INSERT INTO broadcast_list_members (broadcast_list_id, user_id)
      SELECT ${listId}, id FROM unnest(${ids(userIds)}) AS id
      ON CONFLICT (broadcast_list_id, user_id) DO UPDATE
        SET removed_at = NULL, added_at = NOW()
        WHERE broadcast_list_members.removed_at IS NOT NULL
    `);
  }

  async removeRecipient(tx: Tx, listId: string, userId: string): Promise<boolean> {
    const result = await tx.execute(sql`
      UPDATE broadcast_list_members SET removed_at = NOW()
      WHERE broadcast_list_id = ${listId} AND user_id = ${userId} AND removed_at IS NULL
      RETURNING user_id
    `);
    return result.rows.length > 0;
  }

  async updateList(
    tx: Tx,
    listId: string,
    changes: { name?: string | undefined; muted?: boolean | undefined },
  ): Promise<void> {
    await tx.execute(sql`
      UPDATE broadcast_lists SET
        name = COALESCE(${changes.name ?? null}, name),
        muted = COALESCE(${changes.muted ?? null}::boolean, muted)
      WHERE id = ${listId}
    `);
  }

  // Bumps updated_at (set_updated_at trigger) after a membership change.
  async touchList(tx: Tx, listId: string): Promise<void> {
    await tx.execute(sql`UPDATE broadcast_lists SET name = name WHERE id = ${listId}`);
  }

  // Points the list at a claimed photo, or clears it. The previous photo's
  // uploads become unreferenced and media cleanup removes them.
  async setPhoto(
    tx: Tx,
    listId: string,
    photo: { uploadId: string; thumbnailUploadId: string } | null,
  ): Promise<void> {
    await tx.execute(sql`
      UPDATE broadcast_lists
      SET photo_upload_id = ${photo?.uploadId ?? null},
          photo_thumbnail_upload_id = ${photo?.thumbnailUploadId ?? null}
      WHERE id = ${listId}
    `);
  }

  // The photo is released for cleanup with the list.
  async softDelete(tx: Tx, listId: string): Promise<void> {
    await tx.execute(sql`
      UPDATE broadcast_lists
      SET deleted_at = NOW(), photo_upload_id = NULL, photo_thumbnail_upload_id = NULL
      WHERE id = ${listId}
    `);
  }

  // The owner's live lists, most recent activity first.
  async lists(ownerId: string, listId?: string): Promise<BroadcastListDto[]> {
    const result = await this.db.execute<{
      id: string;
      name: string;
      muted: boolean;
      photo_upload_id: string | null;
      created_at: string;
      updated_at: string;
      recipient_count: number;
      last_id: string | null;
      last_activity_at: string;
    }>(sql`
      SELECT l.id, l.name, l.muted, l.photo_upload_id,
        ${isoTimestamp(sql`l.created_at`)} AS created_at,
        ${isoTimestamp(sql`l.updated_at`)} AS updated_at,
        (SELECT COUNT(*)::int FROM broadcast_list_members m
         WHERE m.broadcast_list_id = l.id AND m.removed_at IS NULL) AS recipient_count,
        lb.id AS last_id,
        ${isoTimestamp(sql`COALESCE(lb.created_at, l.cleared_at, l.created_at)`)} AS last_activity_at
      FROM broadcast_lists l
      LEFT JOIN LATERAL (
        SELECT id, created_at FROM broadcast_messages
        WHERE broadcast_list_id = l.id AND history_seq > l.cleared_through_seq
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      ) lb ON TRUE
      WHERE l.owner_id = ${ownerId} AND l.deleted_at IS NULL
        ${listId ? sql`AND l.id = ${listId}` : sql``}
      ORDER BY COALESCE(lb.created_at, l.cleared_at, l.created_at) DESC, l.id
    `);
    const lastIds = result.rows.map((row) => row.last_id).filter((id) => id !== null);
    const broadcasts = await this.broadcasts(ownerId, lastIds);
    return result.rows.map((row) => ({
      id: row.id,
      name: row.name,
      photoId: row.photo_upload_id,
      recipientCount: row.recipient_count,
      muted: row.muted,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastActivityAt: row.last_activity_at,
      lastBroadcast: row.last_id ? (broadcasts.get(row.last_id) ?? null) : null,
    }));
  }

  // Current recipients. `available` is false for inactive accounts and
  // people the owner blocked; whether someone blocked the owner is never
  // shown.
  async recipients(ownerId: string, listId: string): Promise<BroadcastRecipientDto[]> {
    const result = await this.db.execute<{
      user_id: string;
      display_name: string | null;
      photo_id: string | null;
      available: boolean;
      added_at: string;
    }>(sql`
      SELECT m.user_id, u.display_name, ${photoIdFor(sql`u`, ownerId)} AS photo_id,
        (u.status = 'active' AND NOT EXISTS (
          SELECT 1 FROM blocked_users b WHERE b.user_id = ${ownerId} AND b.blocked_user_id = m.user_id
        )) AS available,
        ${isoTimestamp(sql`m.added_at`)} AS added_at
      FROM broadcast_list_members m
      JOIN users u ON u.id = m.user_id
      WHERE m.broadcast_list_id = ${listId} AND m.removed_at IS NULL
      ORDER BY lower(COALESCE(u.display_name, '')), m.user_id
    `);
    return result.rows.map((row) => ({
      userId: row.user_id,
      displayName: row.display_name,
      photoId: row.photo_id,
      available: row.available,
      addedAt: row.added_at,
    }));
  }

  // ---- Broadcasts ----------------------------------------------------------

  async findBroadcastByClientId(
    executor: Executor,
    senderId: string,
    clientMessageId: string,
  ): Promise<{ id: string; listId: string } | undefined> {
    const result = await executor.execute<{ id: string; list_id: string }>(sql`
      SELECT id, broadcast_list_id AS list_id FROM broadcast_messages
      WHERE sender_id = ${senderId} AND client_message_id = ${clientMessageId}
    `);
    const row = result.rows[0];
    return row ? { id: row.id, listId: row.list_id } : undefined;
  }

  async findBroadcast(
    ownerId: string,
    listId: string,
    broadcastId: string,
  ): Promise<BroadcastDto | undefined> {
    const result = await this.db.execute<{ id: string }>(sql`
      SELECT id FROM broadcast_messages
      WHERE id = ${broadcastId} AND broadcast_list_id = ${listId} AND sender_id = ${ownerId}
    `);
    if (result.rows.length === 0) return undefined;
    return (await this.broadcasts(ownerId, [broadcastId])).get(broadcastId);
  }

  // Accepts a send under the list lock (held by the caller): records the
  // operation and its recipient snapshot. Recipients who can't be sent to
  // right now are recorded as failed straight away.
  async accept(tx: Tx, input: NewBroadcastInput): Promise<string> {
    const candidates = await tx.execute<Eligibility & { user_id: string }>(sql`
      SELECT m.user_id, ${eligibilityColumns(sql`${input.senderId}::uuid`, sql`m.user_id`)}
      FROM broadcast_list_members m
      JOIN users u ON u.id = m.user_id
      WHERE m.broadcast_list_id = ${input.listId} AND m.removed_at IS NULL
    `);

    const [broadcast] = await tx
      .execute<{ id: string }>(
        sql`
        INSERT INTO broadcast_messages
          (broadcast_list_id, sender_id, sender_device_id, client_message_id, type, ciphertext,
           attachment_upload_id, thumbnail_upload_id)
        VALUES (${input.listId}, ${input.senderId}, ${input.senderDeviceId},
                ${input.clientMessageId}, ${input.type}, ${input.ciphertext},
                ${input.attachmentUploadId}, ${input.thumbnailUploadId})
        RETURNING id
      `,
      )
      .then((result) => result.rows);
    if (!broadcast) throw new Error("broadcast insert returned no row");

    const pending: string[] = [];
    const failed: { userId: string; code: FailureCode; retryable: boolean }[] = [];
    for (const row of candidates.rows) {
      const failure = failureOf(row);
      if (failure) failed.push({ userId: row.user_id, ...failure });
      else pending.push(row.user_id);
    }

    if (pending.length > 0) {
      await tx.execute(sql`
        INSERT INTO broadcast_message_recipients (broadcast_message_id, recipient_id)
        SELECT ${broadcast.id}, id FROM unnest(${ids(pending)}) AS id
      `);
    }
    for (const row of failed) {
      await tx.execute(sql`
        INSERT INTO broadcast_message_recipients
          (broadcast_message_id, recipient_id, status, failed_at, failure_code, retryable)
        VALUES (${broadcast.id}, ${row.userId}, 'failed', NOW(), ${row.code}, ${row.retryable})
      `);
    }
    return broadcast.id;
  }

  async pendingRecipientIds(broadcastId: string): Promise<string[]> {
    const result = await this.db.execute<{ recipient_id: string }>(sql`
      SELECT recipient_id FROM broadcast_message_recipients
      WHERE broadcast_message_id = ${broadcastId} AND status = 'pending'
      ORDER BY recipient_id
    `);
    return result.rows.map((row) => row.recipient_id);
  }

  // Writes one recipient's direct message. The recipient row is locked
  // (and skipped if another worker holds it) and must still be pending, and
  // the message, the mapping and the status change commit together, so a
  // recipient can never get two messages from one broadcast.
  async deliver(broadcastId: string, recipientId: string): Promise<DeliveryOutcome> {
    return this.db.transaction(async (tx) => {
      const claimed = await tx.execute<
        Eligibility & {
          client_message_id: string;
          sender_id: string;
          sender_device_id: string | null;
          type: Message["type"];
          ciphertext: Buffer | null;
          attachment_upload_id: string | null;
          thumbnail_upload_id: string | null;
        }
      >(sql`
        SELECT r.client_message_id, bm.sender_id, bm.sender_device_id, bm.type, bm.ciphertext,
          bm.attachment_upload_id, bm.thumbnail_upload_id,
          ${eligibilityColumns(sql`bm.sender_id`, sql`r.recipient_id`)}
        FROM broadcast_message_recipients r
        JOIN broadcast_messages bm ON bm.id = r.broadcast_message_id
        JOIN users u ON u.id = r.recipient_id
        WHERE r.broadcast_message_id = ${broadcastId} AND r.recipient_id = ${recipientId}
          AND r.status = 'pending'
        FOR UPDATE OF r SKIP LOCKED
      `);
      const row = claimed.rows[0];
      if (!row) return { kind: "skipped" } as const;

      // The shared upload stays verified while this recipient is pending
      // (cleanup treats it as referenced); anything else means it's gone.
      const media = row.attachment_upload_id
        ? await sharedMedia(tx, row.attachment_upload_id, row.thumbnail_upload_id)
        : null;
      const failure =
        failureOf(row) ??
        (!row.ciphertext || media === undefined
          ? { code: "DELIVERY_FAILED" as const, retryable: false }
          : null);
      if (failure) {
        await this.markFailed(tx, broadcastId, recipientId, failure.code, failure.retryable);
        return { kind: "failed", ...failure } as const;
      }

      const chatId = await findOrCreateDirectChat(tx, row.sender_id, recipientId);
      await lockChat(tx, chatId);
      const sequence = await nextSequence(tx, chatId);
      const [message] = await tx
        .insert(messages)
        .values({
          chatId,
          senderId: row.sender_id,
          senderDeviceId: row.sender_device_id,
          clientMessageId: row.client_message_id,
          sequence,
          type: row.type,
          ciphertext: row.ciphertext ?? Buffer.alloc(0),
        })
        .returning();
      if (!message) throw new Error("message insert returned no row");
      // Each recipient's message gets its own attachment row (access is
      // authorized through it), all pointing at the one stored object.
      const attachment = media ? await insertAttachment(tx, message.id, media) : null;
      // The recipient is notified like for any direct message; nothing
      // about the list reaches the push.
      await enqueueMessageNotification(tx, message);

      // As for any message: the sender has trivially received and read it.
      await tx.execute(sql`
        UPDATE chat_members
        SET last_delivered_sequence = GREATEST(last_delivered_sequence, ${sequence}),
            last_read_sequence = GREATEST(last_read_sequence, ${sequence})
        WHERE chat_id = ${chatId} AND user_id = ${row.sender_id} AND left_at IS NULL
      `);

      await tx.execute(sql`
        UPDATE broadcast_message_recipients SET
          status = 'sent', message_id = ${message.id}, target_chat_id = ${chatId},
          sent_at = NOW(), attempt_count = attempt_count + 1, last_attempt_at = NOW(),
          failed_at = NULL, failure_code = NULL, retryable = FALSE
        WHERE broadcast_message_id = ${broadcastId} AND recipient_id = ${recipientId}
      `);
      return { kind: "sent", message, attachment } as const;
    });
  }

  // Records a failed attempt on a pending recipient. Delivery errors stop
  // being retryable after MAX_DELIVERY_ATTEMPTS.
  async markFailed(
    executor: Executor,
    broadcastId: string,
    recipientId: string,
    code: FailureCode,
    retryable: boolean,
  ): Promise<void> {
    await executor.execute(sql`
      UPDATE broadcast_message_recipients SET
        status = 'failed', failure_code = ${code}, failed_at = NOW(),
        attempt_count = attempt_count + 1, last_attempt_at = NOW(),
        retryable = ${retryable} AND attempt_count + 1 < ${MAX_DELIVERY_ATTEMPTS}
      WHERE broadcast_message_id = ${broadcastId} AND recipient_id = ${recipientId}
        AND status = 'pending'
    `);
  }

  // Once nothing is pending: marks the broadcast complete and drops the
  // retained body if a direct message now carries it and no retry can need
  // it. Returns true only for the call that completed it.
  async finalize(broadcastId: string): Promise<boolean> {
    const result = await this.db.execute<{ was_completed: boolean }>(sql`
      WITH prev AS (
        SELECT id, completed_at IS NOT NULL AS was_completed FROM broadcast_messages
        WHERE id = ${broadcastId}
        FOR UPDATE
      )
      UPDATE broadcast_messages bm SET
        completed_at = COALESCE(bm.completed_at, NOW()),
        ciphertext = CASE
          WHEN NOT EXISTS (
            SELECT 1 FROM broadcast_message_recipients r
            WHERE r.broadcast_message_id = bm.id AND r.status = 'failed' AND r.retryable
          ) AND EXISTS (
            SELECT 1 FROM broadcast_message_recipients r
            WHERE r.broadcast_message_id = bm.id AND r.message_id IS NOT NULL
          ) THEN NULL
          ELSE bm.ciphertext
        END
      FROM prev
      WHERE bm.id = prev.id AND NOT EXISTS (
        SELECT 1 FROM broadcast_message_recipients r
        WHERE r.broadcast_message_id = bm.id AND r.status = 'pending'
      )
      RETURNING prev.was_completed
    `);
    const row = result.rows[0];
    return row !== undefined && !row.was_completed;
  }

  // Moves retryable failures back to pending. Returns how many.
  async requeueRetryable(tx: Tx, broadcastId: string): Promise<number> {
    const result = await tx.execute(sql`
      UPDATE broadcast_message_recipients SET
        status = 'pending', failure_code = NULL, failed_at = NULL, retryable = FALSE
      WHERE broadcast_message_id = ${broadcastId} AND status = 'failed' AND retryable
        AND EXISTS (
          SELECT 1 FROM broadcast_messages
          WHERE id = ${broadcastId} AND ciphertext IS NOT NULL
        )
      RETURNING recipient_id
    `);
    if (result.rows.length > 0) {
      await tx.execute(
        sql`UPDATE broadcast_messages SET completed_at = NULL WHERE id = ${broadcastId}`,
      );
    }
    return result.rows.length;
  }

  // Accepted broadcasts with recipients still pending, oldest first.
  async sweepCandidates(minAgeMs: number, limit: number): Promise<string[]> {
    const result = await this.db.execute<{ id: string }>(sql`
      SELECT bm.id FROM broadcast_messages bm
      WHERE EXISTS (
        SELECT 1 FROM broadcast_message_recipients r
        WHERE r.broadcast_message_id = bm.id AND r.status = 'pending'
      )
        AND bm.created_at <= NOW() - make_interval(secs => ${minAgeMs / 1000})
      ORDER BY bm.created_at
      LIMIT ${limit}
    `);
    return result.rows.map((row) => row.id);
  }

  async broadcastOwner(
    broadcastId: string,
  ): Promise<{ listId: string; ownerId: string; listDeleted: boolean } | undefined> {
    const result = await this.db.execute<{
      list_id: string;
      owner_id: string;
      list_deleted: boolean;
    }>(sql`
      SELECT bm.broadcast_list_id AS list_id, bm.sender_id AS owner_id,
        l.deleted_at IS NOT NULL AS list_deleted
      FROM broadcast_messages bm
      JOIN broadcast_lists l ON l.id = bm.broadcast_list_id
      WHERE bm.id = ${broadcastId}
    `);
    const row = result.rows[0];
    return row
      ? { listId: row.list_id, ownerId: row.owner_id, listDeleted: row.list_deleted }
      : undefined;
  }

  // ---- Reading history -----------------------------------------------------

  // Broadcast DTOs by id, with summaries as the owner may see them.
  async broadcasts(ownerId: string, broadcastIds: string[]): Promise<Map<string, BroadcastDto>> {
    const map = new Map<string, BroadcastDto>();
    if (broadcastIds.length === 0) return map;

    const [rows, summaries] = await Promise.all([
      this.db.execute<BroadcastRow>(sql`
        SELECT bm.id, bm.broadcast_list_id AS list_id, bm.client_message_id, bm.type,
          COALESCE(bm.ciphertext, (
            SELECT m.ciphertext FROM broadcast_message_recipients r
            JOIN messages m ON m.id = r.message_id
            WHERE r.broadcast_message_id = bm.id AND m.deleted_at IS NULL
            LIMIT 1
          )) AS body,
          bm.history_seq AS seq,
          bm.history_seq > l.cleared_through_seq AS in_history,
          ${starredBroadcast(ownerId)} AS starred,
          ${isoTimestamp(sql`bm.created_at`)} AS created_at,
          CASE WHEN bm.completed_at IS NULL THEN NULL
               ELSE ${isoTimestamp(sql`bm.completed_at`)} END AS completed_at,
          bm.attachment_upload_id AS upload_id, bm.thumbnail_upload_id,
          u.category::text AS u_type, u.mime_type AS u_mime_type, u.file_name AS u_file_name,
          u.file_size AS u_file_size, u.width AS u_width, u.height AS u_height,
          u.duration_ms AS u_duration_ms, u.status = 'ready' AS u_ready, t.status = 'ready' AS t_ready
        FROM broadcast_messages bm
        JOIN broadcast_lists l ON l.id = bm.broadcast_list_id
        LEFT JOIN media_uploads u ON u.id = bm.attachment_upload_id
        LEFT JOIN media_uploads t ON t.id = bm.thumbnail_upload_id
        WHERE bm.id = ANY(${ids(broadcastIds)}) AND bm.sender_id = ${ownerId}
      `),
      this.summaries(ownerId, broadcastIds),
    ]);

    for (const row of rows.rows) {
      const summary = summaries.get(row.id) ?? emptySummary();
      map.set(row.id, {
        id: row.id,
        listId: row.list_id,
        clientMessageId: row.client_message_id,
        sequence: Number(row.seq),
        type: row.type,
        ciphertext: row.body ? row.body.toString("base64") : "",
        starred: row.starred,
        inHistory: row.in_history,
        createdAt: row.created_at,
        completedAt: row.completed_at,
        state: stateOf(summary),
        summary,
        attachment: broadcastAttachmentOf(row),
      });
    }
    return map;
  }

  private async summaries(
    ownerId: string,
    broadcastIds: string[],
  ): Promise<Map<string, DeliverySummary>> {
    const result = await this.db.execute<SummaryRow>(sql`
      SELECT r.broadcast_message_id AS id,
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE r.status = 'pending')::int AS pending,
        COUNT(*) FILTER (WHERE r.status IN ('sent', 'delivered', 'read'))::int AS accepted,
        COUNT(*) FILTER (WHERE r.status IN ('delivered', 'read'))::int AS delivered,
        COUNT(*) FILTER (
          WHERE r.status = 'read' AND COALESCE(rp.show_read_receipts, TRUE) AND (
            SELECT COALESCE(BOOL_AND(show_read_receipts), TRUE) FROM privacy_settings
            WHERE user_id = ${ownerId}
          )
        )::int AS read,
        COUNT(*) FILTER (WHERE r.status = 'failed')::int AS failed,
        COUNT(*) FILTER (WHERE r.status = 'failed' AND r.retryable)::int AS retryable
      FROM broadcast_message_recipients r
      LEFT JOIN privacy_settings rp ON rp.user_id = r.recipient_id
      WHERE r.broadcast_message_id = ANY(${ids(broadcastIds)})
      GROUP BY r.broadcast_message_id
    `);
    return new Map(
      result.rows.map((row) => [
        row.id,
        {
          total: row.total,
          pending: row.pending,
          accepted: row.accepted,
          delivered: row.delivered,
          read: row.read,
          failed: row.failed,
          retryable: row.retryable,
        },
      ]),
    );
  }

  // A page of the list's history, oldest first. `before` pages backwards
  // from a broadcast id; without it the latest page is returned.
  async history(
    ownerId: string,
    listId: string,
    options: { before?: string | undefined; limit: number },
  ): Promise<{ broadcasts: BroadcastDto[]; hasMore: boolean }> {
    const result = await this.db.execute<{ id: string }>(sql`
      SELECT bm.id FROM broadcast_messages bm
      WHERE bm.broadcast_list_id = ${listId} AND bm.sender_id = ${ownerId}
        AND ${afterClearMarker(listId)}
        ${
          options.before
            ? sql`AND (bm.created_at, bm.id) < (
                SELECT created_at, id FROM broadcast_messages
                WHERE id = ${options.before} AND broadcast_list_id = ${listId}
              )`
            : sql``
        }
      ORDER BY bm.created_at DESC, bm.id DESC
      LIMIT ${options.limit + 1}
    `);
    const page = result.rows.slice(0, options.limit).map((row) => row.id);
    const dtos = await this.broadcasts(ownerId, page);
    return {
      broadcasts: page
        .reverse()
        .map((id) => dtos.get(id))
        .filter((dto) => dto !== undefined),
      hasMore: result.rows.length > options.limit,
    };
  }

  private async page(
    ownerId: string,
    rows: { id: string }[],
    limit: number,
  ): Promise<{ broadcasts: BroadcastDto[]; hasMore: boolean }> {
    const page = rows.slice(0, limit).map((row) => row.id);
    const dtos = await this.broadcasts(ownerId, page);
    return {
      broadcasts: page.map((id) => dtos.get(id)).filter((dto) => dto !== undefined),
      hasMore: rows.length > limit,
    };
  }

  // Media or documents the owner broadcast to the list, newest first by
  // sequence, after the list's clear marker. Files are the owner's uploads
  // (fetched through GET /media/uploads/:id/url); removed files are left out.
  async shared(
    ownerId: string,
    listId: string,
    options: { kind: "media" | "docs"; before?: number | undefined; limit: number },
  ): Promise<{ broadcasts: BroadcastDto[]; hasMore: boolean }> {
    const types = options.kind === "docs" ? ["document"] : ["image", "video", "audio"];
    const result = await this.db.execute<{ id: string }>(sql`
      SELECT bm.id FROM broadcast_messages bm
      JOIN media_uploads u ON u.id = bm.attachment_upload_id AND u.status = 'ready'
      WHERE bm.broadcast_list_id = ${listId} AND bm.sender_id = ${ownerId}
        AND bm.type::text = ANY(${sql.param(types)}::text[])
        AND ${afterClearMarker(listId)}
        ${options.before !== undefined ? sql`AND bm.history_seq < ${options.before}` : sql``}
      ORDER BY bm.history_seq DESC
      LIMIT ${options.limit + 1}
    `);
    return this.page(ownerId, result.rows, options.limit);
  }

  // The list's broadcasts the owner starred, one entry per broadcast however
  // many copies are starred, newest first. Stars kept through Clear Chat are
  // included (inHistory false).
  async starred(
    ownerId: string,
    listId: string,
    options: { before?: number | undefined; limit: number },
  ): Promise<{ broadcasts: BroadcastDto[]; hasMore: boolean }> {
    const result = await this.db.execute<{ id: string }>(sql`
      SELECT bm.id FROM broadcast_messages bm
      WHERE bm.broadcast_list_id = ${listId} AND bm.sender_id = ${ownerId}
        AND ${starredBroadcast(ownerId)}
        ${options.before !== undefined ? sql`AND bm.history_seq < ${options.before}` : sql``}
      ORDER BY bm.history_seq DESC
      LIMIT ${options.limit + 1}
    `);
    return this.page(ownerId, result.rows, options.limit);
  }

  // The owner's live copies of a broadcast (the direct messages it was
  // delivered as), oldest delivery first.
  async liveCopies(
    executor: Executor,
    ownerId: string,
    broadcastId: string,
  ): Promise<{ messageId: string; chatId: string }[]> {
    const result = await executor.execute<{ message_id: string; chat_id: string }>(sql`
      SELECT m.id AS message_id, m.chat_id
      FROM broadcast_message_recipients r
      JOIN broadcast_messages bm ON bm.id = r.broadcast_message_id
      JOIN messages m ON m.id = r.message_id
      WHERE r.broadcast_message_id = ${broadcastId} AND bm.sender_id = ${ownerId}
        AND m.deleted_at IS NULL
      ORDER BY m.created_at, m.id
    `);
    return result.rows.map((row) => ({ messageId: row.message_id, chatId: row.chat_id }));
  }

  // Stars one live copy; the caller holds that copy's chat lock, which
  // serialises with deletion. Returns false when it was already starred or
  // was deleted meanwhile.
  async starCopy(tx: Tx, ownerId: string, messageId: string): Promise<boolean> {
    const result = await tx.execute(sql`
      INSERT INTO starred_messages (user_id, message_id)
      SELECT ${ownerId}, id FROM messages WHERE id = ${messageId} AND deleted_at IS NULL
      ON CONFLICT (user_id, message_id) DO NOTHING
      RETURNING message_id
    `);
    return result.rows.length > 0;
  }

  // Removes the owner's stars from every copy of a broadcast.
  async unstarCopies(
    tx: Tx,
    ownerId: string,
    broadcastId: string,
  ): Promise<{ messageId: string; chatId: string }[]> {
    const result = await tx.execute<{ message_id: string; chat_id: string }>(sql`
      DELETE FROM starred_messages s
      USING broadcast_message_recipients r, messages m
      WHERE s.user_id = ${ownerId} AND s.message_id = r.message_id
        AND r.broadcast_message_id = ${broadcastId} AND m.id = r.message_id
      RETURNING s.message_id, m.chat_id
    `);
    return result.rows.map((row) => ({ messageId: row.message_id, chatId: row.chat_id }));
  }

  // Clear Chat for the owner's list view, under the list lock (held by the
  // caller, which also serialises send acceptance). Nothing is deleted and
  // recipients' chats are untouched. Without keepStarred the owner's stars
  // on the cleared broadcasts' copies are removed (wherever they show).
  async clearHistory(
    tx: Tx,
    ownerId: string,
    listId: string,
    keepStarred: boolean,
  ): Promise<{ clearedThroughSeq: number; unstarred: { messageId: string; chatId: string }[] }> {
    const result = await tx.execute<{ cleared: string | number }>(sql`
      UPDATE broadcast_lists l SET
        cleared_through_seq = GREATEST(l.cleared_through_seq, COALESCE((
          SELECT MAX(history_seq) FROM broadcast_messages WHERE broadcast_list_id = ${listId}
        ), 0)),
        cleared_at = NOW()
      WHERE l.id = ${listId}
      RETURNING l.cleared_through_seq AS cleared
    `);
    const clearedThroughSeq = Number(result.rows[0]?.cleared ?? 0);
    if (keepStarred) return { clearedThroughSeq, unstarred: [] };
    const removed = await tx.execute<{ message_id: string; chat_id: string }>(sql`
      DELETE FROM starred_messages s
      USING broadcast_message_recipients r, broadcast_messages bm, messages m
      WHERE s.user_id = ${ownerId} AND s.message_id = r.message_id
        AND r.broadcast_message_id = bm.id AND bm.broadcast_list_id = ${listId}
        AND bm.sender_id = ${ownerId} AND bm.history_seq <= ${clearedThroughSeq}
        AND m.id = r.message_id
      RETURNING s.message_id, m.chat_id
    `);
    return {
      clearedThroughSeq,
      unstarred: removed.rows.map((row) => ({ messageId: row.message_id, chatId: row.chat_id })),
    };
  }

  // Every recipient's outcome. Read state is reported only where both the
  // owner and the recipient allow read receipts.
  async report(ownerId: string, broadcastId: string): Promise<RecipientReportDto[]> {
    const result = await this.db.execute<{
      recipient_id: string;
      display_name: string | null;
      photo_id: string | null;
      status: RecipientStatus;
      read_visible: boolean;
      target_chat_id: string | null;
      attempt_count: number;
      sent_at: string | null;
      delivered_at: string | null;
      read_at: string | null;
      failed_at: string | null;
      failure_code: string | null;
      retryable: boolean;
    }>(sql`
      SELECT r.recipient_id, u.display_name, ${photoIdFor(sql`u`, ownerId)} AS photo_id, r.status,
        (COALESCE(rp.show_read_receipts, TRUE) AND (
          SELECT COALESCE(BOOL_AND(show_read_receipts), TRUE) FROM privacy_settings
          WHERE user_id = ${ownerId}
        )) AS read_visible,
        r.target_chat_id, r.attempt_count,
        CASE WHEN r.sent_at IS NULL THEN NULL ELSE ${isoTimestamp(sql`r.sent_at`)} END AS sent_at,
        CASE WHEN r.delivered_at IS NULL THEN NULL ELSE ${isoTimestamp(sql`r.delivered_at`)} END
          AS delivered_at,
        CASE WHEN r.read_at IS NULL THEN NULL ELSE ${isoTimestamp(sql`r.read_at`)} END AS read_at,
        CASE WHEN r.failed_at IS NULL THEN NULL ELSE ${isoTimestamp(sql`r.failed_at`)} END
          AS failed_at,
        r.failure_code, r.retryable
      FROM broadcast_message_recipients r
      JOIN broadcast_messages bm ON bm.id = r.broadcast_message_id
      JOIN users u ON u.id = r.recipient_id
      LEFT JOIN privacy_settings rp ON rp.user_id = r.recipient_id
      WHERE r.broadcast_message_id = ${broadcastId} AND bm.sender_id = ${ownerId}
      ORDER BY lower(COALESCE(u.display_name, '')), r.recipient_id
    `);
    return result.rows.map((row) => {
      const hideRead = row.status === "read" && !row.read_visible;
      return {
        userId: row.recipient_id,
        displayName: row.display_name,
        photoId: row.photo_id,
        status: hideRead ? "delivered" : row.status,
        chatId: row.target_chat_id,
        attemptCount: row.attempt_count,
        sentAt: row.sent_at,
        deliveredAt: row.delivered_at,
        readAt: hideRead || !row.read_visible ? null : row.read_at,
        failedAt: row.failed_at,
        failureCode: row.failure_code,
        retryable: row.retryable,
      };
    });
  }

  // ---- Receipts ------------------------------------------------------------

  // Advances the recipient records whose direct messages a recipient's new
  // delivered/read pointers in that chat now cover. Only moves forward.
  async applyReceipts(
    recipientId: string,
    chatId: string,
    delivered: number,
    read: number,
  ): Promise<ReceiptChange[]> {
    const result = await this.db.execute<{
      broadcast_id: string;
      list_id: string;
      owner_id: string;
      list_deleted: boolean;
      old_status: RecipientStatus;
      new_status: RecipientStatus;
      read_visible: boolean;
    }>(sql`
      WITH targets AS (
        SELECT r.broadcast_message_id, r.recipient_id, r.status AS old_status, m.sequence
        FROM broadcast_message_recipients r
        JOIN messages m ON m.id = r.message_id
        WHERE r.target_chat_id = ${chatId} AND r.recipient_id = ${recipientId}
          AND r.status IN ('sent', 'delivered')
          AND m.sequence <= ${delivered}
          AND (r.status = 'sent' OR m.sequence <= ${read})
        FOR UPDATE OF r
      ),
      updated AS (
        UPDATE broadcast_message_recipients r SET
          status = (CASE WHEN t.sequence <= ${read} THEN 'read' ELSE 'delivered' END)
            ::broadcast_recipient_status,
          delivered_at = COALESCE(r.delivered_at, NOW()),
          read_at = CASE WHEN t.sequence <= ${read} THEN COALESCE(r.read_at, NOW()) ELSE r.read_at END
        FROM targets t
        WHERE r.broadcast_message_id = t.broadcast_message_id AND r.recipient_id = t.recipient_id
        RETURNING r.broadcast_message_id, t.old_status, r.status AS new_status
      )
      SELECT u.broadcast_message_id AS broadcast_id, bm.broadcast_list_id AS list_id,
        bm.sender_id AS owner_id, l.deleted_at IS NOT NULL AS list_deleted, u.old_status,
        u.new_status,
        (SELECT COALESCE(BOOL_AND(show_read_receipts), TRUE) FROM privacy_settings
         WHERE user_id IN (bm.sender_id, ${recipientId})) AS read_visible
      FROM updated u
      JOIN broadcast_messages bm ON bm.id = u.broadcast_message_id
      JOIN broadcast_lists l ON l.id = bm.broadcast_list_id
    `);
    return result.rows
      .filter((row) => !row.list_deleted)
      .map((row) => ({
        broadcastId: row.broadcast_id,
        listId: row.list_id,
        ownerId: row.owner_id,
        visible: row.old_status === "sent" || row.read_visible,
        read: row.new_status === "read" && row.read_visible,
      }));
  }
}
