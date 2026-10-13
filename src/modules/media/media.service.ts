import { randomBytes } from "node:crypto";

import type { FastifyBaseLogger } from "fastify";

import type { MediaUpload } from "../../db/schema/index.js";
import { AppError } from "../../lib/errors.js";
import type { RateLimiter } from "../../lib/rate-limiter.js";
import type { ChatsRepository } from "../chats/chats.repository.js";
import { mediaErrors } from "./media.errors.js";
import {
  checkDeclared,
  matchesSignature,
  maxBytesFor,
  normalizeMimeType,
  sanitizeFileName,
  SIGNATURE_BYTES,
  STORAGE_PREFIXES,
  type MediaPurpose,
} from "./media.policy.js";
import type { MediaRepository } from "./media.repository.js";
import type { CreateUploadBody } from "./media.schemas.js";
import type { ObjectStorage } from "./media.storage.js";
import { toUploadDto, type DownloadUrl, type UploadDto, type UploadTarget } from "./media.types.js";

const CREATE_BURST_LIMIT = { limit: 30, windowSeconds: 60 };
const CREATE_LIMIT = { limit: 300, windowSeconds: 3600 };
const COMPLETE_LIMIT = { limit: 120, windowSeconds: 60 };
const URL_LIMIT = { limit: 600, windowSeconds: 3600 };

export interface MediaSettings {
  maxFileBytes: number;
  uploadUrlTtlSeconds: number;
  downloadUrlTtlSeconds: number;
}

export interface MediaServiceDeps {
  repo: MediaRepository;
  chats: ChatsRepository;
  // Null when no bucket is configured: every media operation answers 503.
  storage: ObjectStorage | null;
  rateLimiter: RateLimiter;
  settings: MediaSettings;
  log: FastifyBaseLogger;
}

// Server-generated, opaque, and unrelated to any id the API exposes.
export function newStorageKey(purpose: MediaPurpose = "attachment"): string {
  return `${STORAGE_PREFIXES[purpose]}${randomBytes(16).toString("hex")}/original`;
}

export class MediaService {
  constructor(private readonly deps: MediaServiceDeps) {}

  private get storage(): ObjectStorage {
    if (!this.deps.storage) throw mediaErrors.unavailable();
    return this.deps.storage;
  }

  private assertAvailable(): void {
    if (!this.deps.storage) throw mediaErrors.unavailable();
  }

  private async limit(key: string, rule: { limit: number; windowSeconds: number }): Promise<void> {
    const result = await this.deps.rateLimiter.consume(key, rule.limit, rule.windowSeconds);
    if (!result.allowed) {
      throw new AppError(429, "RATE_LIMITED", "Too many requests. Try again later.", {
        retryAfterSeconds: result.retryAfterSeconds,
      });
    }
  }

  private async target(upload: MediaUpload): Promise<UploadTarget> {
    const expiresInSeconds = Math.max(
      1,
      Math.floor((upload.uploadExpiresAt.getTime() - Date.now()) / 1000),
    );
    const presigned = await this.storage.presignUpload({
      key: upload.storageKey,
      contentType: upload.mimeType,
      contentLength: upload.declaredSize,
      expiresInSeconds,
    });
    return { ...presigned, expiresAt: upload.uploadExpiresAt.toISOString() };
  }

  // Best effort; cleanup retries anything that fails here.
  private async removeObject(upload: MediaUpload): Promise<void> {
    try {
      await this.storage.delete(upload.storageKey);
      await this.deps.repo.markObjectDeleted(upload.id);
    } catch (error) {
      this.deps.log.warn({ err: error, uploadId: upload.id }, "media object delete failed");
    }
  }

