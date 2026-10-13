import { and, eq, isNull, sql, type SQL } from "drizzle-orm";

import type { Database } from "../../db/client.js";
import { chatMembers, chats, groupInvites, groups, type Group } from "../../db/schema/index.js";
import {
  activeMemberIds,
  currentSequence,
  lockChat,
  type Executor,
  type Tx,
} from "../chats/chat-tx.js";
import { photoIdFor } from "../photos/photos.access.js";
import { groupErrors } from "./groups.errors.js";
import type { GroupRole, GroupSettings } from "./groups.policy.js";
import type { GroupMemberDto, InviteLinkDto, JoinRequestDto } from "./groups.types.js";

function isoTimestamp(column: SQL): SQL {
  return sql`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
}

export function settingsOf(group: Group): GroupSettings {
  return {
    onlyAdminsCanEditInfo: group.onlyAdminsCanEditInfo,
    onlyAdminsCanMessage: group.onlyAdminsCanMessage,
    onlyAdminsCanAddMembers: group.onlyAdminsCanAddMembers,
    approvalRequired: group.approvalRequired,
    inviteLinksEnabled: group.inviteLinksEnabled,
    historyVisibleToNewMembers: group.historyVisibleToNewMembers,
  };
}

// The group and the caller's membership, read under the chat lock.
export interface LockedGroup {
  group: Group;
  settings: GroupSettings;
  actor: { userId: string; role: GroupRole };
}

export interface ParticipantCheck {
  // Inactive, blocked the actor, or not accepting group adds.
  unavailable: string[];
  // The actor blocked them; they can unblock to add.
  blockedByActor: string[];
}

export interface NewGroupInput {
  creatorId: string;
  clientRequestId: string;
  name: string;
  description: string | null;
  memberIds: string[];
}

export interface ActiveInvite {
  id: string;
  chatId: string;
  expiresAt: Date | null;
  maxUses: number | null;
  useCount: number;
  group: Group;
}

export class GroupsRepository {
  constructor(private readonly db: Database) {}

  get executor(): Executor {
    return this.db;
  }

  transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.db.transaction(fn);
  }

  memberIds(chatId: string, executor: Executor = this.db): Promise<string[]> {
    return activeMemberIds(executor, chatId);
  }

  // Runs `fn` holding the chat lock with the caller's active membership.
  // A deleted group, a non-group chat and a non-member all look the same.
  async withGroup<T>(
    chatId: string,
    actorId: string,
    fn: (tx: Tx, state: LockedGroup) => Promise<T>,
  ): Promise<T> {
    return this.db.transaction(async (tx) => {
      const locked = await lockChat(tx, chatId);
      if (locked?.type !== "group") throw groupErrors.groupNotFound();
      const group = await this.findGroup(tx, chatId);
      if (!group) throw groupErrors.groupNotFound();
      const role = await this.memberRole(tx, chatId, actorId);
      if (!role) throw groupErrors.groupNotFound();
      return fn(tx, { group, settings: settingsOf(group), actor: { userId: actorId, role } });
    });
  }

  // Lock without requiring membership (joining through a link).
  async withGroupLock<T>(chatId: string, fn: (tx: Tx, group: Group) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => {
      const locked = await lockChat(tx, chatId);
      if (locked?.type !== "group") throw groupErrors.groupNotFound();
      const group = await this.findGroup(tx, chatId);
      if (!group) throw groupErrors.groupNotFound();
      return fn(tx, group);
    });
  }

  async findGroup(executor: Executor, chatId: string): Promise<Group | undefined> {
    const [group] = await executor
      .select()
      .from(groups)
      .where(and(eq(groups.chatId, chatId), isNull(groups.deletedAt)));
    return group;
  }

  async memberRole(
    executor: Executor,
    chatId: string,
    userId: string,
  ): Promise<GroupRole | undefined> {
    const [row] = await executor
      .select({ role: chatMembers.role })
      .from(chatMembers)
      .where(
        and(
          eq(chatMembers.chatId, chatId),
          eq(chatMembers.userId, userId),
          isNull(chatMembers.leftAt),
        ),
      );
    return row?.role;
  }

  async activeRoles(
    executor: Executor,
    chatId: string,
    userIds: string[],
  ): Promise<Map<string, GroupRole>> {
    if (userIds.length === 0) return new Map();
    const result = await executor.execute<{ user_id: string; role: GroupRole }>(sql`
      SELECT user_id, role FROM chat_members
      WHERE chat_id = ${chatId} AND left_at IS NULL AND user_id = ANY(${sql.param(userIds)}::uuid[])
    `);
    return new Map(result.rows.map((row) => [row.user_id, row.role]));
  }

  async activeMemberCount(executor: Executor, chatId: string): Promise<number> {
    const result = await executor.execute<{ count: string }>(sql`
      SELECT COUNT(*) AS count FROM chat_members WHERE chat_id = ${chatId} AND left_at IS NULL
    `);
    return Number(result.rows[0]?.count ?? 0);
  }

  // Whether an admin removed this user (as opposed to them leaving).
  async wasRemoved(executor: Executor, chatId: string, userId: string): Promise<boolean> {
    const result = await executor.execute(sql`
      SELECT 1 FROM chat_members
      WHERE chat_id = ${chatId} AND user_id = ${userId}
        AND left_at IS NOT NULL AND removed_by IS NOT NULL
    `);
    return result.rows.length > 0;
  }

  async checkParticipants(actorId: string, userIds: string[]): Promise<ParticipantCheck> {
    if (userIds.length === 0) return { unavailable: [], blockedByActor: [] };
    const result = await this.db.execute<{
      id: string;
      active: boolean;
      blocked_actor: boolean;
      blocked_by_actor: boolean;
      accepts_adds: boolean;
    }>(sql`
      SELECT u.id,
        u.status = 'active' AS active,
        EXISTS (SELECT 1 FROM blocked_users b WHERE b.user_id = u.id AND b.blocked_user_id = ${actorId})
          AS blocked_actor,
        EXISTS (SELECT 1 FROM blocked_users b WHERE b.user_id = ${actorId} AND b.blocked_user_id = u.id)
          AS blocked_by_actor,
        COALESCE(p.allow_group_invites, TRUE) AS accepts_adds
      FROM users u
      LEFT JOIN privacy_settings p ON p.user_id = u.id
      WHERE u.id = ANY(${sql.param(userIds)}::uuid[])
    `);
    const found = new Map(result.rows.map((row) => [row.id, row]));
    const unavailable: string[] = [];
    const blockedByActor: string[] = [];
    for (const id of userIds) {
      const row = found.get(id);
      if (!row || !row.active || row.blocked_actor || !row.accepts_adds) unavailable.push(id);
      else if (row.blocked_by_actor) blockedByActor.push(id);
    }
    return { unavailable, blockedByActor };
  }

  async findCreatedByRequest(
    creatorId: string,
    clientRequestId: string,
  ): Promise<string | undefined> {
    const [row] = await this.db
      .select({ id: chats.id, type: chats.type })
      .from(chats)
      .where(and(eq(chats.createdBy, creatorId), eq(chats.clientRequestId, clientRequestId)));
    if (!row) return undefined;
    if (row.type !== "group") throw groupErrors.clientRequestConflict();
    return row.id;
  }

  // Inserts the chat, the group and every membership. Returns undefined
  // when a concurrent request with the same key already created it.
  async insertGroup(tx: Tx, input: NewGroupInput): Promise<string | undefined> {
    const inserted = await tx.execute<{ id: string }>(sql`
      INSERT INTO chats (type, created_by, client_request_id)
      VALUES ('group', ${input.creatorId}, ${input.clientRequestId})
      ON CONFLICT (created_by, client_request_id) WHERE client_request_id IS NOT NULL
      DO NOTHING
      RETURNING id
    `);
    const chatId = inserted.rows[0]?.id;
    if (!chatId) return undefined;

    await tx.insert(groups).values({
      chatId,
      name: input.name,
      description: input.description,
    });
    await tx
      .insert(chatMembers)
      .values([
        { chatId, userId: input.creatorId, role: "owner" },
        ...input.memberIds.map((userId) => ({ chatId, userId, role: "member" as const })),
      ]);
    return chatId;
  }

  // Adds or reactivates members. Earlier history is hidden unless the group
  // shares it; either way nothing before joining counts as unread.
  async activateMembers(
    tx: Tx,
    chatId: string,
    userIds: string[],
    shareHistory: boolean,
  ): Promise<void> {
    if (userIds.length === 0) return;
    const latest = await currentSequence(tx, chatId);
    const historyFrom = shareHistory ? 0 : latest;
    for (const userId of userIds) {
      await tx.execute(sql`
        INSERT INTO chat_members (chat_id, user_id, role, history_from_sequence,
                                  last_delivered_sequence, last_read_sequence)
        VALUES (${chatId}, ${userId}, 'member', ${historyFrom}, ${latest}, ${latest})
        ON CONFLICT (chat_id, user_id) DO UPDATE SET
          role = 'member',
          joined_at = NOW(),
          left_at = NULL,
          removed_by = NULL,
          muted_until = NULL,
          history_from_sequence = GREATEST(EXCLUDED.history_from_sequence, chat_members.cleared_through_sequence),
          last_delivered_sequence = GREATEST(chat_members.last_delivered_sequence, EXCLUDED.last_delivered_sequence),
          last_read_sequence = GREATEST(chat_members.last_read_sequence, EXCLUDED.last_read_sequence)
        WHERE chat_members.left_at IS NOT NULL
      `);
    }
  }

  // Ends a membership. The role resets so the one-owner index is freed.
  async endMembership(
    tx: Tx,
    chatId: string,
    userId: string,
    removedBy: string | null,
  ): Promise<void> {
    await tx.execute(sql`
      UPDATE chat_members
      SET left_at = NOW(), removed_by = ${removedBy}, role = 'member'
      WHERE chat_id = ${chatId} AND user_id = ${userId} AND left_at IS NULL
    `);
  }

  async setRole(tx: Tx, chatId: string, userId: string, role: GroupRole): Promise<void> {
    await tx.execute(sql`
      UPDATE chat_members SET role = ${role}
      WHERE chat_id = ${chatId} AND user_id = ${userId} AND left_at IS NULL
    `);
  }

  // Who inherits ownership: the longest-standing admin, else the
  // longest-standing member.
  async successor(tx: Tx, chatId: string, excludingUserId: string): Promise<string | undefined> {
    const result = await tx.execute<{ user_id: string }>(sql`
      SELECT user_id FROM chat_members
      WHERE chat_id = ${chatId} AND left_at IS NULL AND user_id <> ${excludingUserId}
      ORDER BY (role = 'admin') DESC, joined_at ASC, user_id ASC
      LIMIT 1
    `);
    return result.rows[0]?.user_id;
  }

  async updateInfo(
    tx: Tx,
    chatId: string,
    update: { name?: string | undefined; description?: string | null | undefined },
  ): Promise<void> {
    await tx
      .update(groups)
      .set({
        ...(update.name !== undefined && { name: update.name }),
        ...(update.description !== undefined && { description: update.description }),
      })
      .where(eq(groups.chatId, chatId));
  }

  async updateSettings(tx: Tx, chatId: string, changes: Partial<GroupSettings>): Promise<void> {
    await tx.update(groups).set(changes).where(eq(groups.chatId, chatId));
  }

  // Points the group at a claimed photo, or back to the generated fallback.
  // The previous photo's uploads become unreferenced and media cleanup
  // removes them.
  async setPhoto(
    tx: Tx,
    chatId: string,
    photo: { uploadId: string; thumbnailUploadId: string } | null,
  ): Promise<void> {
    await tx
      .update(groups)
      .set({
        photoUploadId: photo?.uploadId ?? null,
        photoThumbnailUploadId: photo?.thumbnailUploadId ?? null,
      })
      .where(eq(groups.chatId, chatId));
  }

  // Soft delete: history is retained, every membership ends, links and
  // requests are closed, and the photo is released for cleanup.
  async softDelete(tx: Tx, chatId: string): Promise<void> {
    await tx
      .update(groups)
      .set({ deletedAt: new Date(), photoUploadId: null, photoThumbnailUploadId: null })
      .where(eq(groups.chatId, chatId));
    await tx.execute(sql`
      UPDATE chat_members SET left_at = NOW(), role = 'member'
      WHERE chat_id = ${chatId} AND left_at IS NULL
    `);
    await this.revokeInvites(tx, chatId);
    await tx.execute(sql`
      UPDATE group_join_requests SET status = 'cancelled', decided_at = NOW()
      WHERE chat_id = ${chatId} AND status = 'pending'
    `);
  }

  async members(executor: Executor, chatId: string, viewerId: string): Promise<GroupMemberDto[]> {
    const result = await executor.execute<{
      user_id: string;
      display_name: string | null;
      photo_id: string | null;
      status: string;
      role: GroupRole;
      joined_at: string;
    }>(sql`
      SELECT m.user_id, u.display_name, ${photoIdFor(sql`u`, viewerId)} AS photo_id,
        u.status, m.role, ${isoTimestamp(sql`m.joined_at`)} AS joined_at
      FROM chat_members m JOIN users u ON u.id = m.user_id
      WHERE m.chat_id = ${chatId} AND m.left_at IS NULL
      ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END,
               lower(u.display_name) NULLS LAST, m.user_id
    `);
    return result.rows.map((row) => ({
      userId: row.user_id,
      displayName: row.status === "active" ? row.display_name : null,
      photoId: row.photo_id,
      available: row.status === "active",
      role: row.role,
      joinedAt: row.joined_at,
    }));
  }

  async creatorOf(executor: Executor, chatId: string): Promise<string> {
    const [row] = await executor
      .select({ createdBy: chats.createdBy, createdAt: chats.createdAt })
      .from(chats)
      .where(eq(chats.id, chatId));
    if (!row) throw groupErrors.groupNotFound();
    return row.createdBy;
  }

  // ---- Invites -------------------------------------------------------------

  async revokeInvites(tx: Tx, chatId: string): Promise<void> {
    await tx
      .update(groupInvites)
      .set({ revokedAt: new Date() })
      .where(and(eq(groupInvites.chatId, chatId), isNull(groupInvites.revokedAt)));
  }

  async createInvite(
    tx: Tx,
    input: {
      chatId: string;
      createdBy: string;
      tokenHash: Buffer;
      expiresAt: Date | null;
      maxUses: number | null;
    },
  ): Promise<InviteLinkDto> {
    await this.revokeInvites(tx, input.chatId);
    const [invite] = await tx.insert(groupInvites).values(input).returning();
    if (!invite) throw new Error("invite insert returned no row");
    return {
      createdAt: invite.createdAt.toISOString(),
      expiresAt: invite.expiresAt?.toISOString() ?? null,
      maxUses: invite.maxUses,
      useCount: invite.useCount,
    };
  }

  async activeInvite(executor: Executor, chatId: string): Promise<InviteLinkDto | null> {
    const [invite] = await executor
      .select()
      .from(groupInvites)
      .where(and(eq(groupInvites.chatId, chatId), isNull(groupInvites.revokedAt)));
    if (!invite) return null;
    return {
      createdAt: invite.createdAt.toISOString(),
      expiresAt: invite.expiresAt?.toISOString() ?? null,
      maxUses: invite.maxUses,
      useCount: invite.useCount,
    };
  }

  // A live, unexpired, not used-up invite of a live group.
  async findUsableInvite(executor: Executor, tokenHash: Buffer): Promise<ActiveInvite | undefined> {
    const [row] = await executor
      .select({ invite: groupInvites, group: groups })
      .from(groupInvites)
      .innerJoin(groups, eq(groups.chatId, groupInvites.chatId))
      .where(
        and(
          eq(groupInvites.tokenHash, tokenHash),
          isNull(groupInvites.revokedAt),
          isNull(groups.deletedAt),
          sql`(${groupInvites.expiresAt} IS NULL OR ${groupInvites.expiresAt} > NOW())`,
          sql`(${groupInvites.maxUses} IS NULL OR ${groupInvites.useCount} < ${groupInvites.maxUses})`,
        ),
      );
    if (!row?.group.inviteLinksEnabled) return undefined;
    return {
      id: row.invite.id,
      chatId: row.invite.chatId,
      expiresAt: row.invite.expiresAt,
      maxUses: row.invite.maxUses,
      useCount: row.invite.useCount,
      group: row.group,
    };
  }

  // Counts one use; false if the link was used up or revoked meanwhile.
  async consumeInvite(tx: Tx, inviteId: string): Promise<boolean> {
    const result = await tx.execute(sql`
      UPDATE group_invites SET use_count = use_count + 1
      WHERE id = ${inviteId} AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > NOW())
        AND (max_uses IS NULL OR use_count < max_uses)
      RETURNING id
    `);
    return result.rows.length > 0;
  }

  // ---- Join requests -------------------------------------------------------

  async createJoinRequest(tx: Tx, chatId: string, userId: string, inviteId: string): Promise<void> {
    await tx.execute(sql`
      INSERT INTO group_join_requests (chat_id, user_id, invite_id)
      VALUES (${chatId}, ${userId}, ${inviteId})
      ON CONFLICT (chat_id, user_id) WHERE status = 'pending' DO NOTHING
    `);
  }

  async hasPendingRequest(executor: Executor, chatId: string, userId: string): Promise<boolean> {
    const result = await executor.execute(sql`
      SELECT 1 FROM group_join_requests
      WHERE chat_id = ${chatId} AND user_id = ${userId} AND status = 'pending'
    `);
    return result.rows.length > 0;
  }

  async pendingRequests(
    executor: Executor,
    chatId: string,
    viewerId: string,
  ): Promise<JoinRequestDto[]> {
    const result = await executor.execute<{
      user_id: string;
      display_name: string | null;
      photo_id: string | null;
      created_at: string;
    }>(sql`
      SELECT r.user_id, u.display_name, ${photoIdFor(sql`u`, viewerId)} AS photo_id,
        ${isoTimestamp(sql`r.created_at`)} AS created_at
      FROM group_join_requests r JOIN users u ON u.id = r.user_id
      WHERE r.chat_id = ${chatId} AND r.status = 'pending' AND u.status = 'active'
      ORDER BY r.created_at, r.user_id
    `);
    return result.rows.map((row) => ({
      userId: row.user_id,
      displayName: row.display_name,
      photoId: row.photo_id,
      createdAt: row.created_at,
    }));
  }

  // Closes pending requests; returns the users whose request was closed.
  async closeRequests(
    tx: Tx,
    chatId: string,
    userIds: string[],
    status: "approved" | "rejected" | "cancelled",
    decidedBy: string | null,
  ): Promise<string[]> {
    if (userIds.length === 0) return [];
    const result = await tx.execute<{ user_id: string }>(sql`
      UPDATE group_join_requests
      SET status = ${status}, decided_at = NOW(), decided_by = ${decidedBy}
      WHERE chat_id = ${chatId} AND status = 'pending' AND user_id = ANY(${sql.param(userIds)}::uuid[])
      RETURNING user_id
    `);
    return result.rows.map((row) => row.user_id);
  }
}
