import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { chats } from "./chats.js";
import { devices } from "./devices.js";
import { messages } from "./messages.js";
import { timestamptz } from "./types.js";
import { users } from "./users.js";

// queued = waiting (available_at says when). processing = claimed by a
// worker until locked_until; a crashed worker's claim lapses and the job is
// claimed again. completed = every delivery reached a final state.
// expired = too old to be worth sending (PUSH_MAX_AGE_SECONDS). failed =
// processing itself kept failing.
export const notificationJobStatus = pgEnum("notification_job_status", [
  "queued",
  "processing",
  "completed",
  "expired",
  "failed",
]);

// pending = not yet accepted by the provider (next_attempt_at says when to
// try). accepted = Expo returned an ok ticket; that is not proof the device
// showed it. provider_delivered = the receipt says Expo handed it to
// APNs/FCM. failed = permanent error or retries exhausted (error_code).
// skipped = no longer eligible when it was due (unmuted→muted, left the
// group, signed out, blocked).
export const pushDeliveryStatus = pgEnum("push_delivery_status", [
  "pending",
  "accepted",
  "provider_delivered",
  "failed",
  "skipped",
]);

// Transactional outbox: one row per user message, written in the same
// transaction as the message, so a push is never sent for a message that
// didn't commit and a committed message is never forgotten. Recipients are
// resolved when the job is processed, from membership, mutes and blocks as
// they are then.
export const notificationJobs = pgTable(
  "notification_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    messageId: uuid("message_id").notNull(),
    chatId: uuid("chat_id").notNull(),

    status: notificationJobStatus("status").notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    availableAt: timestamptz("available_at").notNull().defaultNow(),
    lockedUntil: timestamptz("locked_until"),
    // Set once the job's deliveries were created.
    plannedAt: timestamptz("planned_at"),
    lastError: text("last_error"),

    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
    completedAt: timestamptz("completed_at"),
  },
  (t) => [
    foreignKey({
      name: "notification_jobs_message_id_fkey",
      columns: [t.messageId],
      foreignColumns: [messages.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "notification_jobs_chat_id_fkey",
      columns: [t.chatId],
      foreignColumns: [chats.id],
    }).onDelete("cascade"),

    // One logical notification per message, however often it is enqueued.
    uniqueIndex("notification_jobs_message_unique").on(t.messageId),
    index("notification_jobs_due_idx")
      .on(t.availableAt)
      .where(sql`${t.status} IN ('queued', 'processing')`),
    index("notification_jobs_finished_idx")
      .on(t.completedAt)
      .where(sql`${t.completedAt} IS NOT NULL`),
    check("notification_jobs_attempts_check", sql`${t.attempts} >= 0`),
  ],
);

// One push to one device for one job. The token is a snapshot: if the
// device's token changes or is revoked before the push is due, the
// delivery is skipped rather than sent to the new or old token.
export const pushDeliveries = pgTable(
  "push_deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    jobId: uuid("job_id").notNull(),
    deviceId: uuid("device_id").notNull(),
    userId: uuid("user_id").notNull(),
    token: text("token").notNull(),

    status: pushDeliveryStatus("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamptz("next_attempt_at").notNull().defaultNow(),

    // Expo push ticket id, used to fetch the receipt.
    ticketId: text("ticket_id"),
    acceptedAt: timestamptz("accepted_at"),
    receiptCheckedAt: timestamptz("receipt_checked_at"),
    // Provider error code (e.g. DeviceNotRegistered) or an internal one
    // (RETRIES_EXHAUSTED, EXPIRED). Never message content.
    errorCode: text("error_code"),

    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "push_deliveries_job_id_fkey",
      columns: [t.jobId],
      foreignColumns: [notificationJobs.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "push_deliveries_device_id_fkey",
      columns: [t.deviceId],
      foreignColumns: [devices.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "push_deliveries_user_id_fkey",
      columns: [t.userId],
      foreignColumns: [users.id],
    }).onDelete("cascade"),

    uniqueIndex("push_deliveries_job_device_unique").on(t.jobId, t.deviceId),
    uniqueIndex("push_deliveries_ticket_unique")
      .on(t.ticketId)
      .where(sql`${t.ticketId} IS NOT NULL`),
    index("push_deliveries_pending_idx")
      .on(t.jobId, t.nextAttemptAt)
      .where(sql`${t.status} = 'pending'`),
    index("push_deliveries_receipt_idx")
      .on(t.acceptedAt)
      .where(sql`${t.status} = 'accepted' AND ${t.receiptCheckedAt} IS NULL`),
    index("push_deliveries_device_idx").on(t.deviceId),
    check("push_deliveries_attempts_check", sql`${t.attempts} >= 0`),
  ],
);

export type NotificationJob = typeof notificationJobs.$inferSelect;
export type PushDelivery = typeof pushDeliveries.$inferSelect;