  // Opens an upload session: validates the declared file and returns a
  // presigned PUT that only accepts exactly the declared size and type.
  // Idempotent per (owner, clientUploadId): a retry of a pending session
  // gets a fresh URL for the same object.
  async createUpload(
    ownerId: string,
    body: CreateUploadBody,
  ): Promise<{ upload: UploadDto; target: UploadTarget | null; created: boolean }> {
    this.assertAvailable();
    const purpose = body.purpose ?? "attachment";
    const fileName = sanitizeFileName(body.fileName);
    const declared = checkDeclared({
      purpose,
      category: body.category,
      mimeType: body.mimeType,
      fileName,
    });
    if (!declared.ok) {
      if (declared.reason === "UNSUPPORTED_TYPE") throw mediaErrors.unsupportedType();
      if (declared.reason === "TYPE_MISMATCH") throw mediaErrors.typeMismatch();
      throw mediaErrors.extensionMismatch();
    }
    const maxBytes = maxBytesFor(purpose, this.deps.settings.maxFileBytes);
    if (body.fileSize > maxBytes) throw mediaErrors.tooLarge(maxBytes);

    const normalized = { ...body, purpose, fileName, mimeType: declared.mimeType };
    const existing = await this.deps.repo.findByClientId(ownerId, body.clientUploadId);
    if (existing) return this.resume(existing, normalized);

    await this.limit(`media:create:burst:${ownerId}`, CREATE_BURST_LIMIT);
    await this.limit(`media:create:${ownerId}`, CREATE_LIMIT);

    const inserted = await this.deps.repo.insert({
      ownerId,
      clientUploadId: body.clientUploadId,
      purpose,
      category: body.category,
      mimeType: declared.mimeType,
      fileName,
      declaredSize: body.fileSize,
      storageKey: newStorageKey(purpose),
      width: body.width ?? null,
      height: body.height ?? null,
      durationMs: body.durationMs ?? null,
      uploadExpiresAt: new Date(Date.now() + this.deps.settings.uploadUrlTtlSeconds * 1000),
    });
    if (!inserted) {
      const winner = await this.deps.repo.findByClientId(ownerId, body.clientUploadId);
      if (!winner) throw mediaErrors.notFound();
      return this.resume(winner, normalized);
    }
    return { upload: toUploadDto(inserted), target: await this.target(inserted), created: true };
  }

  private async resume(
    upload: MediaUpload,
    body: CreateUploadBody & { purpose: MediaPurpose; fileName: string | null; mimeType: string },
  ): Promise<{ upload: UploadDto; target: UploadTarget | null; created: boolean }> {
    const same =
      upload.purpose === body.purpose &&
      upload.category === body.category &&
      upload.mimeType === body.mimeType &&
      upload.declaredSize === body.fileSize &&
      upload.fileName === body.fileName;
    if (!same || upload.status === "failed" || upload.status === "deleted") {
      throw mediaErrors.clientUploadConflict();
    }
    if (upload.status === "ready") {
      return { upload: toUploadDto(upload), target: null, created: false };
    }
    if (upload.uploadExpiresAt.getTime() <= Date.now()) throw mediaErrors.uploadExpired();
    return { upload: toUploadDto(upload), target: await this.target(upload), created: false };
  }

  // Verifies the uploaded object against S3 (it exists, its size and type
  // are exactly what was declared, and its first bytes match the type)
  // before anyone can send it. Idempotent: completing a verified upload
  // returns it unchanged.
  async completeUpload(ownerId: string, uploadId: string): Promise<UploadDto> {
    const storage = this.storage;
    const upload = await this.deps.repo.findOwned(ownerId, uploadId);
    if (!upload || upload.status === "deleted") throw mediaErrors.notFound();
    if (upload.status === "ready") return toUploadDto(upload);
    if (upload.status === "failed") throw mediaErrors.uploadRejected(upload.failureCode ?? "");

    await this.limit(`media:complete:${ownerId}`, COMPLETE_LIMIT);

    const head = await storage.head(upload.storageKey);
    if (!head) {
      if (upload.uploadExpiresAt.getTime() <= Date.now()) throw mediaErrors.uploadExpired();
      throw mediaErrors.uploadIncomplete();
    }

    const failure = await this.verify(upload, head);
    if (failure) {
      const failed = await this.deps.repo.markFailed(upload.id, failure);
      if (failed) await this.removeObject(failed);
      return this.settled(ownerId, uploadId);
    }

    const ready = await this.deps.repo.markReady(upload.id, head.size);
    return ready ? toUploadDto(ready) : this.settled(ownerId, uploadId);
  }

