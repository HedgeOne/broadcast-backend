import type { Message } from "../../db/schema/index.js";
import { AppError } from "../../lib/errors.js";
import type { RateLimiter } from "../../lib/rate-limiter.js";
import type { RealtimeEvent, RealtimePublisher } from "../../realtime/index.js";
import type { AuthContext } from "../auth/auth.types.js";
import { lockChat, type Tx } from "../chats/chat-tx.js";
import { chatErrors } from "../chats/chats.errors.js";
import type { ChatMembership, ChatsRepository } from "../chats/chats.repository.js";
import { groupErrors } from "../groups/groups.errors.js";
import { can, canActOn } from "../groups/groups.policy.js";
import { settingsOf, type GroupsRepository } from "../groups/groups.repository.js";
import { toAttachmentDto, type AttachmentDto } from "../media/media.types.js";
import {
  replyPreview,
  type Hydration,
  type MessagesRepository,
  type SharedKind,
} from "./messages.repository.js";
import type { SendMessageBody } from "./messages.schemas.js";
import { toMessageDto, type MessageDto, type ReactionDto } from "./messages.types.js";

const SEND_LIMIT = { limit: 120, windowSeconds: 60 };
const REACT_LIMIT = { limit: 120, windowSeconds: 60 };
const DELETE_LIMIT = { limit: 60, windowSeconds: 60 };
const STAR_LIMIT = { limit: 120, windowSeconds: 60 };
const CLEAR_LIMIT = { limit: 30, windowSeconds: 60 * 60 };

function attachmentDtoOf(
  attachment: Parameters<typeof toAttachmentDto>[0] | undefined,
): AttachmentDto | null {
  return attachment ? toAttachmentDto(attachment) : null;
}

export interface MessagesServiceDeps {
  messages: MessagesRepository;
  chats: ChatsRepository;
  groups: GroupsRepository;
  realtime: RealtimePublisher;
  rateLimiter: RateLimiter;
  // Runs after a new message committed (its push job is already queued).
  onMessageCommitted?: () => void;
}

export class MessagesService {
  constructor(private readonly deps: MessagesServiceDeps) {}

  private async requireMembership(
    userId: string,
    chatId: string,
    executor?: Tx,
  ): Promise<ChatMembership> {
    const membership = await this.deps.chats.findMembership(userId, chatId, executor);
    if (!membership) throw chatErrors.chatNotFound();
    return membership;
  }

  private async limit(
    key: string,
    rule: { limit: number; windowSeconds: number },
    message: string,
  ): Promise<void> {
    const result = await this.deps.rateLimiter.consume(key, rule.limit, rule.windowSeconds);
    if (!result.allowed) {
      throw new AppError(429, "RATE_LIMITED", message, {
        retryAfterSeconds: result.retryAfterSeconds,
      });
    }
  }

  // Direct chats: the block rules that gate sending also gate reacting.
  private async assertDirectReachable(userId: string, peerId: string): Promise<void> {
    const blocks = await this.deps.chats.blockState(userId, peerId);
    if (blocks.byMe) throw chatErrors.blockedByYou();
    if (blocks.byThem || !(await this.deps.chats.findActiveUser(peerId))) {
      throw chatErrors.recipientUnavailable();
    }
  }

  // `starred` is the requesting user's stars; leave it out for DTOs that
  // are shared with other members.
  private dto(
    message: Message,
    hydration: Hydration,
    historyFrom: number,
    starred?: Set<string>,
  ): MessageDto {
    const target = message.replyToMessageId
      ? hydration.replies.get(message.replyToMessageId)
      : undefined;
    return toMessageDto(message, {
      replyTo: message.replyToMessageId
        ? replyPreview(target, message.replyToMessageId, historyFrom)
        : null,
      mentions: hydration.mentions.get(message.id) ?? [],
      reactions: hydration.reactions.get(message.id) ?? [],
      attachment: attachmentDtoOf(hydration.attachments.get(message.id)),
      ...(starred ? { starred: starred.has(message.id) } : {}),
    });
  }

