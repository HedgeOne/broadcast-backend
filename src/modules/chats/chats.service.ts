import { AppError } from "../../lib/errors.js";
import type { RateLimiter } from "../../lib/rate-limiter.js";
import type { RealtimePublisher } from "../../realtime/index.js";
import { chatErrors } from "./chats.errors.js";
import type { ChatsRepository } from "./chats.repository.js";
import type { MuteDuration } from "./chats.schemas.js";
import type { ChatSummary } from "./chats.types.js";

const MUTE_LIMIT = { limit: 60, windowSeconds: 60 };

export interface Receipts {
  deliveredSequence: number;
  readSequence: number;
}

export type DirectReceiptsListener = (
  userId: string,
  chatId: string,
  receipts: Receipts,
) => Promise<void>;

export class ChatsService {
  constructor(
    private readonly repository: ChatsRepository,
    private readonly realtime: RealtimePublisher,
    private readonly rateLimiter: RateLimiter,
    private readonly onDirectReceipts?: DirectReceiptsListener,
  ) {}

  list(userId: string): Promise<ChatSummary[]> {
    return this.repository.listForUser(userId);
  }

  async get(userId: string, chatId: string): Promise<ChatSummary> {
    const summary = await this.repository.findSummary(userId, chatId);
    if (!summary) throw chatErrors.chatNotFound();
    return summary;
  }

  // Opens the canonical direct chat with another user. An existing chat is
  // always returned (history stays readable after a block); a new one is
  // only created when neither user has blocked the other.
  async openDirect(userId: string, otherId: string): Promise<ChatSummary> {
    if (userId === otherId) throw chatErrors.cannotMessageSelf();

    const existingId = await this.repository.findDirectChatId(userId, otherId);
    if (existingId) {
      const summary = await this.repository.findSummary(userId, existingId);
      if (summary) return summary;
    }

    const other = await this.repository.findActiveUser(otherId);
    if (!other) throw chatErrors.userNotFound();

    const blocks = await this.repository.blockState(userId, otherId);
    if (blocks.byMe) throw chatErrors.blockedByYou();
    if (blocks.byThem) throw chatErrors.recipientUnavailable();

    const chatId = await this.repository.findOrCreateDirectChat(userId, otherId);
    return this.get(userId, chatId);
  }

  // Personal to the caller: other members' notifications are unaffected and
  // nobody else can see it. Repeating the same request is harmless (a timed
  // mute restarts from now). null unmutes.
  async setMute(
    userId: string,
    chatId: string,
    duration: MuteDuration | null,
  ): Promise<ChatSummary> {
    const limit = await this.rateLimiter.consume(
      `chat:mute:${userId}`,
      MUTE_LIMIT.limit,
      MUTE_LIMIT.windowSeconds,
    );
    if (!limit.allowed) {
      throw new AppError(429, "RATE_LIMITED", "You're changing mute settings too quickly.", {
        retryAfterSeconds: limit.retryAfterSeconds,
      });
    }
    if (!(await this.repository.findMembership(userId, chatId))) throw chatErrors.chatNotFound();
    if (!(await this.repository.setMute(userId, chatId, duration))) throw chatErrors.chatNotFound();
    return this.get(userId, chatId);
  }

  // Advances the caller's delivered/read pointers and tells both sides.
  // The other user only sees read progress when both allow read receipts.
  async advanceReceipts(
    userId: string,
    chatId: string,
    update: { deliveredSequence?: number | undefined; readSequence?: number | undefined },
  ): Promise<Receipts> {
    const membership = await this.repository.findMembership(userId, chatId);
    if (!membership) throw chatErrors.chatNotFound();

    const before =
      membership.type === "group" ? await this.repository.groupReceipts(chatId) : undefined;
    const result = await this.repository.advanceReceipts(
      userId,
      chatId,
      update.deliveredSequence ?? 0,
      update.readSequence ?? 0,
    );
    if (!result) throw chatErrors.chatNotFound();
    const receipts = {
      deliveredSequence: result.deliveredSequence,
      readSequence: result.readSequence,
    };
    if (!result.changed) return receipts;

    if (before) {
      await this.realtime.publish(userId, { type: "receipt.updated", chatId, userId, ...receipts });
      // Senders' ticks only move when the slowest member catches up.
      const after = await this.repository.groupReceipts(chatId);
      if (after.delivered !== before.delivered || after.read !== before.read) {
        await this.realtime.publishMany(await this.repository.activeMemberIds(chatId), {
          type: "receipts.aggregate",
          chatId,
          deliveredSequence: after.delivered,
          readSequence: after.read,
        });
      }
      return receipts;
    }

    const peerId = membership.peerId;
    if (peerId) {
      const visible = await this.repository.readReceiptsVisible(userId, peerId);
      const event = {
        type: "receipt.updated" as const,
        chatId,
        userId,
        deliveredSequence: result.deliveredSequence,
      };
      await Promise.all([
        this.realtime.publish(peerId, {
          ...event,
          readSequence: visible ? result.readSequence : null,
        }),
        // The caller's other devices update their unread state.
        this.realtime.publish(userId, { ...event, readSequence: result.readSequence }),
      ]);
    }

    // Pointers only grow and the listener covers every message up to them,
    // so if this fails the next receipt in the chat catches up.
    await this.onDirectReceipts?.(userId, chatId, receipts).catch(() => undefined);

    return receipts;
  }
}