  private async verify(
    upload: MediaUpload,
    head: { size: number; contentType: string | null },
  ): Promise<string | null> {
    if (head.size > maxBytesFor(upload.purpose, this.deps.settings.maxFileBytes)) {
      return "TOO_LARGE";
    }
    if (head.size !== upload.declaredSize) return "SIZE_MISMATCH";
    if (!head.contentType || normalizeMimeType(head.contentType) !== upload.mimeType) {
      return "TYPE_MISMATCH";
    }
    const start = await this.storage.readStart(upload.storageKey, SIGNATURE_BYTES);
    if (!matchesSignature(upload.mimeType, start)) return "CONTENT_MISMATCH";
    return null;
  }

  // The outcome of a completion, including one that raced with ours.
  private async settled(ownerId: string, uploadId: string): Promise<UploadDto> {
    const current = await this.deps.repo.findOwned(ownerId, uploadId);
    if (!current || current.status === "deleted") throw mediaErrors.notFound();
    if (current.status === "failed") throw mediaErrors.uploadRejected(current.failureCode ?? "");
    if (current.status === "pending") throw mediaErrors.uploadIncomplete();
    return toUploadDto(current);
  }

  async getUpload(ownerId: string, uploadId: string): Promise<UploadDto> {
    const upload = await this.deps.repo.findOwned(ownerId, uploadId);
    if (!upload || upload.status === "deleted") throw mediaErrors.notFound();
    return toUploadDto(upload);
  }

  // Cancels an upload no message has used and removes its object.
  async discardUpload(ownerId: string, uploadId: string): Promise<void> {
    this.assertAvailable();
    const outcome = await this.deps.repo.discard(ownerId, uploadId);
    if (outcome === "missing") throw mediaErrors.notFound();
    if (outcome === "in-use") throw mediaErrors.uploadInUse();
    const upload = await this.deps.repo.findById(uploadId);
    if (upload) await this.removeObject(upload);
  }

  // A short-lived download URL for an attachment, authorized through its
  // message: the caller must currently be a member of the chat, the
  // message must be inside their visible history, and not deleted. Every
  // refusal looks the same.
  async attachmentUrl(
    userId: string,
    attachmentId: string,
    variant: "original" | "thumbnail",
  ): Promise<DownloadUrl> {
    const storage = this.storage;
    await this.limit(`media:url:${userId}`, URL_LIMIT);

    const access = await this.deps.repo.attachmentAccess(attachmentId, userId);
    if (!access || access.messageDeleted) throw mediaErrors.notFound();
    // A current member may open what they can see, plus messages they
    // starred and kept through Clear Chat (a star proves they had access).
    const membership = await this.deps.chats.findMembership(userId, access.chatId);
    if (!membership || (access.sequence <= membership.historyFrom && !access.starred)) {
      throw mediaErrors.notFound();
    }

    const { attachment } = access;
    if (variant === "thumbnail") {
      if (!attachment.thumbnailStorageKey) throw mediaErrors.notFound();
      return this.download(storage, {
        key: attachment.thumbnailStorageKey,
        contentType: access.thumbnailMimeType ?? "image/jpeg",
        fileName: null,
      });
    }
    return this.download(storage, {
      key: attachment.storageKey,
      contentType: attachment.mimeType,
      fileName: attachment.fileName,
    });
  }

  // The uploader's own access to a verified upload (e.g. what they sent to
  // a broadcast list), independent of any chat.
  async uploadUrl(ownerId: string, uploadId: string): Promise<DownloadUrl> {
    const storage = this.storage;
    await this.limit(`media:url:${ownerId}`, URL_LIMIT);
    const upload = await this.deps.repo.findOwned(ownerId, uploadId);
    if (!upload || upload.status !== "ready") throw mediaErrors.notFound();
    return this.download(storage, {
      key: upload.storageKey,
      contentType: upload.mimeType,
      fileName: upload.fileName,
    });
  }

  private async download(
    storage: ObjectStorage,
    input: { key: string; contentType: string; fileName: string | null },
  ): Promise<DownloadUrl> {
    const ttl = this.deps.settings.downloadUrlTtlSeconds;
    const url = await storage.presignDownload({ ...input, expiresInSeconds: ttl });
    return { url, expiresAt: new Date(Date.now() + ttl * 1000).toISOString() };
  }
}