  // DTOs for the requesting user, with their stars.
  private async ownDtos(
    userId: string,
    list: Message[],
    historyFrom: number,
  ): Promise<MessageDto[]> {
    const ids = list.map((message) => message.id);
    const [hydration, starred] = await Promise.all([
      this.deps.messages.hydrate(list),
      this.deps.messages.starredIds(userId, ids),
    ]);
    return list.map((message) => this.dto(message, hydration, historyFrom, starred));
  }

  private async hydrateOne(message: Message, historyFrom: number): Promise<MessageDto> {
    return this.dto(message, await this.deps.messages.hydrate([message]), historyFrom);
  }

  private recipients(
    chatId: string,
    membership: ChatMembership,
    userId: string,
  ): Promise<string[]> {
    if (membership.type === "direct") {
      return Promise.resolve(membership.peerId ? [membership.peerId, userId] : [userId]);
    }
    return this.deps.chats.activeMemberIds(chatId);
  }

  // A reply quote must not reveal a message from before a recipient
  // joined, so recipients get the preview their own history allows.
  private async publishMessage(
    chatId: string,
    membership: ChatMembership,
    userId: string,
    message: Message,
    type: "message.new" | "message.deleted",
  ): Promise<void> {
    const hydration = await this.deps.messages.hydrate([message]);
    if (membership.type === "direct" || !message.replyToMessageId) {
      const event: RealtimeEvent = { type, chatId, message: this.dto(message, hydration, 0) };
      await this.deps.realtime.publishMany(
        await this.recipients(chatId, membership, userId),
        event,
      );
      return;
    }

    const history = await this.deps.messages.memberHistory(chatId);
    const byHistory = new Map<number, string[]>();
    for (const [memberId, from] of history) {
      byHistory.set(from, [...(byHistory.get(from) ?? []), memberId]);
    }
    await Promise.all(
      [...byHistory].map(([from, ids]) =>
        this.deps.realtime.publishMany(ids, {
          type,
          chatId,
          message: this.dto(message, hydration, from),
        }),
      ),
    );
  }

  // A message counts as sent only once it is committed with a sequence.
  // Retries with the same client message ID return the stored message.
  async send(
    auth: AuthContext,
    chatId: string,
    body: SendMessageBody,
  ): Promise<{ message: MessageDto; created: boolean }> {
    const membership = await this.requireMembership(auth.userId, chatId);

    // A retry of a message that was already stored succeeds even if the
    // situation changed since (e.g. a block), because it was already sent.
    const stored = await this.deps.messages.findByClientId(auth.deviceId, body.clientMessageId);
    if (stored) {
      if (stored.chatId !== chatId) throw chatErrors.clientMessageIdConflict();
      return { message: await this.hydrateOne(stored, membership.historyFrom), created: false };
    }

    const mentions = body.mentions ?? [];
    if (membership.type === "direct") {
      if (mentions.length > 0) throw chatErrors.mentionsNotAllowed();
      await this.assertDirectReachable(auth.userId, membership.peerId ?? "");
    }

    await this.limit(`msg:send:${auth.userId}`, SEND_LIMIT, "You're sending messages too quickly.");

    const result = await this.deps.messages.send(
      {
        chatId,
        senderId: auth.userId,
        senderDeviceId: auth.deviceId,
        clientMessageId: body.clientMessageId,
        type: body.type,
        ciphertext: Buffer.from(body.ciphertext, "base64"),
        replyToMessageId: body.replyToMessageId ?? null,
        mentions,
        attachment: body.attachment ?? null,
      },
      // Re-checked under the chat lock: a removal or settings change that
      // committed first wins.
      async (tx) => {
        const current = await this.requireMembership(auth.userId, chatId, tx);
        if (current.type === "group") {
          const group = await this.deps.groups.findGroup(tx, chatId);
          if (!group) throw chatErrors.chatNotFound();
          if (!can("sendMessage", current.role, settingsOf(group))) {
            throw groupErrors.onlyAdminsCanSend();
          }
          if (mentions.length > 0) {
            const roles = await this.deps.groups.activeRoles(tx, chatId, mentions);
            const invalid = mentions.filter((id) => !roles.has(id));
            if (invalid.length > 0) throw chatErrors.invalidMentions(invalid);
          }
        }
        if (body.replyToMessageId) {
          const target = await this.deps.messages.findInChat(tx, chatId, body.replyToMessageId);
          if (
            !target ||
            target.deletedAt !== null ||
            target.type === "system" ||
            target.sequence <= current.historyFrom
          ) {
            throw chatErrors.replyUnavailable();
          }
        }
      },
    );
    if (result.message.chatId !== chatId) throw chatErrors.clientMessageIdConflict();

    if (result.created) {
      this.deps.onMessageCommitted?.();
      await this.publishMessage(chatId, membership, auth.userId, result.message, "message.new");
    }
    return {
      message: await this.hydrateOne(result.message, membership.historyFrom),
      created: result.created,
    };
  }

