import { AppError } from "../../lib/errors.js";
import type { RateLimiter } from "../../lib/rate-limiter.js";
import type { RealtimePublisher } from "../../realtime/index.js";
import type { AuthContext } from "../auth/auth.types.js";
import { lockChat, type Tx } from "../chats/chat-tx.js";
import { claimMedia, claimPhoto } from "../media/media.repository.js";
import type { PhotoRef } from "../media/media.schemas.js";
import type { BroadcastDispatcher } from "./broadcasts.dispatcher.js";
import { broadcastErrors } from "./broadcasts.errors.js";
import type { BroadcastsRepository, LockedList } from "./broadcasts.repository.js";
import type { CreateListBody, SendBroadcastBody, UpdateListBody } from "./broadcasts.schemas.js";
import type {
  BroadcastDto,
  BroadcastListDetails,
  BroadcastListDto,
  RecipientReportDto,
} from "./broadcasts.types.js";

const CREATE_LIMIT = { limit: 30, windowSeconds: 3600 };
const EDIT_LIMIT = { limit: 300, windowSeconds: 3600 };
const SEND_LIMIT = { limit: 60, windowSeconds: 3600 };
const RETRY_LIMIT = { limit: 60, windowSeconds: 3600 };
// Shared with direct and group chats (same keys as MessagesService).
const STAR_LIMIT = { limit: 120, windowSeconds: 60 };
const CLEAR_LIMIT = { limit: 30, windowSeconds: 3600 };

export interface BroadcastsServiceDeps {
  repo: BroadcastsRepository;
  dispatcher: BroadcastDispatcher;
  realtime: RealtimePublisher;
  rateLimiter: RateLimiter;
  maxRecipients: number;
  // When false, sends are only accepted and left to the sweep (tests use
  // this to exercise recovery).
  dispatchInline: boolean;
}

// Every operation is scoped to the authenticated owner: lists that belong
// to someone else, or were deleted, are indistinguishable from missing.
export class BroadcastsService {
  constructor(private readonly deps: BroadcastsServiceDeps) {}

  private get repo() {
    return this.deps.repo;
  }

  private async limit(key: string, rule: { limit: number; windowSeconds: number }): Promise<void> {
    const result = await this.deps.rateLimiter.consume(key, rule.limit, rule.windowSeconds);
    if (!result.allowed) {
      throw new AppError(429, "RATE_LIMITED", "Too many requests. Try again later.", {
        retryAfterSeconds: result.retryAfterSeconds,
      });
    }
  }

  private async assertAddable(ownerId: string, userIds: string[]): Promise<void> {
    const check = await this.repo.checkRecipients(ownerId, userIds);
    if (check.unavailable.length > 0)
      throw broadcastErrors.recipientsUnavailable(check.unavailable);
    if (check.blockedByOwner.length > 0)
      throw broadcastErrors.recipientsBlocked(check.blockedByOwner);
  }

  // Runs a change under the list lock, then tells the owner's devices.
  private async mutate(
    ownerId: string,
    listId: string,
    change: (tx: Tx, list: LockedList) => Promise<void>,
  ): Promise<void> {
    await this.repo.transaction(async (tx) => {
      const list = await this.repo.findList(tx, ownerId, listId, true);
      if (!list) throw broadcastErrors.listNotFound();
      await change(tx, list);
    });
    await this.deps.realtime.publish(ownerId, { type: "broadcast.list.updated", listId });
  }

  // ---- Lists ---------------------------------------------------------------

  // Idempotent per (owner, clientRequestId): a retry returns the list the
  // first attempt created. The list and its recipients are written in one
  // transaction.
  async create(
    ownerId: string,
    body: CreateListBody,
  ): Promise<{ list: BroadcastListDetails; created: boolean }> {
    const existing = await this.repo.findCreatedByRequest(ownerId, body.clientRequestId);
    if (existing) return { list: await this.details(ownerId, existing.id), created: false };

    const recipientIds = body.recipientIds.filter((id) => id !== ownerId);
    if (recipientIds.length === 0) throw broadcastErrors.invalidRecipients();
    if (recipientIds.length > this.deps.maxRecipients) {
      throw broadcastErrors.listFull(this.deps.maxRecipients);
    }
    await this.assertAddable(ownerId, recipientIds);
    await this.limit(`broadcast:create:${ownerId}`, CREATE_LIMIT);

    const listId = await this.repo.transaction(async (tx) => {
      const id = await this.repo.insertList(tx, {
        ownerId,
        clientRequestId: body.clientRequestId,
        name: body.name,
        recipientIds,
      });
      if (id && body.photo) {
        await claimPhoto(tx, ownerId, "broadcast_list_photo", body.photo);
        await this.repo.setPhoto(tx, id, body.photo);
      }
      return id;
    });
    if (!listId) {
      // A concurrent retry won the insert.
      const winner = await this.repo.findCreatedByRequest(ownerId, body.clientRequestId);
      if (!winner) throw broadcastErrors.listNotFound();
      return { list: await this.details(ownerId, winner.id), created: false };
    }

    await this.deps.realtime.publish(ownerId, { type: "broadcast.list.updated", listId });
    return { list: await this.details(ownerId, listId), created: true };
  }

