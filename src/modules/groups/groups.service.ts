import { createHash, randomBytes } from "node:crypto";

import type { Message } from "../../db/schema/index.js";
import { AppError } from "../../lib/errors.js";
import type { RateLimiter } from "../../lib/rate-limiter.js";
import type { RealtimePublisher } from "../../realtime/index.js";
import { insertSystemMessage, type Tx } from "../chats/chat-tx.js";
import type { ChatsRepository } from "../chats/chats.repository.js";
import type { ChatSummary } from "../chats/chats.types.js";
import { claimPhoto } from "../media/media.repository.js";
import type { PhotoRef } from "../media/media.schemas.js";
import { toMessageDto } from "../messages/messages.types.js";
import { groupErrors } from "./groups.errors.js";
import { can, canActOn, isAdmin, type GroupSettings } from "./groups.policy.js";
import type { GroupsRepository, LockedGroup } from "./groups.repository.js";
import type {
  CreateGroupBody,
  CreateInviteBody,
  UpdateGroupBody,
  UpdateSettingsBody,
} from "./groups.schemas.js";
import type {
  GroupDetails,
  InviteLinkDto,
  InvitePreview,
  SystemEventInput,
} from "./groups.types.js";

const CREATE_LIMIT = { limit: 30, windowSeconds: 3600 };
const INVITE_LIMIT = { limit: 60, windowSeconds: 3600 };

export interface GroupsServiceDeps {
  groups: GroupsRepository;
  chats: ChatsRepository;
  realtime: RealtimePublisher;
  rateLimiter: RateLimiter;
  maxMembers: number;
}

// What a committed change must announce. Published only after commit, to
// the members active at that moment.
interface Effects {
  messages: Message[];
  // Group metadata, roles or membership changed.
  updated: boolean;
  // Users who lost access (left, removed, group deleted).
  removed: string[];
}

function noEffects(): Effects {
  return { messages: [], updated: false, removed: [] };
}

