import type { FastifyBaseLogger } from "fastify";

import {
  INVALID_TOKEN_ERRORS,
  PushProviderError,
  RECEIPT_BATCH_LIMIT,
  RETRYABLE_PUSH_ERRORS,
  SEND_BATCH_LIMIT,
  type PushChatType,
  type PushMessage,
  type PushProvider,
} from "./notifications.provider.js";
import type {
  ClaimedJob,
  DueDelivery,
  NotificationsRepository,
} from "./notifications.repository.js";

// The Android channel the app creates before registering its token.
export const ANDROID_CHANNEL_ID = "messages";

// Generic text: the server stores message bodies as opaque ciphertext and
// pushes carry no content, names or previews.
export const PUSH_BODY: Record<PushChatType, string> = {
  direct: "New message",
  group: "New group message",
};

const JOB_BATCH = 20;
// Bounds one drain so a backlog can't monopolise the process.
const MAX_ROUNDS = 25;
const LOCK_SECONDS = 120;
const MAX_JOB_ATTEMPTS = 10;
const RETRY_BASE_SECONDS = 2;
const RETRY_CAP_SECONDS = 300;
// How long APNs/FCM keep trying to reach an offline device.
const PUSH_TTL_SECONDS = 24 * 3600;
const RETENTION_DAYS = 7;
const PRUNE_BATCH = 1000;

export interface PushNotifierSettings {
  maxAttempts: number;
  maxAgeSeconds: number;
  receiptDelaySeconds: number;
  // False leaves committed jobs to drain()/sweep() (tests of the queue).
  processOnCommit?: boolean;
}

export interface JobOutcome {
  accepted: number;
  failed: number;
  retrying: number;
  skipped: number;
}

// Exponential backoff with full jitter on top of the base delay, never
// sooner than the provider asked for.
export function retryDelaySeconds(
  attempt: number,
  retryAfterSeconds?: number,
  random: () => number = Math.random,
): number {
  const exponential = Math.min(RETRY_CAP_SECONDS, RETRY_BASE_SECONDS * 2 ** Math.max(0, attempt));
  const delay = Math.ceil(exponential / 2 + random() * (exponential / 2));
  return Math.max(delay, retryAfterSeconds ?? 0);
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let start = 0; start < items.length; start += size) {
    result.push(items.slice(start, start + size));
  }
  return result;
}

// Name and SQLSTATE only: query errors embed their parameters (tokens) in
// the message.
function errorText(error: unknown): string {
  if (!(error instanceof Error)) return "unknown error";
  const code =
    (error as { code?: unknown }).code ?? (error.cause as { code?: unknown } | undefined)?.code;
  return typeof code === "string" ? `${error.name} ${code}` : error.name;
}

// Sends the pushes the outbox asks for. Postgres is the queue: `kick()`
// processes due jobs right after a message commits, and the sweep picks up
// anything a restart, a crash or a retry delay left behind. A push failing
// never affects the message, which was committed before the job existed.
export class PushNotifier {
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | null = null;
  private again = false;
  private sweeping = false;

  constructor(
    private readonly repo: NotificationsRepository,
    private readonly provider: PushProvider,
    private readonly log: FastifyBaseLogger,
    private readonly settings: PushNotifierSettings,
  ) {}

  // Called after a message commits. Coalesces: a kick during a drain
  // causes one more drain, not one per message.
  kick(): void {
    if (this.settings.processOnCommit === false) return;
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = this.loop().finally(() => {
      this.running = null;
    });
  }

  // Resolves once kicked work has finished (tests, shutdown).
  async idle(): Promise<void> {
    while (this.running) await this.running;
  }

  private async loop(): Promise<void> {
    do {
      this.again = false;
      try {
        await this.drain();
      } catch (error) {
        this.log.error({ err: errorText(error) }, "push drain failed");
      }
    } while (this.again);
  }

  // Processes due jobs until none are left (or the round limit). Returns
  // how many jobs were processed.
  async drain(): Promise<number> {
    let processed = 0;
    for (let round = 0; round < MAX_ROUNDS; round += 1) {
      const jobs = await this.repo.claimJobs(JOB_BATCH, LOCK_SECONDS, this.settings.maxAgeSeconds);
      if (jobs.length === 0) break;
      for (const job of jobs) await this.processJob(job);
      processed += jobs.length;
    }
    return processed;
  }

  async processJob(job: ClaimedJob): Promise<JobOutcome | undefined> {
    try {
      if (job.expired) {
        await this.repo.expireJob(job.id);
        this.log.warn({ jobId: job.id }, "push job expired before it could be sent");
        return undefined;
      }
      if (!job.planned) await this.repo.planJob(job.id);
      const outcome: JobOutcome = { accepted: 0, failed: 0, retrying: 0, skipped: 0 };
      outcome.skipped = await this.repo.skipIneligible(job.id);

      const due = await this.repo.dueDeliveries(job.id);
      const chatType = due.length > 0 ? await this.repo.chatType(job.chatId) : undefined;
      if (chatType) {
        const badges = await this.repo.badges([...new Set(due.map((d) => d.userId))]);
        for (const batch of chunks(due, SEND_BATCH_LIMIT)) {
          await this.sendBatch(job, chatType, batch, badges, outcome);
        }
      }

      const status = await this.repo.finishJob(job.id);
      if (due.length > 0 || outcome.skipped > 0) {
        this.log.info({ jobId: job.id, status, ...outcome }, "push job processed");
      }
      return outcome;
    } catch (error) {
      this.log.error({ jobId: job.id, err: errorText(error) }, "push job failed");
      await this.repo
        .releaseFailedJob(
          job.id,
          errorText(error).slice(0, 200),
          retryDelaySeconds(job.attempts),
          MAX_JOB_ATTEMPTS,
        )
        .catch((releaseError: unknown) => {
          this.log.error(
            { jobId: job.id, err: errorText(releaseError) },
            "push job release failed",
          );
        });
      return undefined;
    }
  }