  list(ownerId: string): Promise<BroadcastListDto[]> {
    return this.repo.lists(ownerId);
  }

  async details(ownerId: string, listId: string): Promise<BroadcastListDetails> {
    const [list] = await this.repo.lists(ownerId, listId);
    if (!list) throw broadcastErrors.listNotFound();
    return {
      ...list,
      maxRecipients: this.deps.maxRecipients,
      recipients: await this.repo.recipients(ownerId, listId),
    };
  }

  async update(
    ownerId: string,
    listId: string,
    body: UpdateListBody,
  ): Promise<BroadcastListDetails> {
    await this.limit(`broadcast:edit:${ownerId}`, EDIT_LIMIT);
    await this.mutate(ownerId, listId, (tx) => this.repo.updateList(tx, listId, body));
    return this.details(ownerId, listId);
  }

  // Owner only (every list lookup is scoped to the owner). Setting the
  // current photo again changes nothing.
  async setPhoto(ownerId: string, listId: string, photo: PhotoRef): Promise<BroadcastListDetails> {
    await this.limit(`broadcast:edit:${ownerId}`, EDIT_LIMIT);
    await this.mutate(ownerId, listId, async (tx, list) => {
      if (
        list.photoUploadId === photo.uploadId &&
        list.photoThumbnailUploadId === photo.thumbnailUploadId
      ) {
        return;
      }
      await claimPhoto(tx, ownerId, "broadcast_list_photo", photo);
      await this.repo.setPhoto(tx, listId, photo);
    });
    return this.details(ownerId, listId);
  }

  async removePhoto(ownerId: string, listId: string): Promise<BroadcastListDetails> {
    await this.limit(`broadcast:edit:${ownerId}`, EDIT_LIMIT);
    await this.mutate(ownerId, listId, async (tx, list) => {
      if (list.photoUploadId !== null) await this.repo.setPhoto(tx, listId, null);
    });
    return this.details(ownerId, listId);
  }

  // Applies to future broadcasts only; sent broadcasts keep their snapshot.
  async addRecipients(
    ownerId: string,
    listId: string,
    userIds: string[],
  ): Promise<BroadcastListDetails> {
    await this.limit(`broadcast:edit:${ownerId}`, EDIT_LIMIT);

    await this.mutate(ownerId, listId, async (tx) => {
      const candidates = userIds.filter((id) => id !== ownerId);
      if (candidates.length === 0) throw broadcastErrors.invalidRecipients();
      const current = new Set(await this.repo.activeRecipientIds(tx, listId));
      const added = candidates.filter((id) => !current.has(id));
      if (added.length === 0) return;
      if (current.size + added.length > this.deps.maxRecipients) {
        throw broadcastErrors.listFull(this.deps.maxRecipients);
      }
      await this.assertAddable(ownerId, added);
      await this.repo.addRecipients(tx, listId, added);
      await this.repo.touchList(tx, listId);
    });
    return this.details(ownerId, listId);
  }

  // The person keeps their direct chat and every message already sent;
  // they just aren't part of future broadcasts.
  async removeRecipient(
    ownerId: string,
    listId: string,
    userId: string,
  ): Promise<BroadcastListDetails> {
    await this.limit(`broadcast:edit:${ownerId}`, EDIT_LIMIT);
    await this.mutate(ownerId, listId, async (tx) => {
      if (!(await this.repo.removeRecipient(tx, listId, userId))) {
        throw broadcastErrors.recipientNotFound();
      }
      await this.repo.touchList(tx, listId);
    });
    return this.details(ownerId, listId);
  }

  // Soft delete under the list lock: a send either committed its snapshot
  // first (and is still delivered) or sees the list as gone.
  async delete(ownerId: string, listId: string): Promise<void> {
    await this.repo.transaction(async (tx) => {
      const list = await this.repo.findList(tx, ownerId, listId, true);
      if (!list) throw broadcastErrors.listNotFound();
      await this.repo.softDelete(tx, listId);
    });
    await this.deps.realtime.publish(ownerId, { type: "broadcast.list.deleted", listId });
  }