export function hashInviteToken(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

export type JoinResult = { status: "joined"; chatId: string } | { status: "pending" };

export class GroupsService {
  constructor(private readonly deps: GroupsServiceDeps) {}

  private get repo() {
    return this.deps.groups;
  }

  private async limit(key: string, rule: { limit: number; windowSeconds: number }): Promise<void> {
    const result = await this.deps.rateLimiter.consume(key, rule.limit, rule.windowSeconds);
    if (!result.allowed) {
      throw new AppError(429, "RATE_LIMITED", "Too many requests. Try again later.", {
        retryAfterSeconds: result.retryAfterSeconds,
      });
    }
  }

  private async publish(chatId: string, effects: Effects): Promise<void> {
    const members = await this.repo.memberIds(chatId);
    for (const message of effects.messages) {
      await this.deps.realtime.publishMany(members, {
        type: "message.new",
        chatId,
        message: toMessageDto(message),
      });
    }
    if (effects.updated) {
      await this.deps.realtime.publishMany(members, { type: "chat.updated", chatId });
    }
    if (effects.removed.length > 0) {
      await this.deps.realtime.publishMany(effects.removed, { type: "chat.removed", chatId });
    }
  }

  private async system(tx: Tx, chatId: string, effects: Effects, event: SystemEventInput) {
    effects.messages.push(await insertSystemMessage(tx, chatId, event));
  }

  // Runs a locked change, then announces it.
  private async mutate(
    chatId: string,
    actorId: string,
    change: (tx: Tx, state: LockedGroup, effects: Effects) => Promise<void>,
  ): Promise<void> {
    const effects = noEffects();
    await this.repo.withGroup(chatId, actorId, (tx, state) => change(tx, state, effects));
    await this.publish(chatId, effects);
  }

  private require(allowed: boolean, action: string): void {
    if (!allowed) throw groupErrors.forbidden(action);
  }

  private async summary(userId: string, chatId: string): Promise<ChatSummary> {
    const summary = await this.deps.chats.findSummary(userId, chatId);
    if (!summary) throw groupErrors.groupNotFound();
    return summary;
  }

  // Rejects anyone who can't be added by `actorId`.
  private async assertAddable(actorId: string, userIds: string[]): Promise<void> {
    const check = await this.repo.checkParticipants(actorId, userIds);
    if (check.unavailable.length > 0) throw groupErrors.participantsUnavailable(check.unavailable);
    if (check.blockedByActor.length > 0)
      throw groupErrors.blockedParticipants(check.blockedByActor);
  }

  // ---- Create / read -------------------------------------------------------

  // Idempotent per (creator, clientRequestId): a retry returns the group the
  // first attempt created. Chat, group, memberships and the "created" event
  // are written in one transaction.
  async create(
    userId: string,
    body: CreateGroupBody,
  ): Promise<{ chat: ChatSummary; created: boolean }> {
    const existing = await this.repo.findCreatedByRequest(userId, body.clientRequestId);
    if (existing) return { chat: await this.summary(userId, existing), created: false };

    const memberIds = body.memberIds.filter((id) => id !== userId);
    if (memberIds.length === 0) throw groupErrors.invalidParticipants();
    if (memberIds.length + 1 > this.deps.maxMembers)
      throw groupErrors.groupFull(this.deps.maxMembers);
    await this.assertAddable(userId, memberIds);
    await this.limit(`group:create:${userId}`, CREATE_LIMIT);

    const effects = noEffects();
    const chatId = await this.repo.transaction(async (tx) => {
      const id = await this.repo.insertGroup(tx, {
        creatorId: userId,
        clientRequestId: body.clientRequestId,
        name: body.name,
        description: body.description ?? null,
        memberIds,
      });
      if (!id) return undefined;
      if (body.photo) {
        await claimPhoto(tx, userId, "group_photo", body.photo);
        await this.repo.setPhoto(tx, id, body.photo);
      }
      await this.system(tx, id, effects, {
        kind: "group.created",
        actorId: userId,
        name: body.name,
        userIds: memberIds,
      });
      return id;
    });

    if (!chatId) {
      // A concurrent retry won the insert.
      const winner = await this.repo.findCreatedByRequest(userId, body.clientRequestId);
      if (!winner) throw groupErrors.groupNotFound();
      return { chat: await this.summary(userId, winner), created: false };
    }

    await this.publish(chatId, effects);
    return { chat: await this.summary(userId, chatId), created: true };
  }

  async details(userId: string, chatId: string): Promise<GroupDetails> {
    const group = await this.repo.findGroup(this.repo.executor, chatId);
    const role = group ? await this.repo.memberRole(this.repo.executor, chatId, userId) : undefined;
    if (!group || !role) throw groupErrors.groupNotFound();

    const admin = isAdmin(role);
    const [members, createdBy, invite, pendingRequests] = await Promise.all([
      this.repo.members(this.repo.executor, chatId, userId),
      this.repo.creatorOf(this.repo.executor, chatId),
      admin ? this.repo.activeInvite(this.repo.executor, chatId) : Promise.resolve(null),
      admin ? this.repo.pendingRequests(this.repo.executor, chatId, userId) : Promise.resolve(null),
    ]);

    return {
      chatId,
      name: group.name,
      description: group.description,
      photoId: group.photoUploadId,
      createdAt: group.createdAt.toISOString(),
      createdBy,
      myRole: role,
      settings: {
        onlyAdminsCanEditInfo: group.onlyAdminsCanEditInfo,
        onlyAdminsCanMessage: group.onlyAdminsCanMessage,
        onlyAdminsCanAddMembers: group.onlyAdminsCanAddMembers,
        approvalRequired: group.approvalRequired,
        inviteLinksEnabled: group.inviteLinksEnabled,
        historyVisibleToNewMembers: group.historyVisibleToNewMembers,
      },
      memberLimit: this.deps.maxMembers,
      members,
      invite,
      pendingRequests,
    };
  }

  // ---- Info and settings ---------------------------------------------------

  async updateInfo(userId: string, chatId: string, body: UpdateGroupBody): Promise<GroupDetails> {
    await this.mutate(chatId, userId, async (tx, { group, settings, actor }, effects) => {
      this.require(can("editInfo", actor.role, settings), "editInfo");
      const name = body.name !== undefined && body.name !== group.name ? body.name : undefined;
      const description =
        body.description !== undefined && body.description !== group.description
          ? body.description
          : undefined;
      if (name === undefined && description === undefined) return;

      await this.repo.updateInfo(tx, chatId, { name, description });
      effects.updated = true;
      await this.system(tx, chatId, effects, {
        kind: "info.changed",
        actorId: userId,
        name: name ?? null,
        descriptionChanged: description !== undefined,
      });
    });
    return this.details(userId, chatId);
  }

  // Whoever may edit the group's info may change its photo. Setting the
  // current photo again (a retried request) changes nothing.
  async setPhoto(userId: string, chatId: string, photo: PhotoRef): Promise<GroupDetails> {
    await this.mutate(chatId, userId, async (tx, { group, settings, actor }, effects) => {
      this.require(can("editInfo", actor.role, settings), "editInfo");
      if (
        group.photoUploadId === photo.uploadId &&
        group.photoThumbnailUploadId === photo.thumbnailUploadId
      ) {
        return;
      }
      await claimPhoto(tx, userId, "group_photo", photo);
      await this.repo.setPhoto(tx, chatId, photo);
      effects.updated = true;
      await this.system(tx, chatId, effects, {
        kind: "photo.changed",
        actorId: userId,
        removed: false,
      });
    });
    return this.details(userId, chatId);
  }

  // Back to the generated fallback. Removing when there is no photo is a
  // no-op.
  async removePhoto(userId: string, chatId: string): Promise<GroupDetails> {
    await this.mutate(chatId, userId, async (tx, { group, settings, actor }, effects) => {
      this.require(can("editInfo", actor.role, settings), "editInfo");
      if (group.photoUploadId === null) return;
      await this.repo.setPhoto(tx, chatId, null);
      effects.updated = true;
      await this.system(tx, chatId, effects, {
        kind: "photo.changed",
        actorId: userId,
        removed: true,
      });
    });
    return this.details(userId, chatId);
  }

  async updateSettings(
    userId: string,
    chatId: string,
    body: UpdateSettingsBody,
  ): Promise<GroupDetails> {
    await this.mutate(chatId, userId, async (tx, { settings, actor }, effects) => {
      this.require(can("changeSettings", actor.role, settings), "changeSettings");
      const changes: Partial<GroupSettings> = {};
      for (const key of Object.keys(body) as (keyof GroupSettings)[]) {
        const value = body[key];
        if (value !== undefined && value !== settings[key]) changes[key] = value;
      }
      if (Object.keys(changes).length === 0) return;

      await this.repo.updateSettings(tx, chatId, changes);
      // Turning links off kills the current link rather than pausing it.
      if (changes.inviteLinksEnabled === false) await this.repo.revokeInvites(tx, chatId);
      effects.updated = true;
      await this.system(tx, chatId, effects, {
        kind: "settings.changed",
        actorId: userId,
        changes,
      });
    });
    return this.details(userId, chatId);
  }

  // ---- Membership ----------------------------------------------------------

  async addMembers(userId: string, chatId: string, userIds: string[]): Promise<GroupDetails> {
    const targets = userIds.filter((id) => id !== userId);
    if (targets.length === 0) throw groupErrors.invalidParticipants();
    await this.assertAddable(userId, targets);

    await this.mutate(chatId, userId, async (tx, { settings, actor }, effects) => {
      this.require(can("addMembers", actor.role, settings), "addMembers");
      const existing = await this.repo.activeRoles(tx, chatId, targets);
      if (existing.size > 0) throw groupErrors.alreadyMembers([...existing.keys()]);
      const count = await this.repo.activeMemberCount(tx, chatId);
      if (count + targets.length > this.deps.maxMembers) {
        throw groupErrors.groupFull(this.deps.maxMembers);
      }

      await this.repo.activateMembers(tx, chatId, targets, settings.historyVisibleToNewMembers);
      await this.repo.closeRequests(tx, chatId, targets, "approved", userId);
      effects.updated = true;
      await this.system(tx, chatId, effects, {
        kind: "members.added",
        actorId: userId,
        userIds: targets,
      });
    });
    return this.details(userId, chatId);
  }

  async removeMember(userId: string, chatId: string, targetId: string): Promise<GroupDetails> {
    if (targetId === userId) throw groupErrors.cannotActOnSelf();
    await this.mutate(chatId, userId, async (tx, { actor }, effects) => {
      const targetRole = await this.repo.memberRole(tx, chatId, targetId);
      if (!targetRole) throw groupErrors.memberNotFound();
      this.require(canActOn("removeMember", actor.role, targetRole), "removeMember");

      await this.repo.endMembership(tx, chatId, targetId, userId);
      effects.updated = true;
      effects.removed.push(targetId);
      await this.system(tx, chatId, effects, {
        kind: "member.removed",
        actorId: userId,
        userId: targetId,
      });
    });
    return this.details(userId, chatId);
  }

  async setRole(
    userId: string,
    chatId: string,
    targetId: string,
    role: "admin" | "member",
  ): Promise<GroupDetails> {
    if (targetId === userId) throw groupErrors.cannotActOnSelf();
    await this.mutate(chatId, userId, async (tx, { actor }, effects) => {
      const targetRole = await this.repo.memberRole(tx, chatId, targetId);
      if (!targetRole) throw groupErrors.memberNotFound();
      if (targetRole === role) return;
      const action = role === "admin" ? "promoteToAdmin" : "demoteAdmin";
      this.require(canActOn(action, actor.role, targetRole), action);

      await this.repo.setRole(tx, chatId, targetId, role);
      effects.updated = true;
      await this.system(tx, chatId, effects, {
        kind: "role.changed",
        actorId: userId,
        userId: targetId,
        role,
      });
    });
    return this.details(userId, chatId);
  }

  // The owner becomes an admin and the target the owner, in one
  // transaction under the chat lock.
  async transferOwnership(userId: string, chatId: string, targetId: string): Promise<GroupDetails> {
    if (targetId === userId) throw groupErrors.cannotActOnSelf();
    await this.mutate(chatId, userId, async (tx, { actor }, effects) => {
      const targetRole = await this.repo.memberRole(tx, chatId, targetId);
      if (!targetRole) throw groupErrors.memberNotFound();
      this.require(canActOn("transferOwnership", actor.role, targetRole), "transferOwnership");

      await this.repo.setRole(tx, chatId, userId, "admin");
      await this.repo.setRole(tx, chatId, targetId, "owner");
      effects.updated = true;
      await this.system(tx, chatId, effects, {
        kind: "owner.changed",
        actorId: userId,
        userId: targetId,
      });
    });
    return this.details(userId, chatId);
  }

  // An owner who leaves hands ownership to `newOwnerId`, or else to the
  // longest-standing admin, or else the longest-standing member. The last
  // member leaving deletes the group (there is no one left to own it).
  async leave(userId: string, chatId: string, newOwnerId?: string): Promise<void> {
    await this.mutate(chatId, userId, async (tx, { actor }, effects) => {
      effects.removed.push(userId);
      effects.updated = true;
      const count = await this.repo.activeMemberCount(tx, chatId);
      if (count <= 1) {
        await this.repo.softDelete(tx, chatId);
        return;
      }

      let successor: string | undefined;
      if (actor.role === "owner") {
        if (newOwnerId && newOwnerId !== userId) {
          if (!(await this.repo.memberRole(tx, chatId, newOwnerId)))
            throw groupErrors.memberNotFound();
          successor = newOwnerId;
        } else {
          successor = await this.repo.successor(tx, chatId, userId);
        }
        if (!successor) throw new Error("group with members has no successor");
      }

      await this.repo.endMembership(tx, chatId, userId, null);
      await this.system(tx, chatId, effects, { kind: "member.left", actorId: userId });
      if (successor) {
        await this.repo.setRole(tx, chatId, successor, "owner");
        await this.system(tx, chatId, effects, {
          kind: "owner.changed",
          actorId: userId,
          userId: successor,
        });
      }
    });
  }

  // Owner only. History is kept server-side; every membership ends and the
  // group disappears from every member's chat list.
  async deleteGroup(userId: string, chatId: string): Promise<void> {
    await this.mutate(chatId, userId, async (tx, { settings, actor }, effects) => {
      this.require(can("deleteGroup", actor.role, settings), "deleteGroup");
      effects.removed.push(...(await this.repo.memberIds(chatId, tx)));
      await this.repo.softDelete(tx, chatId);
    });
  }

  // ---- Invites -------------------------------------------------------------

  // The token is returned once; only its hash is stored. Creating a link
  // revokes the previous one.
  async createInvite(
    userId: string,
    chatId: string,
    body: CreateInviteBody,
  ): Promise<{ token: string; invite: InviteLinkDto }> {
    const token = randomBytes(32).toString("base64url");
    let invite: InviteLinkDto | undefined;
    await this.mutate(chatId, userId, async (tx, { settings, actor }) => {
      this.require(can("manageInvites", actor.role, settings), "manageInvites");
      if (!settings.inviteLinksEnabled) throw groupErrors.invitesDisabled();
      invite = await this.repo.createInvite(tx, {
        chatId,
        createdBy: userId,
        tokenHash: hashInviteToken(token),
        expiresAt: body.expiresInHours
          ? new Date(Date.now() + body.expiresInHours * 3_600_000)
          : null,
        maxUses: body.maxUses ?? null,
      });
    });
    if (!invite) throw new Error("invite was not created");
    return { token, invite };
  }

  async revokeInvite(userId: string, chatId: string): Promise<void> {
    await this.mutate(chatId, userId, async (tx, { settings, actor }) => {
      this.require(can("manageInvites", actor.role, settings), "manageInvites");
      await this.repo.revokeInvites(tx, chatId);
    });
  }

  // Shows only what a link holder needs to decide; never the member list.
  async previewInvite(userId: string, token: string): Promise<InvitePreview> {
    await this.limit(`group:invite:${userId}`, INVITE_LIMIT);
    const invite = await this.repo.findUsableInvite(this.repo.executor, hashInviteToken(token));
    if (!invite) throw groupErrors.inviteInvalid();
    const [count, role] = await Promise.all([
      this.repo.activeMemberCount(this.repo.executor, invite.chatId),
      this.repo.memberRole(this.repo.executor, invite.chatId, userId),
    ]);
    return {
      name: invite.group.name,
      description: invite.group.description,
      memberCount: count,
      approvalRequired: invite.group.approvalRequired,
      alreadyMember: role !== undefined,
      chatId: role !== undefined ? invite.chatId : null,
    };
  }

  // Joins straight away, or files a join request when the group requires
  // approval. People an admin removed can't come back through a link.
  async joinByInvite(userId: string, token: string): Promise<JoinResult> {
    await this.limit(`group:invite:${userId}`, INVITE_LIMIT);
    const found = await this.repo.findUsableInvite(this.repo.executor, hashInviteToken(token));
    if (!found) throw groupErrors.inviteInvalid();

    const effects = noEffects();
    const result = await this.repo.withGroupLock(
      found.chatId,
      async (tx, group): Promise<JoinResult> => {
        if (!group.inviteLinksEnabled) throw groupErrors.inviteInvalid();
        if (await this.repo.memberRole(tx, group.chatId, userId)) {
          return { status: "joined", chatId: group.chatId };
        }
        if (await this.repo.wasRemoved(tx, group.chatId, userId)) throw groupErrors.joinForbidden();

        if (group.approvalRequired) {
          if (!(await this.repo.hasPendingRequest(tx, group.chatId, userId))) {
            if (!(await this.repo.consumeInvite(tx, found.id))) throw groupErrors.inviteInvalid();
            await this.repo.createJoinRequest(tx, group.chatId, userId, found.id);
            effects.updated = true;
          }
          return { status: "pending" };
        }

        const count = await this.repo.activeMemberCount(tx, group.chatId);
        if (count + 1 > this.deps.maxMembers) throw groupErrors.groupFull(this.deps.maxMembers);
        if (!(await this.repo.consumeInvite(tx, found.id))) throw groupErrors.inviteInvalid();
        await this.repo.activateMembers(
          tx,
          group.chatId,
          [userId],
          group.historyVisibleToNewMembers,
        );
        effects.updated = true;
        await this.system(tx, group.chatId, effects, {
          kind: "member.joined",
          actorId: userId,
          approvedBy: null,
        });
        return { status: "joined", chatId: group.chatId };
      },
    );

    await this.publish(found.chatId, effects);
    return result;
  }

  // ---- Join requests -------------------------------------------------------

  async approveRequest(userId: string, chatId: string, targetId: string): Promise<GroupDetails> {
    await this.mutate(chatId, userId, async (tx, { settings, actor }, effects) => {
      this.require(can("reviewJoinRequests", actor.role, settings), "reviewJoinRequests");
      const closed = await this.repo.closeRequests(tx, chatId, [targetId], "approved", userId);
      if (closed.length === 0) throw groupErrors.requestNotFound();
      if (await this.repo.memberRole(tx, chatId, targetId)) return;
      if (!(await this.deps.chats.findActiveUser(targetId))) {
        throw groupErrors.participantsUnavailable([targetId]);
      }
      const count = await this.repo.activeMemberCount(tx, chatId);
      if (count + 1 > this.deps.maxMembers) throw groupErrors.groupFull(this.deps.maxMembers);

      await this.repo.activateMembers(tx, chatId, [targetId], settings.historyVisibleToNewMembers);
      effects.updated = true;
      await this.system(tx, chatId, effects, {
        kind: "member.joined",
        actorId: targetId,
        approvedBy: userId,
      });
    });
    return this.details(userId, chatId);
  }

  async rejectRequest(userId: string, chatId: string, targetId: string): Promise<GroupDetails> {
    await this.mutate(chatId, userId, async (tx, { settings, actor }) => {
      this.require(can("reviewJoinRequests", actor.role, settings), "reviewJoinRequests");
      const closed = await this.repo.closeRequests(tx, chatId, [targetId], "rejected", userId);
      if (closed.length === 0) throw groupErrors.requestNotFound();
    });
    return this.details(userId, chatId);
  }
}
