import type { FastifyBaseLogger } from "fastify";

import type { RealtimePublisher } from "../../realtime/index.js";
import { toAttachmentDto } from "../media/media.types.js";
import { toMessageDto } from "../messages/messages.types.js";
import type { BroadcastsRepository } from "./broadcasts.repository.js";

// Recipients are delivered in batches; the owner gets a progress update
// after each batch rather than one event per recipient.
const BATCH_SIZE = 32;
// Each delivery locks a different direct chat, so a few run in parallel.
const CONCURRENCY = 4;
const SWEEP_BATCH = 20;
// The sweep leaves fresh broadcasts to the request that accepted them.
const SWEEP_MIN_AGE_MS = 10_000;

export type BroadcastUpdateReason =
  "accepted" | "progress" | "completed" | "delivered" | "read" | "retry";

async function eachWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next];
      next += 1;
      if (item !== undefined) await run(item);
    }
  });
  await Promise.all(workers);
}

// Turns accepted broadcasts into direct messages. Postgres is the queue:
// a recipient is pending until its direct message commits, so work that a
// crash or restart interrupted is picked up again by the sweep, and the
// row lock in deliver() keeps two workers from writing the same message.
export class BroadcastDispatcher {
  private timer: NodeJS.Timeout | undefined;
  private sweeping = false;

  constructor(
    private readonly repo: BroadcastsRepository,
    private readonly realtime: RealtimePublisher,
    private readonly log: FastifyBaseLogger,
    // Runs after a recipient's direct message committed.
    private readonly onMessageCommitted?: () => void,
  ) {}

  async process(broadcastId: string): Promise<void> {
    const recipients = await this.repo.pendingRecipientIds(broadcastId);
    for (let start = 0; start < recipients.length; start += BATCH_SIZE) {
      const batch = recipients.slice(start, start + BATCH_SIZE);
      await eachWithConcurrency(batch, CONCURRENCY, (recipientId) =>
        this.deliverOne(broadcastId, recipientId),
      );
      if (start + BATCH_SIZE < recipients.length) {
        await this.publishUpdate(broadcastId, "progress");
      }
    }
    const completed = await this.repo.finalize(broadcastId);
    await this.publishUpdate(broadcastId, completed ? "completed" : "progress");
  }

  private async deliverOne(broadcastId: string, recipientId: string): Promise<void> {
    let outcome;
    try {
      outcome = await this.repo.deliver(broadcastId, recipientId);
    } catch (error) {
      this.log.error(
        { err: error instanceof Error ? error.message : error, broadcastId },
        "broadcast delivery failed",
      );
      await this.repo
        .markFailed(this.repo.executor, broadcastId, recipientId, "DELIVERY_FAILED", true)
        .catch((markError: unknown) => {
          this.log.error(
            { err: markError instanceof Error ? markError.message : markError, broadcastId },
            "could not record broadcast delivery failure",
          );
        });
      return;
    }
    if (outcome.kind !== "sent") return;
    this.onMessageCommitted?.();

    // An ordinary direct message: both people in the chat get it, exactly
    // as if the sender had typed it there.
    const { message, attachment } = outcome;
    await this.realtime.publishMany([recipientId, message.senderId], {
      type: "message.new",
      chatId: message.chatId,
      message: toMessageDto(message, {
        attachment: attachment ? toAttachmentDto(attachment) : null,
      }),
    });
  }

  // Tells the owner's devices about a broadcast's new state.
  async publishUpdate(broadcastId: string, reason: BroadcastUpdateReason): Promise<void> {
    const owner = await this.repo.broadcastOwner(broadcastId);
    if (!owner || owner.listDeleted) return;
    const broadcast = (await this.repo.broadcasts(owner.ownerId, [broadcastId])).get(broadcastId);
    if (!broadcast) return;
    await this.realtime.publish(owner.ownerId, {
      type: "broadcast.updated",
      listId: owner.listId,
      reason,
      broadcast,
    });
  }

  // Re-drives accepted broadcasts that still have pending recipients.
  // Returns how many broadcasts it processed.
  async sweep(minAgeMs = SWEEP_MIN_AGE_MS): Promise<number> {
    if (this.sweeping) return 0;
    this.sweeping = true;
    try {
      const ids = await this.repo.sweepCandidates(minAgeMs, SWEEP_BATCH);
      for (const id of ids) await this.process(id);
      return ids.length;
    } finally {
      this.sweeping = false;
    }
  }

  start(intervalMs: number): void {
    if (intervalMs <= 0 || this.timer) return;
    const run = () => {
      this.sweep().catch((error: unknown) => {
        this.log.error(
          { err: error instanceof Error ? error.message : error },
          "broadcast sweep failed",
        );
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