  private message(
    job: ClaimedJob,
    chatType: PushChatType,
    delivery: DueDelivery,
    badge: number | undefined,
  ): PushMessage {
    return {
      to: delivery.token,
      body: PUSH_BODY[chatType],
      data: {
        type: chatType === "group" ? "group_message" : "direct_message",
        chatId: job.chatId,
        messageId: job.messageId,
        notificationId: job.id,
      },
      sound: "default",
      priority: "high",
      channelId: ANDROID_CHANNEL_ID,
      ttl: PUSH_TTL_SECONDS,
      ...(badge !== undefined ? { badge } : {}),
    };
  }

  private async sendBatch(
    job: ClaimedJob,
    chatType: PushChatType,
    batch: DueDelivery[],
    badges: Map<string, number>,
    outcome: JobOutcome,
  ): Promise<void> {
    const ids = batch.map((d) => d.id);
    let tickets;
    try {
      tickets = await this.provider.send(
        batch.map((d) => this.message(job, chatType, d, badges.get(d.userId) ?? 0)),
      );
    } catch (error) {
      if (!(error instanceof PushProviderError)) throw error;
      if (error.retryable) {
        const attempt = Math.max(...batch.map((d) => d.attempts));
        await this.repo.scheduleRetry(
          ids,
          error.code,
          retryDelaySeconds(attempt, error.retryAfterSeconds),
          this.settings.maxAttempts,
        );
        outcome.retrying += batch.length;
        this.log.warn(
          { jobId: job.id, count: batch.length, code: error.code },
          "push request failed; will retry",
        );
      } else {
        await this.repo.markFailed(ids, error.code);
        outcome.failed += batch.length;
        this.log.error(
          { jobId: job.id, count: batch.length, code: error.code },
          "push request refused",
        );
      }
      return;
    }

    const succeeded: string[] = [];
    for (const [index, delivery] of batch.entries()) {
      const ticket = tickets[index];
      if (!ticket) continue;
      if (ticket.status === "ok") {
        await this.repo.markAccepted(delivery.id, ticket.id);
        succeeded.push(delivery.deviceId);
        outcome.accepted += 1;
        continue;
      }
      await this.repo.recordDeviceError(delivery.deviceId, ticket.code);
      if (INVALID_TOKEN_ERRORS.has(ticket.code)) {
        await this.repo.markFailed([delivery.id], ticket.code);
        await this.repo.deactivateToken(delivery.deviceId, delivery.token, ticket.code);
        outcome.failed += 1;
      } else if (RETRYABLE_PUSH_ERRORS.has(ticket.code)) {
        await this.repo.scheduleRetry(
          [delivery.id],
          ticket.code,
          retryDelaySeconds(delivery.attempts),
          this.settings.maxAttempts,
        );
        outcome.retrying += 1;
      } else {
        await this.repo.markFailed([delivery.id], ticket.code);
        outcome.failed += 1;
      }
      this.log.warn(
        { jobId: job.id, deliveryId: delivery.id, code: ticket.code },
        "push ticket error",
      );
    }
    await this.repo.recordDeviceSuccess(succeeded);
  }

  // Asks Expo whether accepted pushes were handed to APNs/FCM. That is
  // still not proof the notification was shown.
  async checkReceipts(): Promise<number> {
    const candidates = await this.repo.receiptCandidates(
      this.settings.receiptDelaySeconds,
      RECEIPT_BATCH_LIMIT,
    );
    if (candidates.length > 0) {
      let receipts;
      try {
        receipts = await this.provider.receipts(candidates.map((c) => c.ticketId));
      } catch (error) {
        if (!(error instanceof PushProviderError)) throw error;
        this.log.warn({ count: candidates.length, code: error.code }, "push receipts unavailable");
        return 0;
      }
      const delivered: string[] = [];
      for (const candidate of candidates) {
        const receipt = receipts.get(candidate.ticketId);
        if (!receipt) continue;
        if (receipt.status === "ok") {
          delivered.push(candidate.id);
          continue;
        }
        await this.repo.markReceiptFailed(candidate.id, receipt.code);
        await this.repo.recordDeviceError(candidate.deviceId, receipt.code);
        if (INVALID_TOKEN_ERRORS.has(receipt.code)) {
          await this.repo.deactivateToken(candidate.deviceId, candidate.token, receipt.code);
        }
        this.log.warn({ deliveryId: candidate.id, code: receipt.code }, "push receipt error");
      }
      await this.repo.markProviderDelivered(delivered);
    }
    await this.repo.abandonOldReceipts();
    return candidates.length;
  }

  // Periodic pass: due jobs and retries, receipts, and housekeeping.
  async sweep(): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      await this.drain();
      await this.checkReceipts();
      await this.repo.clearExpiredMutes();
      await this.repo.pruneFinished(RETENTION_DAYS, PRUNE_BATCH);
    } finally {
      this.sweeping = false;
    }
  }

  start(intervalMs: number): void {
    if (intervalMs <= 0 || this.timer) return;
    const run = () => {
      this.sweep().catch((error: unknown) => {
        this.log.error({ err: errorText(error) }, "push sweep failed");
      });
    };
    run();
    this.timer = setInterval(run, intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
