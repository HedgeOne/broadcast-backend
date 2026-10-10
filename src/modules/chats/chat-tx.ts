import { sql } from "drizzle-orm";

import type { Database } from "../../db/client.js";
import { messages, type Message } from "../../db/schema/index.js";
import type { SystemEvent, SystemEventInput } from "../groups/groups.types.js";

export type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
export type Executor = Database | Tx;

// Locks the chat row. Every write that allocates a sequence or changes
// membership takes this lock first, so senders, membership changes and
// role changes in one chat are serialised.
export async function lockChat(
  tx: Tx,
  chatId: string,
): Promise<{ type: "direct" | "group" } | undefined> {
  const result = await tx.execute<{ type: "direct" | "group" }>(
    sql`SELECT type FROM chats WHERE id = ${chatId} FOR UPDATE`,
  );
  return result.rows[0];
}

// Next per-chat sequence. Only valid while holding the chat lock.
export async function nextSequence(tx: Tx, chatId: string): Promise<number> {
  const result = await tx.execute<{ next: string }>(sql`
    SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM messages WHERE chat_id = ${chatId}
  `);
  return Number(result.rows[0]?.next ?? 1);
}

export async function currentSequence(executor: Executor, chatId: string): Promise<number> {
  const result = await executor.execute<{ max: string }>(sql`
    SELECT COALESCE(MAX(sequence), 0) AS max FROM messages WHERE chat_id = ${chatId}
  `);
  return Number(result.rows[0]?.max ?? 0);
}

function referencedUsers(event: SystemEventInput): string[] {
  const ids = new Set<string>([event.actorId]);
  if ("userId" in event) ids.add(event.userId);
  if ("userIds" in event) for (const id of event.userIds) ids.add(id);
  if ("approvedBy" in event && event.approvedBy) ids.add(event.approvedBy);
  return [...ids];
}

// Appends a server-generated system message. Holding the chat lock is
// required. The body is empty: the event lives in system_event.
export async function insertSystemMessage(
  tx: Tx,
  chatId: string,
  input: SystemEventInput,
): Promise<Message> {
  const ids = referencedUsers(input);
  const named = await tx.execute<{ id: string; display_name: string | null }>(sql`
    SELECT id, display_name FROM users WHERE id = ANY(${sql.param(ids)}::uuid[])
  `);
  const names: Record<string, string | null> = {};
  for (const row of named.rows) names[row.id] = row.display_name;

  const event: SystemEvent = { ...input, names };
  const sequence = await nextSequence(tx, chatId);
  const [message] = await tx
    .insert(messages)
    .values({
      chatId,
      senderId: input.actorId,
      senderDeviceId: null,
      clientMessageId: sql`gen_random_uuid()`,
      sequence,
      type: "system",
      ciphertext: Buffer.alloc(0),
      systemEvent: event,
    })
    .returning();
  if (!message) throw new Error("system message insert returned no row");

  // The actor has trivially seen their own event.
  await tx.execute(sql`
    UPDATE chat_members
    SET last_delivered_sequence = GREATEST(last_delivered_sequence, ${sequence}),
        last_read_sequence = GREATEST(last_read_sequence, ${sequence})
    WHERE chat_id = ${chatId} AND user_id = ${input.actorId} AND left_at IS NULL
  `);
  return message;
}

export async function activeMemberIds(executor: Executor, chatId: string): Promise<string[]> {
  const result = await executor.execute<{ user_id: string }>(sql`
    SELECT user_id FROM chat_members WHERE chat_id = ${chatId} AND left_at IS NULL
  `);
  return result.rows.map((row) => row.user_id);
}
