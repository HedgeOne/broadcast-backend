import { eq, sql, type SQL } from "drizzle-orm";

import type { Database } from "../../db/client.js";
import { users, type User } from "../../db/schema/index.js";
import { claimPhoto } from "../media/media.repository.js";
import type { PhotoRef } from "../media/media.schemas.js";
import { photoVisible } from "./photos.access.js";

// The stored objects behind a photo, once access was granted.
export interface PhotoObjects {
  original: { key: string; mimeType: string };
  thumbnail: { key: string; mimeType: string };
}

interface PhotoRow extends Record<string, unknown> {
  key: string;
  mime_type: string;
  thumb_key: string;
  thumb_mime_type: string;
}

// Both uploads must still be verified; otherwise there is nothing to serve.
const photoJoins = (owner: SQL) => sql`
  JOIN media_uploads p ON p.id = ${owner}.photo_upload_id AND p.status = 'ready'
  JOIN media_uploads t ON t.id = ${owner}.photo_thumbnail_upload_id AND t.status = 'ready'
`;

function toObjects(row: PhotoRow | undefined): PhotoObjects | undefined {
  if (!row) return undefined;
  return {
    original: { key: row.key, mimeType: row.mime_type },
    thumbnail: { key: row.thumb_key, mimeType: row.thumb_mime_type },
  };
}

export class PhotosRepository {
  constructor(private readonly db: Database) {}

  // Sets the caller's profile photo under their user row lock, so
  // concurrent changes apply one after the other. Setting the current
  // photo again (a retried request) changes nothing.
  async setUserPhoto(userId: string, photo: PhotoRef): Promise<User | undefined> {
    return this.db.transaction(async (tx) => {
      const [current] = await tx.select().from(users).where(eq(users.id, userId)).for("update");
      if (!current) return undefined;
      if (
        current.photoUploadId === photo.uploadId &&
        current.photoThumbnailUploadId === photo.thumbnailUploadId
      ) {
        return current;
      }
      await claimPhoto(tx, userId, "profile_photo", photo);
      const [updated] = await tx
        .update(users)
        .set({ photoUploadId: photo.uploadId, photoThumbnailUploadId: photo.thumbnailUploadId })
        .where(eq(users.id, userId))
        .returning();
      return updated;
    });
  }

  // The previous photo's uploads become unreferenced; media cleanup
  // removes them. Idempotent.
  async clearUserPhoto(userId: string): Promise<User | undefined> {
    const [updated] = await this.db
      .update(users)
      .set({ photoUploadId: null, photoThumbnailUploadId: null })
      .where(eq(users.id, userId))
      .returning();
    return updated;
  }

  // The user's photo, if `viewerId` may see it (photoVisible).
  async userPhoto(viewerId: string, userId: string): Promise<PhotoObjects | undefined> {
    const result = await this.db.execute<PhotoRow>(sql`
      SELECT p.storage_key AS key, p.mime_type, t.storage_key AS thumb_key,
        t.mime_type AS thumb_mime_type
      FROM users u
      ${photoJoins(sql`u`)}
      WHERE u.id = ${userId} AND ${photoVisible(sql`u`, viewerId)}
    `);
    return toObjects(result.rows[0]);
  }

  // A live group's photo, for its current members only.
  async groupPhoto(viewerId: string, chatId: string): Promise<PhotoObjects | undefined> {
    const result = await this.db.execute<PhotoRow>(sql`
      SELECT p.storage_key AS key, p.mime_type, t.storage_key AS thumb_key,
        t.mime_type AS thumb_mime_type
      FROM groups g
      JOIN chat_members m ON m.chat_id = g.chat_id AND m.user_id = ${viewerId} AND m.left_at IS NULL
      ${photoJoins(sql`g`)}
      WHERE g.chat_id = ${chatId} AND g.deleted_at IS NULL
    `);
    return toObjects(result.rows[0]);
  }

  // A live list's photo, for its owner only.
  async listPhoto(ownerId: string, listId: string): Promise<PhotoObjects | undefined> {
    const result = await this.db.execute<PhotoRow>(sql`
      SELECT p.storage_key AS key, p.mime_type, t.storage_key AS thumb_key,
        t.mime_type AS thumb_mime_type
      FROM broadcast_lists l
      ${photoJoins(sql`l`)}
      WHERE l.id = ${listId} AND l.owner_id = ${ownerId} AND l.deleted_at IS NULL
    `);
    return toObjects(result.rows[0]);
  }
}
