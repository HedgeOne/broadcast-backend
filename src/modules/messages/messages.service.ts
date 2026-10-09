import { AppError } from "../../lib/errors.js";
import type { RateLimiter } from "../../lib/rate-limiter.js";
import type { RealtimePublisher } from "../../realtime/index.js";
import type { AuthContext } from "../auth/auth.types.js";
import { chatErrors } from "../chats/chats.errors.js";
import type { ChatsRepository } from "../chats/chats.repository.js";
import type { MessagesRepository } from "./messages.repository.js";
import type { SendMessageBody } from "./messages.schemas.js";
import { toMessageDto, type MessageDto } from "./messages.types.js";

const SEND_LIMIT = { limit: 120, windowSeconds: 60 };

export interface MessagesServiceDeps {
  messages: MessagesRepository;
  chats: ChatsRepository;
  realtime: RealtimePublisher;
  rateLimiter: RateLimiter;
}

export class MessagesService {
  constructor(private readonly deps: MessagesServiceDeps) {}

  private async requireMembership(userId: string, chatId: string) {
    const membership = await this.deps.chats.findDirectMembership(userId, chatId);
    if (!membership) throw chatErrors.chatNotFound();
    return membership;
  }

  // A message counts as sent only once it is committed with a sequence.
  // Retries with the same client message ID return the stored message.
  async send(
    auth: AuthContext,
    chatId: string,
    body: SendMessageBody,
  ): Promise<{ message: MessageDto; created: boolean }> {
    const { peerId } = await this.requireMembership(auth.userId, chatId);

    // A retry of a message that was already stored succeeds even if the
    // situation changed since (e.g. a block), because it was already sent.
    const stored = await this.deps.messages.findByClientId(auth.deviceId, body.clientMessageId);
    if (stored) {
      if (stored.chatId !== chatId) throw chatErrors.clientMessageIdConflict();
      return { message: toMessageDto(stored), created: false };
    }

    const blocks = await this.deps.chats.blockState(auth.userId, peerId);
    if (blocks.byMe) throw chatErrors.blockedByYou();
    if (blocks.byThem || !(await this.deps.chats.findActiveUser(peerId))) {
      throw chatErrors.recipientUnavailable();
    }

    const limit = await this.deps.rateLimiter.consume(
      `msg:send:${auth.userId}`,
      SEND_LIMIT.limit,
      SEND_LIMIT.windowSeconds,
    );
    if (!limit.allowed) {
      throw new AppError(429, "RATE_LIMITED", "You're sending messages too quickly.", {
        retryAfterSeconds: limit.retryAfterSeconds,
      });
    }

    const result = await this.deps.messages.send({
      chatId,
      senderId: auth.userId,
      senderDeviceId: auth.deviceId,
      clientMessageId: body.clientMessageId,
      type: body.type,
      ciphertext: Buffer.from(body.ciphertext, "base64"),
    });
    if (result.message.chatId !== chatId) throw chatErrors.clientMessageIdConflict();

    const message = toMessageDto(result.message);
    if (result.created) {
      const event = { type: "message.new" as const, chatId, message };
      await Promise.all([
        this.deps.realtime.publish(peerId, event),
        this.deps.realtime.publish(auth.userId, event),
      ]);
    }
    return { message, created: result.created };
  }

  async list(
    userId: string,
    chatId: string,
    query: { after?: number | undefined; before?: number | undefined; limit: number },
  ): Promise<{ messages: MessageDto[]; hasMore: boolean }> {
    await this.requireMembership(userId, chatId);
    const page = await this.deps.messages.list(chatId, query);
    return { messages: page.messages.map(toMessageDto), hasMore: page.hasMore };
  }
}
