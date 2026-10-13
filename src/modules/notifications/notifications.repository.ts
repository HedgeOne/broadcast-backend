import { sql, type SQL } from "drizzle-orm";

import type { Database } from "../../db/client.js";
import type { PushChatType } from "./notifications.provider.js";

function uuids(values: readonly string[]): SQL {
  return sql`${sql.param([...values])}::uuid[]`;
}

function isoTimestamp(column: SQL): SQL {
  return sql`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
}

export interface ClaimedJob {
  id: string;
  messageId: string;
  chatId: string;
  attempts: number;
  planned: boolean;
  // Older than the maximum age: dropped instead of sent.
  expired: boolean;
}

export interface DueDelivery {
  id: string;
  deviceId: string;
  userId: string;
  token: string;
  attempts: number;
}

export interface ReceiptCandidate {
  id: string;
  ticketId: string;
  deviceId: string;
  token: string;
}

export interface PushRegistration {
  registered: boolean;
  registeredAt: string | null;
}

// Devices that should get a push for the job's message right now. Read
// at planning time and again before every attempt, so a mute, a removal,
// a block, a sign-out or reading the message on another device in the
// meantime stops later attempts.
function eligibleDevices(jobId: string): SQL {
  return sql`
    SELECT d.id AS device_id, d.user_id, d.push_token AS token
    FROM notification_jobs j
    JOIN messages m ON m.id = j.message_id
    JOIN chats c ON c.id = m.chat_id
    LEFT JOIN groups g ON g.chat_id = c.id
    JOIN chat_members cm ON cm.chat_id = m.chat_id
    JOIN users u ON u.id = cm.user_id
    LEFT JOIN user_settings us ON us.user_id = cm.user_id
    JOIN devices d ON d.user_id = cm.user_id
    WHERE j.id = ${jobId}
      AND m.type <> 'system'
      AND m.deleted_at IS NULL
      AND (c.type = 'direct' OR (g.chat_id IS NOT NULL AND g.deleted_at IS NULL))
      AND cm.user_id <> m.sender_id
      AND cm.left_at IS NULL
      AND m.sequence > cm.history_from_sequence
      AND m.sequence > cm.last_read_sequence
      AND (cm.muted_until IS NULL OR cm.muted_until <= NOW())
      AND u.status = 'active'
      AND COALESCE(us.notifications_enabled, TRUE)
      AND NOT EXISTS (
        SELECT 1 FROM blocked_users b
        WHERE (b.user_id = cm.user_id AND b.blocked_user_id = m.sender_id)
           OR (b.user_id = m.sender_id AND b.blocked_user_id = cm.user_id)
      )
      AND d.revoked_at IS NULL
      AND d.push_token IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM sessions s
        WHERE s.device_id = d.id AND s.user_id = d.user_id
          AND s.revoked_at IS NULL AND s.expires_at > NOW()
      )
  `;
}

export class NotificationsRepository {
  constructor(private readonly db: Database) {}

  // ---------------------------------------------------------------
  // Device tokens
  // ---------------------------------------------------------------

  // Points the session's device at the token. The same install can only
  // be signed in to one account at a time, so the token is taken off any
  // other device row. Undefined when the device is gone or revoked.
  async registerToken(
    userId: string,
    deviceId: string,
    token: string,
  ): Promise<PushRegistration | undefined> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`
        UPDATE devices SET
          push_token = NULL,
          push_token_revoked_at = NOW(),
          push_token_revoked_reason = 'replaced'
        WHERE push_token = ${token} AND id <> ${deviceId}
      `);
      const result = await tx.execute<{ registered_at: string }>(sql`
        UPDATE devices SET
          push_token = ${token},
          push_token_registered_at = NOW(),
          push_token_revoked_at = NULL,
          push_token_revoked_reason = NULL,
          push_last_error_code = NULL,
          push_last_error_at = NULL
        WHERE id = ${deviceId} AND user_id = ${userId} AND revoked_at IS NULL
        RETURNING ${isoTimestamp(sql`push_token_registered_at`)} AS registered_at
      `);
      const row = result.rows[0];
      return row ? { registered: true, registeredAt: row.registered_at } : undefined;
    });
  }

  async unregisterToken(userId: string, deviceId: string): Promise<void> {
    await this.db.execute(sql`
      UPDATE devices SET
        push_token = NULL,
        push_token_revoked_at = NOW(),
        push_token_revoked_reason = 'unregistered'
      WHERE id = ${deviceId} AND user_id = ${userId} AND push_token IS NOT NULL
    `);
  }

  async registration(userId: string, deviceId: string): Promise<PushRegistration> {
    const result = await this.db.execute<{ registered: boolean; registered_at: string | null }>(
      sql`
        SELECT push_token IS NOT NULL AS registered,
          ${isoTimestamp(sql`push_token_registered_at`)} AS registered_at
        FROM devices WHERE id = ${deviceId} AND user_id = ${userId}
      `,
    );
    const row = result.rows[0];
    return row?.registered
      ? { registered: true, registeredAt: row.registered_at }
      : { registered: false, registeredAt: null };
  }

  // The provider said the token is dead. Only clears it if the device
  // still holds that exact token (it may have re-registered since).
  async deactivateToken(deviceId: string, token: string, code: string): Promise<void> {
    await this.db.execute(sql`
      UPDATE devices SET
        push_token = NULL,
        push_token_revoked_at = NOW(),
        push_token_revoked_reason = 'invalid',
        push_last_error_code = ${code},
        push_last_error_at = NOW()
      WHERE id = ${deviceId} AND push_token = ${token}
    `);
  }

  async recordDeviceSuccess(deviceIds: readonly string[]): Promise<void> {
    if (deviceIds.length === 0) return;
    await this.db.execute(sql`
      UPDATE devices SET push_last_success_at = NOW() WHERE id = ANY(${uuids(deviceIds)})
    `);
  }

  async recordDeviceError(deviceId: string, code: string): Promise<void> {
    await this.db.execute(sql`
      UPDATE devices SET push_last_error_code = ${code}, push_last_error_at = NOW()
      WHERE id = ${deviceId}
    `);
  }

  // ---------------------------------------------------------------
  // Jobs
  // ---------------------------------------------------------------

  // Claims due jobs, including ones whose worker died mid-way (its lock
  // lapsed). SKIP LOCKED lets several workers or instances run at once.
  async claimJobs(
    limit: number,
    lockSeconds: number,
    maxAgeSeconds: number,
  ): Promise<ClaimedJob[]> {
    const result = await this.db.execute<{
      id: string;
      message_id: string;
      chat_id: string;
      attempts: number;
      planned: boolean;
      expired: boolean;
    }>(sql`
      UPDATE notification_jobs j SET
        status = 'processing',
        locked_until = NOW() + make_interval(secs => ${lockSeconds}),
        attempts = j.attempts + 1,
        updated_at = NOW()
      WHERE j.id IN (
        SELECT id FROM notification_jobs
        WHERE (status = 'queued' AND available_at <= NOW())
           OR (status = 'processing' AND locked_until < NOW())
        ORDER BY available_at
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING j.id, j.message_id, j.chat_id, j.attempts,
        j.planned_at IS NOT NULL AS planned,
        j.created_at < NOW() - make_interval(secs => ${maxAgeSeconds}) AS expired
    `);
    return result.rows.map((row) => ({
      id: row.id,
      messageId: row.message_id,
      chatId: row.chat_id,
      attempts: Number(row.attempts),
      planned: row.planned,
      expired: row.expired,
    }));
  }

  async chatType(chatId: string): Promise<PushChatType | undefined> {
    const result = await this.db.execute<{ type: PushChatType }>(
      sql`SELECT type FROM chats WHERE id = ${chatId}`,
    );
    return result.rows[0]?.type;
  }

  // Creates one delivery per eligible device. Idempotent: a job that is
  // planned twice (a worker died after planning) keeps its deliveries.
  async planJob(jobId: string): Promise<number> {
    return this.db.transaction(async (tx) => {
      const inserted = await tx.execute(sql`
        INSERT INTO push_deliveries (job_id, device_id, user_id, token)
        SELECT ${jobId}, e.device_id, e.user_id, e.token FROM (${eligibleDevices(jobId)}) e
        ON CONFLICT (job_id, device_id) DO NOTHING
      `);
      await tx.execute(sql`
        UPDATE notification_jobs SET planned_at = NOW(), updated_at = NOW() WHERE id = ${jobId}
      `);
      return inserted.rowCount ?? 0;
    });
  }

  // Pending deliveries whose device is no longer eligible, or whose device
  // now has a different token, are skipped.
  async skipIneligible(jobId: string): Promise<number> {
    const result = await this.db.execute(sql`
      UPDATE push_deliveries pd SET status = 'skipped', error_code = 'INELIGIBLE', updated_at = NOW()
      WHERE pd.job_id = ${jobId} AND pd.status = 'pending'
        AND NOT EXISTS (
          SELECT 1 FROM (${eligibleDevices(jobId)}) e
          WHERE e.device_id = pd.device_id AND e.token = pd.token
        )
    `);
    return result.rowCount ?? 0;
  }

  async dueDeliveries(jobId: string): Promise<DueDelivery[]> {
    const result = await this.db.execute<{
      id: string;
      device_id: string;
      user_id: string;
      token: string;
      attempts: number;
    }>(sql`
      SELECT id, device_id, user_id, token, attempts FROM push_deliveries
      WHERE job_id = ${jobId} AND status = 'pending' AND next_attempt_at <= NOW()
      ORDER BY created_at, id
    `);
    return result.rows.map((row) => ({
      id: row.id,
      deviceId: row.device_id,
      userId: row.user_id,
      token: row.token,
      attempts: Number(row.attempts),
    }));
  }

  // App icon badge: unread messages from others in unmuted chats, as the
  // chat list counts them.
  async badges(userIds: readonly string[]): Promise<Map<string, number>> {
    const badges = new Map<string, number>();
    if (userIds.length === 0) return badges;
    const result = await this.db.execute<{ user_id: string; unread: string }>(sql`
      SELECT me.user_id, COUNT(m.id) AS unread
      FROM chat_members me
      JOIN chats c ON c.id = me.chat_id
      LEFT JOIN groups g ON g.chat_id = c.id
      JOIN messages m ON m.chat_id = me.chat_id
        AND m.sequence > GREATEST(me.last_read_sequence, me.history_from_sequence)
        AND m.sender_id <> me.user_id
        AND m.type <> 'system'
        AND m.deleted_at IS NULL
      WHERE me.user_id = ANY(${uuids(userIds)})
        AND me.left_at IS NULL
        AND (me.muted_until IS NULL OR me.muted_until <= NOW())
        AND (c.type = 'direct' OR (g.chat_id IS NOT NULL AND g.deleted_at IS NULL))
      GROUP BY me.user_id
    `);
    for (const row of result.rows) badges.set(row.user_id, Number(row.unread));
    return badges;
  }

  async markAccepted(deliveryId: string, ticketId: string): Promise<void> {
    await this.db.execute(sql`
      UPDATE push_deliveries SET
        status = 'accepted', ticket_id = ${ticketId}, accepted_at = NOW(),
        attempts = attempts + 1, error_code = NULL, updated_at = NOW()
      WHERE id = ${deliveryId} AND status = 'pending'
    `);
  }

  async markFailed(deliveryIds: readonly string[], code: string): Promise<void> {
    if (deliveryIds.length === 0) return;
    await this.db.execute(sql`
      UPDATE push_deliveries SET
        status = 'failed', error_code = ${code}, attempts = attempts + 1, updated_at = NOW()
      WHERE id = ANY(${uuids(deliveryIds)}) AND status = 'pending'
    `);
  }

  // Schedules another attempt, or fails the delivery once it has had
  // `maxAttempts`.
  async scheduleRetry(
    deliveryIds: readonly string[],
    code: string,
    delaySeconds: number,
    maxAttempts: number,
  ): Promise<void> {
    if (deliveryIds.length === 0) return;
    await this.db.execute(sql`
      UPDATE push_deliveries SET
        attempts = attempts + 1,
        error_code = ${code},
        status = CASE WHEN attempts + 1 >= ${maxAttempts}
          THEN 'failed'::push_delivery_status ELSE 'pending'::push_delivery_status END,
        next_attempt_at = NOW() + make_interval(secs => ${delaySeconds}),
        updated_at = NOW()
      WHERE id = ANY(${uuids(deliveryIds)}) AND status = 'pending'
    `);
  }

  // Done when nothing is pending; otherwise back to the queue until the
  // earliest retry is due.
  async finishJob(jobId: string): Promise<"completed" | "queued"> {
    const result = await this.db.execute<{ status: "completed" | "queued" }>(sql`
      WITH next AS (
        SELECT MIN(next_attempt_at) AS at FROM push_deliveries
        WHERE job_id = ${jobId} AND status = 'pending'
      )
      UPDATE notification_jobs j SET
        status = CASE WHEN next.at IS NULL
          THEN 'completed'::notification_job_status ELSE 'queued'::notification_job_status END,
        available_at = COALESCE(next.at, j.available_at),
        completed_at = CASE WHEN next.at IS NULL THEN NOW() ELSE NULL END,
        locked_until = NULL,
        last_error = NULL,
        updated_at = NOW()
      FROM next
      WHERE j.id = ${jobId}
      RETURNING j.status
    `);
    return result.rows[0]?.status ?? "completed";
  }

  // Too old to be useful: drop what hasn't been accepted yet.
  async expireJob(jobId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`
        UPDATE push_deliveries SET status = 'failed', error_code = 'EXPIRED', updated_at = NOW()
        WHERE job_id = ${jobId} AND status = 'pending'
      `);
      await tx.execute(sql`
        UPDATE notification_jobs SET
          status = 'expired', completed_at = NOW(), locked_until = NULL, updated_at = NOW()
        WHERE id = ${jobId}
      `);
    });
  }

  // Processing threw (e.g. the database blipped). Retried later; a job that
  // keeps failing is given up after `maxJobAttempts`.
  async releaseFailedJob(
    jobId: string,
    error: string,
    delaySeconds: number,
    maxJobAttempts: number,
  ): Promise<void> {
    await this.db.execute(sql`
      UPDATE notification_jobs SET
        status = CASE WHEN attempts >= ${maxJobAttempts}
          THEN 'failed'::notification_job_status ELSE 'queued'::notification_job_status END,
        completed_at = CASE WHEN attempts >= ${maxJobAttempts} THEN NOW() ELSE NULL END,
        available_at = NOW() + make_interval(secs => ${delaySeconds}),
        locked_until = NULL,
        last_error = ${error},
        updated_at = NOW()
      WHERE id = ${jobId}
    `);
  }

  // ---------------------------------------------------------------
  // Receipts
  // ---------------------------------------------------------------

  async receiptCandidates(delaySeconds: number, limit: number): Promise<ReceiptCandidate[]> {
    const result = await this.db.execute<{
      id: string;
      ticket_id: string;
      device_id: string;
      token: string;
    }>(sql`
      SELECT id, ticket_id, device_id, token FROM push_deliveries
      WHERE status = 'accepted' AND receipt_checked_at IS NULL AND ticket_id IS NOT NULL
        AND accepted_at <= NOW() - make_interval(secs => ${delaySeconds})
      ORDER BY accepted_at
      LIMIT ${limit}
    `);
    return result.rows.map((row) => ({
      id: row.id,
      ticketId: row.ticket_id,
      deviceId: row.device_id,
      token: row.token,
    }));
  }

  async markProviderDelivered(deliveryIds: readonly string[]): Promise<void> {
    if (deliveryIds.length === 0) return;
    await this.db.execute(sql`
      UPDATE push_deliveries SET
        status = 'provider_delivered', receipt_checked_at = NOW(), updated_at = NOW()
      WHERE id = ANY(${uuids(deliveryIds)}) AND status = 'accepted'
    `);
  }

  async markReceiptFailed(deliveryId: string, code: string): Promise<void> {
    await this.db.execute(sql`
      UPDATE push_deliveries SET
        status = 'failed', error_code = ${code}, receipt_checked_at = NOW(), updated_at = NOW()
      WHERE id = ${deliveryId} AND status = 'accepted'
    `);
  }

  // Expo keeps receipts for about a day; stop asking after that. The
  // delivery stays `accepted` (outcome unknown).
  async abandonOldReceipts(): Promise<void> {
    await this.db.execute(sql`
      UPDATE push_deliveries SET receipt_checked_at = NOW(), updated_at = NOW()
      WHERE status = 'accepted' AND receipt_checked_at IS NULL
        AND accepted_at < NOW() - interval '24 hours'
    `);
  }

  // ---------------------------------------------------------------
  // Housekeeping
  // ---------------------------------------------------------------

  // Expired mutes already behave as unmuted; this only tidies them.
  async clearExpiredMutes(): Promise<void> {
    await this.db.execute(sql`
      UPDATE chat_members SET muted_until = NULL
      WHERE muted_until IS NOT NULL AND muted_until <= NOW()
    `);
  }

  // Finished jobs (and their deliveries) are kept for a week for support.
  async pruneFinished(retentionDays: number, limit: number): Promise<number> {
    const result = await this.db.execute(sql`
      DELETE FROM notification_jobs WHERE id IN (
        SELECT id FROM notification_jobs
        WHERE completed_at IS NOT NULL
          AND completed_at < NOW() - make_interval(days => ${retentionDays})
        LIMIT ${limit}
      )
    `);
    return result.rowCount ?? 0;
  }
}