  // ---- Broadcasts ----------------------------------------------------------

  private async broadcast(ownerId: string, listId: string, id: string): Promise<BroadcastDto> {
    const dto = await this.repo.findBroadcast(ownerId, listId, id);
    if (!dto) throw broadcastErrors.broadcastNotFound();
    return dto;
  }

  // Accepts the broadcast (operation + recipient snapshot, committed under
  // the list lock), then writes each recipient's direct message. Retries
  // with the same client message ID return the original broadcast.
  async send(
    auth: AuthContext,
    listId: string,
    body: SendBroadcastBody,
  ): Promise<{ broadcast: BroadcastDto; created: boolean }> {
    const prior = await this.repo.findBroadcastByClientId(
      this.repo.executor,
      auth.userId,
      body.clientMessageId,
    );
    if (prior) {
      if (prior.listId !== listId) throw broadcastErrors.clientMessageIdConflict();
      if (!(await this.repo.findList(this.repo.executor, auth.userId, listId))) {
        throw broadcastErrors.listNotFound();
      }
      return { broadcast: await this.broadcast(auth.userId, listId, prior.id), created: false };
    }

    if (!(await this.repo.findList(this.repo.executor, auth.userId, listId))) {
      throw broadcastErrors.listNotFound();
    }
    await this.limit(`broadcast:send:${auth.userId}`, SEND_LIMIT);

    const accepted = await this.repo.transaction(async (tx) => {
      const list = await this.repo.findList(tx, auth.userId, listId, true);
      if (!list) throw broadcastErrors.listNotFound();
      // A concurrent retry that committed first (it held the list lock).
      const raced = await this.repo.findBroadcastByClientId(tx, auth.userId, body.clientMessageId);
      if (raced) {
        if (raced.listId !== listId) throw broadcastErrors.clientMessageIdConflict();
        return { id: raced.id, created: false };
      }
      if ((await this.repo.activeRecipientIds(tx, listId)).length === 0) {
        throw broadcastErrors.noRecipients();
      }
      const media =
        body.attachment && body.type !== "text"
          ? await claimMedia(tx, auth.userId, { ...body.attachment, category: body.type })
          : null;
      const id = await this.repo.accept(tx, {
        listId,
        senderId: auth.userId,
        senderDeviceId: auth.deviceId,
        clientMessageId: body.clientMessageId,
        type: body.type,
        ciphertext: Buffer.from(body.ciphertext, "base64"),
        attachmentUploadId: media?.upload.id ?? null,
        thumbnailUploadId: media?.thumbnail?.id ?? null,
      });
      return { id, created: true };
    });

    if (accepted.created) {
      await this.deps.dispatcher.publishUpdate(accepted.id, "accepted");
      if (this.deps.dispatchInline) await this.deps.dispatcher.process(accepted.id);
    }
    return {
      broadcast: await this.broadcast(auth.userId, listId, accepted.id),
      created: accepted.created,
    };
  }

  async history(
    ownerId: string,
    listId: string,
    query: { before?: string | undefined; limit: number },
  ): Promise<{ broadcasts: BroadcastDto[]; hasMore: boolean }> {
    if (!(await this.repo.findList(this.repo.executor, ownerId, listId))) {
      throw broadcastErrors.listNotFound();
    }
    return this.repo.history(ownerId, listId, query);
  }

  private async requireList(ownerId: string, listId: string): Promise<void> {
    if (!(await this.repo.findList(this.repo.executor, ownerId, listId))) {
      throw broadcastErrors.listNotFound();
    }
  }

  async shared(
    ownerId: string,
    listId: string,
    query: { kind: "media" | "docs"; before?: number | undefined; limit: number },
  ): Promise<{ broadcasts: BroadcastDto[]; hasMore: boolean }> {
    await this.requireList(ownerId, listId);
    return this.repo.shared(ownerId, listId, query);
  }

  async starred(
    ownerId: string,
    listId: string,
    query: { before?: number | undefined; limit: number },
  ): Promise<{ broadcasts: BroadcastDto[]; hasMore: boolean }> {
    await this.requireList(ownerId, listId);
    return this.repo.starred(ownerId, listId, query);
  }

