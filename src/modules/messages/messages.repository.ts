import { and, asc, desc, eq, gt, isNull, lt, sql } from "drizzle-orm";

import type { Database } from "../../db/client.js";
import { chatMembers, messages, type Message } from "../../db/schema/index.js";

export interface NewOutgoingMessage {
  chatId: string;
  senderId: string;
  senderDeviceId: string;
  clientMessageId: string;
  type: Message["type"];
  ciphertext: Buffer;
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

export class MessagesRepository {
  constructor(private readonly db: Database) {}

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

  // Persists a message with the next per-chat sequence. Locking the chat row
  // serialises senders in a chat, so sequences are gap-free and a retried
  // client message ID always finds the row stored by the first attempt.
  async send(input: NewOutgoingMessage): Promise<SendResult> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM chats WHERE id = ${input.chatId} FOR UPDATE`);

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

      const next = await tx.execute<{ next: string }>(sql`
        SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM messages WHERE chat_id = ${input.chatId}
      `);
      const sequence = Number(next.rows[0]?.next ?? 1);

      const [message] = await tx
        .insert(messages)
        .values({ ...input, sequence })
        .returning();
      if (!message) throw new Error("message insert returned no row");

      // The sender has trivially received and read their own message.
      await tx
        .update(chatMembers)
        .set({ lastDeliveredSequence: sequence, lastReadSequence: sequence })
        .where(and(eq(chatMembers.chatId, input.chatId), eq(chatMembers.userId, input.senderId)));

      return { message, created: true };
    });
  }

  // Ascending by sequence. `after` syncs forward from a known sequence;
  // `before` pages backwards; neither returns the latest page.
  async list(
    chatId: string,
    options: { after?: number | undefined; before?: number | undefined; limit: number },
  ): Promise<MessagePage> {
    const base = [eq(messages.chatId, chatId), isNull(messages.deletedAt)];

    if (options.after !== undefined) {
      const rows = await this.db
        .select()
        .from(messages)
        .where(and(...base, gt(messages.sequence, options.after)))
        .orderBy(asc(messages.sequence))
        .limit(options.limit + 1);
      return { messages: rows.slice(0, options.limit), hasMore: rows.length > options.limit };
    }

    const rows = await this.db
      .select()
      .from(messages)
      .where(
        and(
          ...base,
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
}
