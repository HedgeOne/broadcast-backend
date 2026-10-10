import { and, asc, desc, eq, gt, inArray, isNull, lt, sql } from "drizzle-orm";

import type { Database } from "../../db/client.js";
import {
  chatMembers,
  messageMentions,
  messageReactions,
  messages,
  type Message,
} from "../../db/schema/index.js";
import { lockChat, nextSequence, type Tx } from "../chats/chat-tx.js";
import type { ReactionDto, ReplyPreviewDto } from "./messages.types.js";

export interface NewOutgoingMessage {
  chatId: string;
  senderId: string;
  senderDeviceId: string;
  clientMessageId: string;
  type: Message["type"];
  ciphertext: Buffer;
  replyToMessageId: string | null;
  mentions: string[];
}

export interface SendResult {
  message: Message;
  // False when this client message ID was already stored (a retry).
  created: boolean;
}

export interface MessagePage {
  messages: Message[];
  hasMore: boolean;
}

export interface Hydration {
  mentions: Map<string, string[]>;
  reactions: Map<string, ReactionDto[]>;
  replies: Map<string, Message>;
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
  return {
    id: target.id,
    available: true,
    senderId: target.senderId,
    type: target.type,
    ciphertext: target.ciphertext.toString("base64"),
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

      const sequence = await nextSequence(tx, input.chatId);
      const { mentions, ...row } = input;
      const [message] = await tx
        .insert(messages)
        .values({ ...row, sequence })
        .returning();
      if (!message) throw new Error("message insert returned no row");

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
    const hydration: Hydration = { mentions: new Map(), reactions: new Map(), replies: new Map() };
    const ids = list.map((message) => message.id);
    if (ids.length === 0) return hydration;
    const replyIds = [
      ...new Set(list.map((message) => message.replyToMessageId).filter((id) => id !== null)),
    ];

    const [mentionRows, reactionRows, replyRows] = await Promise.all([
      this.db.select().from(messageMentions).where(inArray(messageMentions.messageId, ids)),
      this.db
        .select()
        .from(messageReactions)
        .where(inArray(messageReactions.messageId, ids))
        .orderBy(asc(messageReactions.createdAt), asc(messageReactions.userId)),
      replyIds.length > 0
        ? this.db.select().from(messages).where(inArray(messages.id, replyIds))
        : Promise.resolve([]),
    ]);

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

  // Keeps the row (and its sequence) as a tombstone; the body, reactions
  // and mentions are discarded.
  async markDeleted(tx: Tx, messageId: string, deletedBy: string): Promise<Message> {
    await tx.delete(messageReactions).where(eq(messageReactions.messageId, messageId));
    await tx.delete(messageMentions).where(eq(messageMentions.messageId, messageId));
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