  // A broadcast's star is the owner's star on a copy it was delivered as:
  // starring marks the earliest live copy (so it also shows in that direct
  // chat), unstarring clears every copy. Both are idempotent and only the
  // owner's devices are told.
  async star(
    ownerId: string,
    listId: string,
    broadcastId: string,
    starred: boolean,
  ): Promise<BroadcastDto> {
    await this.requireList(ownerId, listId);
    await this.broadcast(ownerId, listId, broadcastId);
    await this.limit(`msg:star:${ownerId}`, STAR_LIMIT);

    let changed: { messageId: string; chatId: string }[];
    if (starred) {
      const current = await this.broadcast(ownerId, listId, broadcastId);
      if (current.starred) return current;
      const [copy] = await this.repo.liveCopies(this.repo.executor, ownerId, broadcastId);
      if (!copy) throw broadcastErrors.notStarrable();
      const added = await this.repo.transaction(async (tx) => {
        await lockChat(tx, copy.chatId);
        return this.repo.starCopy(tx, ownerId, copy.messageId);
      });
      if (!added) throw broadcastErrors.notStarrable();
      changed = [copy];
    } else {
      changed = await this.repo.transaction((tx) =>
        this.repo.unstarCopies(tx, ownerId, broadcastId),
      );
    }

    const broadcast = await this.broadcast(ownerId, listId, broadcastId);
    for (const copy of changed) {
      await this.deps.realtime.publish(ownerId, {
        type: "message.starred",
        chatId: copy.chatId,
        messageId: copy.messageId,
        starred,
      });
    }
    if (changed.length > 0) {
      await this.deps.realtime.publish(ownerId, {
        type: "broadcast.updated",
        listId,
        reason: "starred",
        broadcast,
      });
    }
    return broadcast;
  }

  // Clears the owner's view of the list's history. Recipients' direct
  // chats, and the owner's own direct chats with them, keep every message.
  async clear(
    ownerId: string,
    listId: string,
    keepStarred: boolean,
  ): Promise<{ listId: string; clearedThroughSeq: number }> {
    await this.requireList(ownerId, listId);
    await this.limit(`chat:clear:${ownerId}`, CLEAR_LIMIT);

    const result = await this.repo.transaction(async (tx) => {
      if (!(await this.repo.findList(tx, ownerId, listId, true))) {
        throw broadcastErrors.listNotFound();
      }
      return this.repo.clearHistory(tx, ownerId, listId, keepStarred);
    });

    for (const copy of result.unstarred) {
      await this.deps.realtime.publish(ownerId, {
        type: "message.starred",
        chatId: copy.chatId,
        messageId: copy.messageId,
        starred: false,
      });
    }
    await this.deps.realtime.publish(ownerId, { type: "broadcast.list.cleared", listId });
    return { listId, clearedThroughSeq: result.clearedThroughSeq };
  }

  async report(
    ownerId: string,
    listId: string,
    broadcastId: string,
  ): Promise<{ broadcast: BroadcastDto; recipients: RecipientReportDto[] }> {
    if (!(await this.repo.findList(this.repo.executor, ownerId, listId))) {
      throw broadcastErrors.listNotFound();
    }
    const broadcast = await this.broadcast(ownerId, listId, broadcastId);
    return { broadcast, recipients: await this.repo.report(ownerId, broadcastId) };
  }

  // Re-queues only recipients whose failure a retry may fix, then delivers
  // them. Anything already sent is untouched, so nothing is duplicated.
  async retry(ownerId: string, listId: string, broadcastId: string): Promise<BroadcastDto> {
    if (!(await this.repo.findList(this.repo.executor, ownerId, listId))) {
      throw broadcastErrors.listNotFound();
    }
    await this.broadcast(ownerId, listId, broadcastId);
    await this.limit(`broadcast:retry:${ownerId}`, RETRY_LIMIT);

    const requeued = await this.repo.transaction((tx) =>
      this.repo.requeueRetryable(tx, broadcastId),
    );
    if (requeued > 0) {
      await this.deps.dispatcher.publishUpdate(broadcastId, "retry");
      if (this.deps.dispatchInline) await this.deps.dispatcher.process(broadcastId);
    }
    return this.broadcast(ownerId, listId, broadcastId);
  }

  // Called after a recipient's delivered/read pointers advance in a direct
  // chat: moves the matching recipient records forward and tells owners.
  async onDirectReceipts(
    recipientId: string,
    chatId: string,
    receipts: { deliveredSequence: number; readSequence: number },
  ): Promise<void> {
    const changes = await this.repo.applyReceipts(
      recipientId,
      chatId,
      receipts.deliveredSequence,
      receipts.readSequence,
    );
    // One recipient record per broadcast, so one change per broadcast.
    for (const change of changes) {
      if (!change.visible) continue;
      await this.deps.dispatcher.publishUpdate(
        change.broadcastId,
        change.read ? "read" : "delivered",
      );
    }
  }
}
