import { and, eq, isNull, sql, type SQL } from "drizzle-orm";

import type { Database } from "../../db/client.js";
import { blockedUsers, chatMembers, users, type User } from "../../db/schema/index.js";
import type { MessageDto } from "../messages/messages.types.js";
import type { ChatSummary } from "./chats.types.js";

// The far-future timestamp stored for "muted until unmuted".
const MUTED_FOREVER = "9999-12-31T00:00:00Z";

// Raw queries bypass Drizzle's column mapping and the driver returns
// timestamps as Postgres text, so format them as ISO-8601 UTC in SQL.
function isoTimestamp(column: SQL): SQL {
  return sql`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
}

interface SummaryRow extends Record<string, unknown> {
  id: string;
  created_at: string;
  my_read: string;
  muted: boolean;
  peer_id: string;
  peer_name: string | null;
  peer_status: User["status"];
  peer_delivered: string;
  peer_read: string;
  receipts_visible: boolean;
  blocked_by_me: boolean;
  unread: string;
  last_sequence: string;
  m_id: string | null;
  m_sender_id: string | null;
  m_client_id: string | null;
  m_sequence: string | null;
  m_type: MessageDto["type"] | null;
  m_ciphertext: Buffer | null;
  m_created_at: string | null;
}

function toSummary(row: SummaryRow): ChatSummary {
  const lastMessage: MessageDto | null =
    row.m_id &&
    row.m_sender_id &&
    row.m_client_id &&
    row.m_type &&
    row.m_ciphertext &&
    row.m_created_at
      ? {
          id: row.m_id,
          chatId: row.id,
          senderId: row.m_sender_id,
          clientMessageId: row.m_client_id,
          sequence: Number(row.m_sequence),
          type: row.m_type,
          ciphertext: row.m_ciphertext.toString("base64"),
          createdAt: row.m_created_at,
        }
      : null;

  return {
    id: row.id,
    type: "direct",
    peer: {
      id: row.peer_id,
      displayName: row.peer_name,
      available: row.peer_status === "active",
      blockedByMe: row.blocked_by_me,
    },
    lastMessage,
    lastSequence: Number(row.last_sequence),
    unreadCount: Number(row.unread),
    muted: row.muted,
    lastReadSequence: Number(row.my_read),
    peerDeliveredSequence: Number(row.peer_delivered),
    peerReadSequence: row.receipts_visible ? Number(row.peer_read) : null,
    createdAt: row.created_at,
    lastActivityAt: row.m_created_at ?? row.created_at,
  };
}

export interface DirectChatMembership {
  chatId: string;
  peerId: string;
}

export interface ReceiptUpdate {
  deliveredSequence: number;
  readSequence: number;
  changed: boolean;
}

export class ChatsRepository {
  constructor(private readonly db: Database) {}

  // Direct chats only (groups arrive in a later batch). `includeEmpty`
  // returns chats with no messages yet; the list omits them so a recipient
  // never sees a conversation someone merely opened.
  private async summaries(
    userId: string,
    options: { chatId?: string; includeEmpty: boolean },
  ): Promise<ChatSummary[]> {
    const result = await this.db.execute<SummaryRow>(sql`
      SELECT
        c.id,
        ${isoTimestamp(sql`c.created_at`)} AS created_at,
        me.last_read_sequence AS my_read,
        (me.muted_until IS NOT NULL AND me.muted_until > NOW()) AS muted,
        peer.user_id AS peer_id,
        pu.display_name AS peer_name,
        pu.status AS peer_status,
        peer.last_delivered_sequence AS peer_delivered,
        peer.last_read_sequence AS peer_read,
        (COALESCE(pp.show_read_receipts, TRUE) AND COALESCE(mp.show_read_receipts, TRUE))
          AS receipts_visible,
        EXISTS (
          SELECT 1 FROM blocked_users b
          WHERE b.user_id = me.user_id AND b.blocked_user_id = peer.user_id
        ) AS blocked_by_me,
        (
          SELECT COUNT(*) FROM messages um
          WHERE um.chat_id = c.id
            AND um.sequence > me.last_read_sequence
            AND um.sender_id <> me.user_id
            AND um.deleted_at IS NULL
        ) AS unread,
        COALESCE(lm.sequence, 0) AS last_sequence,
        lm.id AS m_id,
        lm.sender_id AS m_sender_id,
        lm.client_message_id AS m_client_id,
        lm.sequence AS m_sequence,
        lm.type AS m_type,
        lm.ciphertext AS m_ciphertext,
        ${isoTimestamp(sql`lm.created_at`)} AS m_created_at
      FROM chat_members me
      JOIN chats c ON c.id = me.chat_id AND c.type = 'direct'
      JOIN chat_members peer ON peer.chat_id = c.id AND peer.user_id <> me.user_id
      JOIN users pu ON pu.id = peer.user_id
      LEFT JOIN privacy_settings pp ON pp.user_id = peer.user_id
      LEFT JOIN privacy_settings mp ON mp.user_id = me.user_id
      LEFT JOIN LATERAL (
        SELECT m.id, m.sender_id, m.client_message_id, m.sequence, m.type, m.ciphertext, m.created_at
        FROM messages m
        WHERE m.chat_id = c.id AND m.deleted_at IS NULL
        ORDER BY m.sequence DESC
        LIMIT 1
      ) lm ON TRUE
      WHERE me.user_id = ${userId}
        AND me.left_at IS NULL
        ${options.chatId ? sql`AND c.id = ${options.chatId}` : sql``}
        ${options.includeEmpty ? sql`` : sql`AND lm.id IS NOT NULL`}
      ORDER BY COALESCE(lm.created_at, c.created_at) DESC, c.id
    `);
    return result.rows.map(toSummary);
  }

  listForUser(userId: string): Promise<ChatSummary[]> {
    return this.summaries(userId, { includeEmpty: false });
  }

  async findSummary(userId: string, chatId: string): Promise<ChatSummary | undefined> {
    const [summary] = await this.summaries(userId, { chatId, includeEmpty: true });
    return summary;
  }

  async findActiveUser(userId: string): Promise<User | undefined> {
    const [user] = await this.db.select().from(users).where(eq(users.id, userId));
    return user?.status === "active" ? user : undefined;
  }

  // Block state between two users, in each direction.
  async blockState(userId: string, otherId: string): Promise<{ byMe: boolean; byThem: boolean }> {
    const rows = await this.db
      .select({ userId: blockedUsers.userId })
      .from(blockedUsers)
      .where(
        sql`(${blockedUsers.userId} = ${userId} AND ${blockedUsers.blockedUserId} = ${otherId})
          OR (${blockedUsers.userId} = ${otherId} AND ${blockedUsers.blockedUserId} = ${userId})`,
      );
    return {
      byMe: rows.some((row) => row.userId === userId),
      byThem: rows.some((row) => row.userId === otherId),
    };
  }

  async findDirectChatId(userId: string, otherId: string): Promise<string | undefined> {
    const result = await this.db.execute<{ id: string }>(sql`
      SELECT id FROM chats
      WHERE type = 'direct'
        AND LEAST(direct_user_a_id, direct_user_b_id) = LEAST(${userId}::uuid, ${otherId}::uuid)
        AND GREATEST(direct_user_a_id, direct_user_b_id) = GREATEST(${userId}::uuid, ${otherId}::uuid)
    `);
    return result.rows[0]?.id;
  }

  // Returns the canonical direct chat for the pair, creating it (and both
  // memberships) if needed. direct_chat_pair_unique makes concurrent calls
  // converge on one row.
  async findOrCreateDirectChat(userId: string, otherId: string): Promise<string> {
    return this.db.transaction(async (tx) => {
      const inserted = await tx.execute<{ id: string }>(sql`
        INSERT INTO chats (type, created_by, direct_user_a_id, direct_user_b_id)
        VALUES ('direct', ${userId}, LEAST(${userId}::uuid, ${otherId}::uuid),
                GREATEST(${userId}::uuid, ${otherId}::uuid))
        ON CONFLICT (LEAST(direct_user_a_id, direct_user_b_id),
                     GREATEST(direct_user_a_id, direct_user_b_id))
          WHERE type = 'direct'
        DO NOTHING
        RETURNING id
      `);

      let chatId = inserted.rows[0]?.id;
      if (!chatId) {
        const existing = await tx.execute<{ id: string }>(sql`
          SELECT id FROM chats
          WHERE type = 'direct'
            AND LEAST(direct_user_a_id, direct_user_b_id) = LEAST(${userId}::uuid, ${otherId}::uuid)
            AND GREATEST(direct_user_a_id, direct_user_b_id) = GREATEST(${userId}::uuid, ${otherId}::uuid)
        `);
        chatId = existing.rows[0]?.id;
      }
      if (!chatId) throw new Error("direct chat vanished after conflict");

      await tx
        .insert(chatMembers)
        .values([
          { chatId, userId },
          { chatId, userId: otherId },
        ])
        .onConflictDoNothing();

      return chatId;
    });
  }

  // The caller's active direct-chat membership and the other participant.
  async findDirectMembership(
    userId: string,
    chatId: string,
  ): Promise<DirectChatMembership | undefined> {
    const result = await this.db.execute<{ peer_id: string }>(sql`
      SELECT peer.user_id AS peer_id
      FROM chat_members me
      JOIN chats c ON c.id = me.chat_id AND c.type = 'direct'
      JOIN chat_members peer ON peer.chat_id = c.id AND peer.user_id <> me.user_id
      WHERE me.chat_id = ${chatId} AND me.user_id = ${userId} AND me.left_at IS NULL
    `);
    const row = result.rows[0];
    return row ? { chatId, peerId: row.peer_id } : undefined;
  }

  async setMuted(userId: string, chatId: string, muted: boolean): Promise<boolean> {
    const updated = await this.db
      .update(chatMembers)
      .set({ mutedUntil: muted ? new Date(MUTED_FOREVER) : null })
      .where(
        and(
          eq(chatMembers.chatId, chatId),
          eq(chatMembers.userId, userId),
          isNull(chatMembers.leftAt),
        ),
      )
      .returning({ chatId: chatMembers.chatId });
    return updated.length > 0;
  }

  // Advances the caller's delivered/read pointers. Pointers never move
  // backwards, never pass the chat's last sequence, and read never passes
  // delivered (chat_members_sequence_check).
  async advanceReceipts(
    userId: string,
    chatId: string,
    delivered: number,
    read: number,
  ): Promise<ReceiptUpdate | undefined> {
    const result = await this.db.execute<{
      last_delivered_sequence: string;
      last_read_sequence: string;
      prev_delivered: string;
      prev_read: string;
    }>(sql`
      WITH bounds AS (
        SELECT COALESCE(MAX(sequence), 0) AS max_seq FROM messages WHERE chat_id = ${chatId}
      ),
      prev AS (
        SELECT last_delivered_sequence, last_read_sequence
        FROM chat_members
        WHERE chat_id = ${chatId} AND user_id = ${userId} AND left_at IS NULL
        FOR UPDATE
      )
      UPDATE chat_members cm SET
        last_delivered_sequence = GREATEST(
          cm.last_delivered_sequence,
          LEAST(${delivered}::bigint, bounds.max_seq),
          LEAST(${read}::bigint, bounds.max_seq)
        ),
        last_read_sequence = GREATEST(cm.last_read_sequence, LEAST(${read}::bigint, bounds.max_seq))
      FROM bounds, prev
      WHERE cm.chat_id = ${chatId} AND cm.user_id = ${userId} AND cm.left_at IS NULL
      RETURNING cm.last_delivered_sequence, cm.last_read_sequence,
                prev.last_delivered_sequence AS prev_delivered,
                prev.last_read_sequence AS prev_read
    `);
    const row = result.rows[0];
    if (!row) return undefined;
    const deliveredSequence = Number(row.last_delivered_sequence);
    const readSequence = Number(row.last_read_sequence);
    return {
      deliveredSequence,
      readSequence,
      changed:
        deliveredSequence !== Number(row.prev_delivered) || readSequence !== Number(row.prev_read),
    };
  }

  // Whether read receipts are visible between two users (both must allow).
  async readReceiptsVisible(userId: string, otherId: string): Promise<boolean> {
    const result = await this.db.execute<{ visible: boolean }>(sql`
      SELECT COALESCE(BOOL_AND(show_read_receipts), TRUE) AS visible
      FROM privacy_settings
      WHERE user_id IN (${userId}, ${otherId})
    `);
    return result.rows[0]?.visible ?? true;
  }
}
