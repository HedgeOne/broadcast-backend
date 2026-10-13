import { AppError } from "../../lib/errors.js";
import type { RateLimiter } from "../../lib/rate-limiter.js";
import { authErrors } from "../auth/auth.errors.js";
import { toPublicUser, type PublicUser } from "../auth/auth.types.js";
import { mediaErrors } from "../media/media.errors.js";
import type { PhotoRef } from "../media/media.schemas.js";
import type { ObjectStorage } from "../media/media.storage.js";
import type { DownloadUrl } from "../media/media.types.js";
import type { PhotoObjects, PhotosRepository } from "./photos.repository.js";

const SET_LIMIT = { limit: 60, windowSeconds: 3600 };
// Avatars appear in every list; clients cache by photo version, so this
// only bounds abuse.
const URL_LIMIT = { limit: 2000, windowSeconds: 3600 };

export type PhotoVariant = "original" | "thumbnail";

export interface PhotosServiceDeps {
  repo: PhotosRepository;
  // Null when no bucket is configured: photo downloads answer 503.
  storage: ObjectStorage | null;
  rateLimiter: RateLimiter;
  downloadUrlTtlSeconds: number;
}

// "No photo", "hidden by privacy", "blocked", "not a member" and "not your
// list" all look the same, so a refusal reveals nothing.
const photoNotFound = () => new AppError(404, "PHOTO_NOT_FOUND", "There is no photo to show.");

// Profile photos, and short-lived download URLs for profile, group and
// list photos. Access is checked again for every URL issued, so a privacy
// change, block or removal applies to the next request; a URL already
// issued keeps working until it expires (downloadUrlTtlSeconds).
export class PhotosService {
  constructor(private readonly deps: PhotosServiceDeps) {}

  private async limit(key: string, rule: { limit: number; windowSeconds: number }): Promise<void> {
    const result = await this.deps.rateLimiter.consume(key, rule.limit, rule.windowSeconds);
    if (!result.allowed) {
      throw new AppError(429, "RATE_LIMITED", "Too many requests. Try again later.", {
        retryAfterSeconds: result.retryAfterSeconds,
      });
    }
  }

  async setUserPhoto(userId: string, photo: PhotoRef): Promise<PublicUser> {
    await this.limit(`photo:set:${userId}`, SET_LIMIT);
    const user = await this.deps.repo.setUserPhoto(userId, photo);
    if (!user) throw authErrors.unauthenticated();
    return toPublicUser(user);
  }

  async removeUserPhoto(userId: string): Promise<PublicUser> {
    await this.limit(`photo:set:${userId}`, SET_LIMIT);
    const user = await this.deps.repo.clearUserPhoto(userId);
    if (!user) throw authErrors.unauthenticated();
    return toPublicUser(user);
  }

  async userPhotoUrl(viewerId: string, userId: string, variant: PhotoVariant) {
    return this.url(viewerId, variant, () => this.deps.repo.userPhoto(viewerId, userId));
  }

  async groupPhotoUrl(viewerId: string, chatId: string, variant: PhotoVariant) {
    return this.url(viewerId, variant, () => this.deps.repo.groupPhoto(viewerId, chatId));
  }

  async listPhotoUrl(ownerId: string, listId: string, variant: PhotoVariant) {
    return this.url(ownerId, variant, () => this.deps.repo.listPhoto(ownerId, listId));
  }

  private async url(
    viewerId: string,
    variant: PhotoVariant,
    find: () => Promise<PhotoObjects | undefined>,
  ): Promise<DownloadUrl> {
    const storage = this.deps.storage;
    if (!storage) throw mediaErrors.unavailable();
    await this.limit(`photo:url:${viewerId}`, URL_LIMIT);
    const photo = await find();
    if (!photo) throw photoNotFound();
    const object = variant === "thumbnail" ? photo.thumbnail : photo.original;
    const ttl = this.deps.downloadUrlTtlSeconds;
    const url = await storage.presignDownload({
      key: object.key,
      contentType: object.mimeType,
      fileName: null,
      expiresInSeconds: ttl,
    });
    return { url, expiresAt: new Date(Date.now() + ttl * 1000).toISOString() };
  }
}
