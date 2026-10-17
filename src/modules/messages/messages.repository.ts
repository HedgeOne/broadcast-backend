import { and, asc, desc, eq, gt, inArray, isNull, lt, sql } from "drizzle-orm";

import type { Database } from "../../db/client.js";
import {
  chatMembers,
  messageAttachments,
  messageMentions,
  messageReactions,
  messages,
  starredMessages,
  type Message,
  type MessageAttachment,
} from "../../db/schema/index.js";
import { lockChat, nextSequence, type Tx } from "../chats/chat-tx.js";
import { attachmentsFor, claimMedia, insertAttachment } from "../media/media.repository.js";
import type { MediaCategory } from "../media/media.policy.js";
import { enqueueMessageNotification } from "../notifications/notifications.outbox.js";
import type { ReactionDto, ReplyPreviewDto } from "./messages.types.js";

export function isMediaType(type: Message["type"]): type is MediaCategory {
  return type === "image" || type === "video" || type === "audio" || type === "document";
}

function mediaCategoryOf(type: Message["type"]): MediaCategory {
  if (!isMediaType(type)) throw new Error(`message type ${type} carries no media`);
  return type;
}

export interface NewOutgoingMessage {
  chatId: string;
  senderId: string;
  senderDeviceId: string;
  clientMessageId: string;
  type: Message["type"];
  ciphertext: Buffer;
  encryptedMetadata?: Buffer | null;
  replyToMessageId: string | null;
  mentions: string[];
  attachment: { uploadId: string; thumbnailUploadId?: string | undefined } | null;
}

export interface SendResult {
  message: Message;
  // False when this client message ID was already stored (a retry).
  created: boolean;
}

// Shared content tabs served by the server; links are found on the device,
// which is the only place message bodies are read.
export type SharedKind = "media" | "docs";

export interface MessagePage {
  messages: Message[];
  hasMore: boolean;
}

export interface Hydration {
  mentions: Map<string, string[]>;
  reactions: Map<string, ReactionDto[]>;
  replies: Map<string, Message>;
  attachments: Map<string, MessageAttachment>;
}

// What a reader whose history starts after `historyFrom` may see of the
// replied-to message.
export function replyPreview(
  target: Message | undefined,
  replyToId: string,
  historyFrom: number,
): ReplyPreviewDto {
  if (!target || target.deletedAt !== null || target.sequence <= historyFrom) {
    return { id: replyToId, available: false, senderId: null, type: null, ciphertext: null };
  }
  // Quote bodies live inside the encrypted payload on each device. The server
  // must not reconstruct or return message plaintext in reply previews.
  return {
    id: target.id,
    available: true,
    senderId: target.senderId,
    type: target.type,
    ciphertext: null,
  };
}

export class MessagesRepository {
  constructor(private readonly db: Database) {}

  transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.db.transaction(fn);
  }

  async findByClientId(
    senderDeviceId: string,
    clientMessageId: string,
  ): Promise<Message | undefined> {
    const [message] = await this.db
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.senderDeviceId, senderDeviceId),
          eq(messages.clientMessageId, clientMessageId),
        ),
      );
    return message;
  }

  async findInChat(
    executor: Database | Tx,
    chatId: string,
    messageId: string,
  ): Promise<Message | undefined> {
    const [message] = await executor
      .select()
      .from(messages)
      .where(and(eq(messages.id, messageId), eq(messages.chatId, chatId)));
    return message;
  }

  // Persists a message with the next per-chat sequence. Locking the chat row
  // serialises senders and membership changes in a chat, so sequences are
  // gap-free, a retried client message ID finds the first attempt's row,
  // and `authorize` sees membership exactly as it is at insert time.
  async send(input: NewOutgoingMessage, authorize: (tx: Tx) => Promise<void>): Promise<SendResult> {
    return this.db.transaction(async (tx) => {
      await lockChat(tx, input.chatId);

      const [existing] = await tx
        .select()
        .from(messages)
        .where(
          and(
            eq(messages.senderDeviceId, input.senderDeviceId),
            eq(messages.clientMessageId, input.clientMessageId),
          ),
        );
      if (existing) return { message: existing, created: false };

      await authorize(tx);

      const media = input.attachment
        ? await claimMedia(tx, input.senderId, {
            ...input.attachment,
            category: mediaCategoryOf(input.type),
          })
        : null;

      const sequence = await nextSequence(tx, input.chatId);
      const { mentions, attachment: _attachment, ...row } = input;
      const [message] = await tx
        .insert(messages)
        .values({ ...row, sequence })
        .returning();
      if (!message) throw new Error("message insert returned no row");

      if (media) await insertAttachment(tx, message.id, media);
      await enqueueMessageNotification(tx, message);

      if (mentions.length > 0) {
        await tx
          .insert(messageMentions)
          .values(mentions.map((userId) => ({ messageId: message.id, userId })));
      }

      // The sender has trivially received and read their own message.
      await tx
        .update(chatMembers)
        .set({ lastDeliveredSequence: sequence, lastReadSequence: sequence })
        .where(
          and(
            eq(chatMembers.chatId, input.chatId),
            eq(chatMembers.userId, input.senderId),
            isNull(chatMembers.leftAt),
          ),
        );

      return { message, created: true };
    });
  }

  // Ascending by sequence, deleted messages included as tombstones, and
  // nothing at or below `historyFrom`. `after` syncs forward from a known
  // sequence; `before` pages backwards; neither returns the latest page.
  async list(
    chatId: string,
    options: {
      after?: number | undefined;
      before?: number | undefined;
      limit: number;
      historyFrom: number;
    },
  ): Promise<MessagePage> {
    const base = eq(messages.chatId, chatId);

    if (options.after !== undefined) {
      const rows = await this.db
        .select()
        .from(messages)
        .where(and(base, gt(messages.sequence, Math.max(options.after, options.historyFrom))))
        .orderBy(asc(messages.sequence))
        .limit(options.limit + 1);
      return { messages: rows.slice(0, options.limit), hasMore: rows.length > options.limit };
    }

    const rows = await this.db
      .select()
      .from(messages)
      .where(
        and(
          base,
          gt(messages.sequence, options.historyFrom),
          options.before !== undefined ? lt(messages.sequence, options.before) : undefined,
        ),
      )
      .orderBy(desc(messages.sequence))
      .limit(options.limit + 1);
    return {
      messages: rows.slice(0, options.limit).reverse(),
      hasMore: rows.length > options.limit,
    };
  }

  // Mentions, reactions and reply targets for a batch of messages.
  async hydrate(list: Message[]): Promise<Hydration> {
    const hydration: Hydration = {
      mentions: new Map(),
      reactions: new Map(),
      replies: new Map(),
      attachments: new Map(),
    };
    const ids = list.map((message) => message.id);
    if (ids.length === 0) return hydration;
    const replyIds = [
      ...new Set(list.map((message) => message.replyToMessageId).filter((id) => id !== null)),
    ];
    const mediaIds = list
      .filter((message) => message.deletedAt === null && isMediaType(message.type))
      .map((message) => message.id);

    const [mentionRows, reactionRows, replyRows, attachments] = await Promise.all([
      this.db.select().from(messageMentions).where(inArray(messageMentions.messageId, ids)),
      this.db
        .select()
        .from(messageReactions)
        .where(inArray(messageReactions.messageId, ids))
        .orderBy(asc(messageReactions.createdAt), asc(messageReactions.userId)),
      replyIds.length > 0
        ? this.db.select().from(messages).where(inArray(messages.id, replyIds))
        : Promise.resolve([]),
      attachmentsFor(this.db, mediaIds),
    ]);
    hydration.attachments = attachments;

    for (const row of mentionRows) {
      const entry = hydration.mentions.get(row.messageId) ?? [];
      entry.push(row.userId);
      hydration.mentions.set(row.messageId, entry);
    }
    for (const row of reactionRows) {
      const entry = hydration.reactions.get(row.messageId) ?? [];
      entry.push({ userId: row.userId, emoji: row.emoji });
      hydration.reactions.set(row.messageId, entry);
    }
    for (const row of replyRows) hydration.replies.set(row.id, row);
    return hydration;
  }

  async reactionsFor(messageId: string): Promise<ReactionDto[]> {
    return this.db
      .select({ userId: messageReactions.userId, emoji: messageReactions.emoji })
      .from(messageReactions)
      .where(eq(messageReactions.messageId, messageId))
      .orderBy(asc(messageReactions.createdAt), asc(messageReactions.userId));
  }

  // One reaction per user per message; null removes it. Returns whether
  // anything changed.
  async setReaction(
    tx: Tx,
    messageId: string,
    userId: string,
    emoji: string | null,
  ): Promise<boolean> {
    if (emoji === null) {
      const removed = await tx
        .delete(messageReactions)
        .where(and(eq(messageReactions.messageId, messageId), eq(messageReactions.userId, userId)))
        .returning({ userId: messageReactions.userId });
      return removed.length > 0;
    }
    const result = await tx.execute(sql`
      INSERT INTO message_reactions (message_id, user_id, emoji)
      VALUES (${messageId}, ${userId}, ${emoji})
      ON CONFLICT (message_id, user_id) DO UPDATE
        SET emoji = EXCLUDED.emoji, created_at = NOW()
        WHERE message_reactions.emoji IS DISTINCT FROM EXCLUDED.emoji
      RETURNING message_id
    `);
    return result.rows.length > 0;
  }

  // A conversation's media (photos, videos, audio) or documents, newest
  // first by sequence. Only live messages the reader can see, with their
  // attachment row (the partial indexes match these filters).
  async shared(
    chatId: string,
    options: { kind: SharedKind; before?: number | undefined; limit: number; historyFrom: number },
  ): Promise<MessagePage> {
    const types: Message["type"][] =
      options.kind === "docs" ? ["document"] : ["image", "video", "audio"];
    const rows = await this.db
      .select({ message: messages })
      .from(messages)
      .innerJoin(messageAttachments, eq(messageAttachments.messageId, messages.id))
      .where(
        and(
          eq(messages.chatId, chatId),
          inArray(messages.type, types),
          isNull(messages.deletedAt),
          gt(messages.sequence, options.historyFrom),
          options.before !== undefined ? lt(messages.sequence, options.before) : undefined,
        ),
      )
      .orderBy(desc(messages.sequence))
      .limit(options.limit + 1);
    return {
      messages: rows.slice(0, options.limit).map((row) => row.message),
      hasMore: rows.length > options.limit,
    };
  }

  // The user's starred messages in a chat, newest first by sequence. A star
  // outlives the user's Clear Chat when they chose to keep starred messages,
  // so this is deliberately not limited to the visible history.
  async starred(
    userId: string,
    chatId: string,
    options: { before?: number | undefined; limit: number },
  ): Promise<MessagePage> {
    const rows = await this.db
      .select({ message: messages })
      .from(starredMessages)
      .innerJoin(messages, eq(messages.id, starredMessages.messageId))
      .where(
        and(
          eq(starredMessages.userId, userId),
          eq(messages.chatId, chatId),
          isNull(messages.deletedAt),
          options.before !== undefined ? lt(messages.sequence, options.before) : undefined,
        ),
      )
      .orderBy(desc(messages.sequence))
      .limit(options.limit + 1);
    return {
      messages: rows.slice(0, options.limit).map((row) => row.message),
      hasMore: rows.length > options.limit,
    };
  }

  async starredIds(userId: string, messageIds: string[]): Promise<Set<string>> {
    if (messageIds.length === 0) return new Set();
    const rows = await this.db
      .select({ messageId: starredMessages.messageId })
      .from(starredMessages)
      .where(
        and(eq(starredMessages.userId, userId), inArray(starredMessages.messageId, messageIds)),
      );
    return new Set(rows.map((row) => row.messageId));
  }

  // Idempotent; returns whether anything changed.
  async setStar(
    executor: Database | Tx,
    userId: string,
    messageId: string,
    starred: boolean,
  ): Promise<boolean> {
    if (!starred) {
      const removed = await executor
        .delete(starredMessages)
        .where(and(eq(starredMessages.userId, userId), eq(starredMessages.messageId, messageId)))
        .returning({ messageId: starredMessages.messageId });
      return removed.length > 0;
    }
    const inserted = await executor
      .insert(starredMessages)
      .values({ userId, messageId })
      .onConflictDoNothing()
      .returning({ messageId: starredMessages.messageId });
    return inserted.length > 0;
  }

  // Clear Chat for one member, under the chat lock (held by the caller), so
  // the marker is exactly the last message that exists: anything sent after
  // gets a higher sequence and stays visible. The marker never moves back.
  // Without keepStarred the member's stars on cleared messages go too.
  async clearHistory(
    tx: Tx,
    chatId: string,
    userId: string,
    keepStarred: boolean,
  ): Promise<number> {
    const result = await tx.execute<{ cleared: string | number }>(sql`
      UPDATE chat_members me SET
        cleared_through_sequence = GREATEST(me.cleared_through_sequence, latest.sequence),
        history_from_sequence = GREATEST(me.history_from_sequence, latest.sequence),
        cleared_at = NOW()
      FROM (
        SELECT COALESCE(MAX(sequence), 0) AS sequence FROM messages WHERE chat_id = ${chatId}
      ) latest
      WHERE me.chat_id = ${chatId} AND me.user_id = ${userId} AND me.left_at IS NULL
      RETURNING me.cleared_through_sequence AS cleared
    `);
    const row = result.rows[0];
    if (!row) throw new Error("clearHistory: no active membership");
    const cleared = Number(row.cleared);
    if (!keepStarred) {
      await tx.execute(sql`
        DELETE FROM starred_messages s USING messages m
        WHERE s.user_id = ${userId} AND s.message_id = m.id
          AND m.chat_id = ${chatId} AND m.sequence <= ${cleared}
      `);
    }
    return cleared;
  }

  // Keeps the row (and its sequence) as a tombstone; the body, reactions,
  // mentions, stars and attachment are discarded. Media cleanup deletes the
  // file once no other message (e.g. another broadcast recipient's) uses it.
  async markDeleted(tx: Tx, messageId: string, deletedBy: string): Promise<Message> {
    await tx.delete(starredMessages).where(eq(starredMessages.messageId, messageId));
    await tx.delete(messageReactions).where(eq(messageReactions.messageId, messageId));
    await tx.delete(messageMentions).where(eq(messageMentions.messageId, messageId));
    await tx.delete(messageAttachments).where(eq(messageAttachments.messageId, messageId));
    const [message] = await tx
      .update(messages)
      .set({ deletedAt: new Date(), deletedBy, ciphertext: Buffer.alloc(0) })
      .where(eq(messages.id, messageId))
      .returning();
    if (!message) throw new Error("message vanished while deleting");
    return message;
  }

  // Active members and where their visible history starts.
  async memberHistory(chatId: string): Promise<Map<string, number>> {
    const rows = await this.db
      .select({ userId: chatMembers.userId, historyFrom: chatMembers.historyFromSequence })
      .from(chatMembers)
      .where(and(eq(chatMembers.chatId, chatId), isNull(chatMembers.leftAt)));
    return new Map(rows.map((row) => [row.userId, row.historyFrom]));
  }
}