  async list(
    userId: string,
    chatId: string,
    query: { after?: number | undefined; before?: number | undefined; limit: number },
  ): Promise<{ messages: MessageDto[]; hasMore: boolean }> {
    const membership = await this.requireMembership(userId, chatId);
    const page = await this.deps.messages.list(chatId, {
      ...query,
      historyFrom: membership.historyFrom,
    });
    return {
      messages: await this.ownDtos(userId, page.messages, membership.historyFrom),
      hasMore: page.hasMore,
    };
  }

  // Media or documents shared in the conversation, as far back as the
  // caller's history goes (Clear Chat included), newest first.
  async shared(
    userId: string,
    chatId: string,
    query: { kind: SharedKind; before?: number | undefined; limit: number },
  ): Promise<{ messages: MessageDto[]; hasMore: boolean }> {
    const membership = await this.requireMembership(userId, chatId);
    const page = await this.deps.messages.shared(chatId, {
      ...query,
      historyFrom: membership.historyFrom,
    });
    return {
      messages: await this.ownDtos(userId, page.messages, membership.historyFrom),
      hasMore: page.hasMore,
    };
  }

  // The caller's starred messages in this chat, newest first. Stars kept
  // through Clear Chat are included; `inHistory` is false for those (they
  // can be opened but not scrolled to).
  async starred(
    userId: string,
    chatId: string,
    query: { before?: number | undefined; limit: number },
  ): Promise<{ messages: (MessageDto & { inHistory: boolean })[]; hasMore: boolean }> {
    const membership = await this.requireMembership(userId, chatId);
    const page = await this.deps.messages.starred(userId, chatId, query);
    const dtos = await this.ownDtos(userId, page.messages, membership.historyFrom);
    return {
      messages: dtos.map((dto) => ({ ...dto, inHistory: dto.sequence > membership.historyFrom })),
      hasMore: page.hasMore,
    };
  }

  // Idempotent. Starring needs a live, visible, non-system message;
  // unstarring works on anything the caller starred in this chat, including
  // messages kept through Clear Chat. Only the caller's devices are told.
  async star(
    userId: string,
    chatId: string,
    messageId: string,
    starred: boolean,
  ): Promise<{ messageId: string; starred: boolean }> {
    await this.requireMembership(userId, chatId);
    await this.limit(`msg:star:${userId}`, STAR_LIMIT, "You're starring messages too quickly.");

    const changed = await this.deps.messages.transaction(async (tx) => {
      // Serialises with deletion, which removes every star on the message.
      await lockChat(tx, chatId);
      const current = await this.requireMembership(userId, chatId, tx);
      const target = await this.deps.messages.findInChat(tx, chatId, messageId);
      if (!target) throw chatErrors.messageNotFound();
      if (!starred) return this.deps.messages.setStar(tx, userId, messageId, false);
      if (target.sequence <= current.historyFrom) throw chatErrors.messageNotFound();
      if (target.deletedAt !== null || target.type === "system") {
        throw chatErrors.starNotAllowed();
      }
      return this.deps.messages.setStar(tx, userId, messageId, true);
    });

    if (changed) {
      await this.deps.realtime.publish(userId, {
        type: "message.starred",
        chatId,
        messageId,
        starred,
      });
    }
    return { messageId, starred };
  }

