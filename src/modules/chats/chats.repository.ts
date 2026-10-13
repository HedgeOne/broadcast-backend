import { and, eq, isNull, sql, type SQL } from "drizzle-orm";

import type { Database } from "../../db/client.js";
import { blockedUsers, chatMembers, users, type User } from "../../db/schema/index.js";
import type { GroupRole } from "../groups/groups.policy.js";
import type { SystemEvent } from "../groups/groups.types.js";
import type { MessageDto } from "../messages/messages.types.js";
import { photoIdFor } from "../photos/photos.access.js";
import { activeMemberIds, findOrCreateDirectChat, type Executor } from "./chat-tx.js";
import type { MuteDuration } from "./chats.schemas.js";
import type { ChatSummary } from "./chats.types.js";

// The far-future timestamp stored for "muted until unmuted".
const MUTED_FOREVER = "9999-12-31T00:00:00Z";

const MUTE_UNTIL: Record<MuteDuration, SQL> = {
  "8h": sql`NOW() + interval '8 hours'`,
  "1w": sql`NOW() + interval '7 days'`,
  always: sql`${MUTED_FOREVER}::timestamptz`,
};

// Raw queries bypass Drizzle's column mapping and the driver returns
// timestamps as Postgres text, so format them as ISO-8601 UTC in SQL.
function isoTimestamp(column: SQL): SQL {
  return sql`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
}

interface SummaryRow extends Record<string, unknown> {
  id: string;
  type: "direct" | "group";
  created_at: string;
  my_read: string;
  cleared_through: string;
  cleared_at: string | null;
  my_role: GroupRole;
  muted: boolean;
  muted_until: string | null;
  peer_id: string | null;
  peer_name: string | null;
  peer_status: User["status"] | null;
  peer_photo_id: string | null;
  peer_delivered: string | null;
  peer_read: string | null;
  receipts_visible: boolean;
  blocked_by_me: boolean;
  g_name: string | null;
  g_description: string | null;
  g_photo_id: string | null;
  g_edit_info: boolean | null;
  g_message: boolean | null;
  g_add_members: boolean | null;
  g_approval: boolean | null;
  g_links: boolean | null;
  g_history: boolean | null;
  g_member_count: string | null;
  g_min_delivered: string | null;
  g_min_read: string | null;
  unread: string;
  last_sequence: string;
  m_id: string | null;
  m_sender_id: string | null;
  m_client_id: string | null;
  m_sequence: string | null;
  m_type: MessageDto["type"] | null;
  m_ciphertext: Buffer | null;
  m_system: SystemEvent | null;
  m_deleted: boolean | null;
  m_deleted_by: string | null;
  m_mentions: string[] | null;
  m_created_at: string | null;
  m_sender_name: string | null;
}

function lastMessageOf(row: SummaryRow): MessageDto | null {
  if (!row.m_id || !row.m_sender_id || !row.m_client_id || !row.m_type || !row.m_created_at) {
    return null;
  }
  const deleted = row.m_deleted === true;
  return {
    id: row.m_id,
    chatId: row.id,
    senderId: row.m_sender_id,
    clientMessageId: row.m_client_id,
    sequence: Number(row.m_sequence),
    type: row.m_type,
    ciphertext: deleted || !row.m_ciphertext ? "" : row.m_ciphertext.toString("base64"),
    createdAt: row.m_created_at,
    // Previews don't render quotes, reactions or files; the type names the
    // kind of media ("Photo", "Video", …).
    replyTo: null,
    mentions: deleted ? [] : (row.m_mentions ?? []),
    reactions: [],
    attachment: null,
    system: row.m_system,
    deleted,
    deletedBy: row.m_deleted_by,
  };
}

function toSummary(row: SummaryRow): ChatSummary {
  const lastSequence = Number(row.last_sequence);
  const base = {
    id: row.id,
    lastMessage: lastMessageOf(row),
    lastSenderName: row.m_sender_name,
    lastSequence,
    unreadCount: Number(row.unread),
    muted: row.muted,
    mutedUntil: row.muted_until,
    lastReadSequence: Number(row.my_read),
    clearedThroughSequence: Number(row.cleared_through),
    createdAt: row.created_at,
    lastActivityAt: row.m_created_at ?? row.cleared_at ?? row.created_at,
  };

  if (row.type === "group") {
    return {
      ...base,
      type: "group",
      group: {
        name: row.g_name ?? "",
        description: row.g_description,
        photoId: row.g_photo_id,
        memberCount: Number(row.g_member_count ?? 1),
        myRole: row.my_role,
        settings: {
          onlyAdminsCanEditInfo: row.g_edit_info ?? false,
          onlyAdminsCanMessage: row.g_message ?? false,
          onlyAdminsCanAddMembers: row.g_add_members ?? true,
          approvalRequired: row.g_approval ?? false,
          inviteLinksEnabled: row.g_links ?? false,
          historyVisibleToNewMembers: row.g_history ?? false,
        },
      },
      // Alone in the group: nobody else to deliver to.
      peerDeliveredSequence:
        row.g_min_delivered === null ? lastSequence : Number(row.g_min_delivered),
      peerReadSequence: row.g_min_read === null ? lastSequence : Number(row.g_min_read),
    };
  }

  return {
    ...base,
    type: "direct",
    peer: {
      id: row.peer_id ?? "",
      displayName: row.peer_name,
      available: row.peer_status === "active",
      blockedByMe: row.blocked_by_me,
      photoId: row.peer_photo_id,
    },
    peerDeliveredSequence: Number(row.peer_delivered ?? 0),
    peerReadSequence: row.receipts_visible ? Number(row.peer_read ?? 0) : null,
  };
}

// The caller's active membership in any chat.
export interface ChatMembership {
  chatId: string;
  type: "direct" | "group";
  role: GroupRole;
  // Group messages at or below this sequence predate the caller.
  historyFrom: number;
  // Direct chats only.
  peerId: string | null;
}

export interface ReceiptUpdate {
  deliveredSequence: number;
  readSequence: number;
  changed: boolean;
}

export class ChatsRepository {
  constructor(private readonly db: Database) {}

  // Direct chats and live groups the caller is an active member of.
  // `includeEmpty` returns direct chats with no messages yet; the list
  // omits them so a recipient never sees a conversation someone merely
  // opened. Groups always have at least their "created" event.
  private async summaries(
    userId: string,
    options: { chatId?: string; includeEmpty: boolean },
  ): Promise<ChatSummary[]> {
    const result = await this.db.execute<SummaryRow>(sql`
      SELECT
        c.id,
        c.type,
        ${isoTimestamp(sql`c.created_at`)} AS created_at,
        me.last_read_sequence AS my_read,
        me.cleared_through_sequence AS cleared_through,
        CASE WHEN me.cleared_at IS NULL THEN NULL
             ELSE ${isoTimestamp(sql`me.cleared_at`)} END AS cleared_at,
        me.role AS my_role,
        (me.muted_until IS NOT NULL AND me.muted_until > NOW()) AS muted,
        CASE WHEN me.muted_until > NOW() AND me.muted_until < ${MUTED_FOREVER}::timestamptz
          THEN ${isoTimestamp(sql`me.muted_until`)} END AS muted_until,
        peer.user_id AS peer_id,
        pu.display_name AS peer_name,
        pu.status AS peer_status,
        ${photoIdFor(sql`pu`, userId)} AS peer_photo_id,
        peer.last_delivered_sequence AS peer_delivered,
        peer.last_read_sequence AS peer_read,
        (COALESCE(pp.show_read_receipts, TRUE) AND COALESCE(mp.show_read_receipts, TRUE))
          AS receipts_visible,
        (peer.user_id IS NOT NULL AND EXISTS (
          SELECT 1 FROM blocked_users b
          WHERE b.user_id = me.user_id AND b.blocked_user_id = peer.user_id
        )) AS blocked_by_me,
        g.name AS g_name,
        g.description AS g_description,
        g.photo_upload_id AS g_photo_id,
        g.only_admins_can_edit_info AS g_edit_info,
        g.only_admins_can_message AS g_message,
        g.only_admins_can_add_members AS g_add_members,
        g.approval_required AS g_approval,
        g.invite_links_enabled AS g_links,
        g.history_visible_to_new_members AS g_history,
        gm.member_count AS g_member_count,
        gm.min_delivered AS g_min_delivered,
        gm.min_read AS g_min_read,
        (
          SELECT COUNT(*) FROM messages um
          WHERE um.chat_id = c.id
            AND um.sequence > GREATEST(me.last_read_sequence, me.history_from_sequence)
            AND um.sender_id <> me.user_id
            AND um.type <> 'system'
            AND um.deleted_at IS NULL
        ) AS unread,
        COALESCE(lm.sequence, 0) AS last_sequence,
        lm.id AS m_id,
        lm.sender_id AS m_sender_id,
        lm.client_message_id AS m_client_id,
        lm.sequence AS m_sequence,
        lm.type AS m_type,
        lm.ciphertext AS m_ciphertext,
        lm.system_event AS m_system,
        (lm.deleted_at IS NOT NULL) AS m_deleted,
        lm.deleted_by AS m_deleted_by,
        (
          SELECT array_agg(mm.user_id::text) FROM message_mentions mm WHERE mm.message_id = lm.id
        ) AS m_mentions,
        ${isoTimestamp(sql`lm.created_at`)} AS m_created_at,
        lsu.display_name AS m_sender_name
      FROM chat_members me
      JOIN chats c ON c.id = me.chat_id
      LEFT JOIN groups g ON g.chat_id = c.id
      LEFT JOIN LATERAL (
        SELECT COUNT(*) AS member_count,
               MIN(o.last_delivered_sequence) FILTER (WHERE o.user_id <> me.user_id) AS min_delivered,
               MIN(o.last_read_sequence) FILTER (WHERE o.user_id <> me.user_id) AS min_read
        FROM chat_members o
        WHERE o.chat_id = c.id AND o.left_at IS NULL AND c.type = 'group'
      ) gm ON TRUE
      LEFT JOIN chat_members peer
        ON c.type = 'direct' AND peer.chat_id = c.id AND peer.user_id <> me.user_id
      LEFT JOIN users pu ON pu.id = peer.user_id
      LEFT JOIN privacy_settings pp ON pp.user_id = peer.user_id
      LEFT JOIN privacy_settings mp ON mp.user_id = me.user_id
      LEFT JOIN LATERAL (
        SELECT m.id, m.sender_id, m.client_message_id, m.sequence, m.type, m.ciphertext,
               m.system_event, m.deleted_at, m.deleted_by, m.created_at
        FROM messages m
        WHERE m.chat_id = c.id AND m.sequence > me.history_from_sequence
        ORDER BY m.sequence DESC
        LIMIT 1
      ) lm ON TRUE
      LEFT JOIN users lsu ON lsu.id = lm.sender_id
      WHERE me.user_id = ${userId}
        AND me.left_at IS NULL
        AND (
          (c.type = 'direct' AND peer.user_id IS NOT NULL)
          OR (c.type = 'group' AND g.chat_id IS NOT NULL AND g.deleted_at IS NULL)
        )
        ${options.chatId ? sql`AND c.id = ${options.chatId}` : sql``}
        ${
          options.includeEmpty
            ? sql``
            : sql`AND (lm.id IS NOT NULL OR c.type = 'group' OR me.cleared_at IS NOT NULL)`
        }
      ORDER BY COALESCE(lm.created_at, me.cleared_at, c.created_at) DESC, c.id
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
    return this.db.transaction((tx) => findOrCreateDirectChat(tx, userId, otherId));
  }

  // The caller's active membership; undefined for non-members and deleted
  // groups. Pass a transaction to re-check under the chat lock.
  async findMembership(
    userId: string,
    chatId: string,
    executor: Executor = this.db,
  ): Promise<ChatMembership | undefined> {
    const result = await executor.execute<{
      type: "direct" | "group";
      role: GroupRole;
      history_from: string;
      peer_id: string | null;
    }>(sql`
      SELECT c.type, me.role, me.history_from_sequence AS history_from,
        (SELECT p.user_id FROM chat_members p
         WHERE c.type = 'direct' AND p.chat_id = c.id AND p.user_id <> me.user_id) AS peer_id
      FROM chat_members me
      JOIN chats c ON c.id = me.chat_id
      LEFT JOIN groups g ON g.chat_id = c.id
      WHERE me.chat_id = ${chatId} AND me.user_id = ${userId} AND me.left_at IS NULL
        AND (c.type = 'direct' OR (g.chat_id IS NOT NULL AND g.deleted_at IS NULL))
    `);
    const row = result.rows[0];
    if (!row || (row.type === "direct" && !row.peer_id)) return undefined;
    return {
      chatId,
      type: row.type,
      role: row.role,
      historyFrom: Number(row.history_from),
      peerId: row.peer_id,
    };
  }

  // How far every active member of a group has received and read.
  async groupReceipts(chatId: string): Promise<{ delivered: number; read: number }> {
    const result = await this.db.execute<{ delivered: string | null; read: string | null }>(sql`
      SELECT MIN(last_delivered_sequence) AS delivered, MIN(last_read_sequence) AS read
      FROM chat_members WHERE chat_id = ${chatId} AND left_at IS NULL
    `);
    const row = result.rows[0];
    return { delivered: Number(row?.delivered ?? 0), read: Number(row?.read ?? 0) };
  }

  activeMemberIds(chatId: string): Promise<string[]> {
    return activeMemberIds(this.db, chatId);
  }

  // Expiry comes from the database clock, never the client's.
  async setMute(userId: string, chatId: string, duration: MuteDuration | null): Promise<boolean> {
    const updated = await this.db
      .update(chatMembers)
      .set({ mutedUntil: duration === null ? null : MUTE_UNTIL[duration] })
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
