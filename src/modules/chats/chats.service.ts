import type { RealtimePublisher } from "../../realtime/index.js";
import { chatErrors } from "./chats.errors.js";
import type { ChatsRepository } from "./chats.repository.js";
import type { ChatSummary } from "./chats.types.js";

export interface Receipts {
  deliveredSequence: number;
  readSequence: number;
}

export class ChatsService {
  constructor(
    private readonly repository: ChatsRepository,
    private readonly realtime: RealtimePublisher,
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

  async setMuted(userId: string, chatId: string, muted: boolean): Promise<ChatSummary> {
    if (!(await this.repository.setMuted(userId, chatId, muted))) throw chatErrors.chatNotFound();
    return this.get(userId, chatId);
  }

  // Advances the caller's delivered/read pointers and tells both sides.
  // The other user only sees read progress when both allow read receipts.
  async advanceReceipts(
    userId: string,
    chatId: string,
    update: { deliveredSequence?: number | undefined; readSequence?: number | undefined },
  ): Promise<Receipts> {
    const membership = await this.repository.findDirectMembership(userId, chatId);
    if (!membership) throw chatErrors.chatNotFound();

    const result = await this.repository.advanceReceipts(
      userId,
      chatId,
      update.deliveredSequence ?? 0,
      update.readSequence ?? 0,
    );
    if (!result) throw chatErrors.chatNotFound();

    if (result.changed) {
      const visible = await this.repository.readReceiptsVisible(userId, membership.peerId);
      const event = {
        type: "receipt.updated" as const,
        chatId,
        userId,
        deliveredSequence: result.deliveredSequence,
      };
      await Promise.all([
        this.realtime.publish(membership.peerId, {
          ...event,
          readSequence: visible ? result.readSequence : null,
        }),
        // The caller's other devices update their unread state.
        this.realtime.publish(userId, { ...event, readSequence: result.readSequence }),
      ]);
    }

    return { deliveredSequence: result.deliveredSequence, readSequence: result.readSequence };
  }
}