  // Clear Chat: hides everything up to now from the caller only. Nothing is
  // deleted and no other member is told; the caller stays in the chat and
  // the chat stays in their list. Their other devices drop the history on
  // the chat.cleared event (or on their next chat list refresh).
  async clear(
    userId: string,
    chatId: string,
    keepStarred: boolean,
  ): Promise<{ chatId: string; clearedThroughSequence: number }> {
    await this.requireMembership(userId, chatId);
    await this.limit(`chat:clear:${userId}`, CLEAR_LIMIT, "You're clearing chats too quickly.");

    const cleared = await this.deps.messages.transaction(async (tx) => {
      await lockChat(tx, chatId);
      await this.requireMembership(userId, chatId, tx);
      return this.deps.messages.clearHistory(tx, chatId, userId, keepStarred);
    });

    await this.deps.realtime.publish(userId, {
      type: "chat.cleared",
      chatId,
      clearedThroughSequence: cleared,
    });
    return { chatId, clearedThroughSequence: cleared };
  }

  // Sets (or with null, removes) the caller's single reaction.
  async react(
    userId: string,
    chatId: string,
    messageId: string,
    emoji: string | null,
  ): Promise<{ messageId: string; reactions: ReactionDto[] }> {
    const membership = await this.requireMembership(userId, chatId);
    if (membership.type === "direct" && emoji !== null) {
      await this.assertDirectReachable(userId, membership.peerId ?? "");
    }
    await this.limit(`msg:react:${userId}`, REACT_LIMIT, "You're reacting too quickly.");

    const changed = await this.deps.messages.transaction(async (tx) => {
      await lockChat(tx, chatId);
      const current = await this.requireMembership(userId, chatId, tx);
      const target = await this.deps.messages.findInChat(tx, chatId, messageId);
      if (!target || target.sequence <= current.historyFrom) throw chatErrors.messageNotFound();
      if (target.deletedAt !== null || target.type === "system") {
        throw chatErrors.reactionNotAllowed();
      }
      return this.deps.messages.setReaction(tx, messageId, userId, emoji);
    });

    if (changed) {
      await this.deps.realtime.publishMany(await this.recipients(chatId, membership, userId), {
        type: "reaction.updated",
        chatId,
        messageId,
        userId,
        emoji,
      });
    }
    return { messageId, reactions: await this.deps.messages.reactionsFor(messageId) };
  }

  // Senders can delete their own messages. In groups, admins can delete
  // messages from people they outrank (former members count as members).
  async delete(userId: string, chatId: string, messageId: string): Promise<MessageDto> {
    const membership = await this.requireMembership(userId, chatId);
    await this.limit(`msg:delete:${userId}`, DELETE_LIMIT, "You're deleting messages too quickly.");

    const result = await this.deps.messages.transaction(async (tx) => {
      await lockChat(tx, chatId);
      const current = await this.requireMembership(userId, chatId, tx);
      const target = await this.deps.messages.findInChat(tx, chatId, messageId);
      if (!target || target.sequence <= current.historyFrom || target.type === "system") {
        throw chatErrors.messageNotFound();
      }
      if (target.deletedAt !== null) return { message: target, changed: false };

      if (target.senderId !== userId) {
        if (current.type !== "group") throw chatErrors.deleteForbidden();
        const roles = await this.deps.groups.activeRoles(tx, chatId, [target.senderId]);
        const senderRole = roles.get(target.senderId) ?? "member";
        if (!canActOn("deleteMessage", current.role, senderRole))
          throw chatErrors.deleteForbidden();
      }
      return {
        message: await this.deps.messages.markDeleted(tx, messageId, userId),
        changed: true,
      };
    });

    if (result.changed) {
      await this.publishMessage(chatId, membership, userId, result.message, "message.deleted");
    }
    return toMessageDto(result.message);
  }
}
