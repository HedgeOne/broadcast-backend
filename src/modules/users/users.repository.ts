import { eq, sql } from "drizzle-orm";

import type { Database } from "../../db/client.js";
import { users, type User } from "../../db/schema/index.js";
import type { PeerProfile } from "../chats/chats.types.js";
import { photoIdFor } from "../photos/photos.access.js";

export interface ProfileUpdate {
  displayName?: string | undefined;
  dateOfBirth?: string | undefined;
}

// The minimum the contact page shows for a group both users are in.
export interface CommonGroupDto {
  chatId: string;
  name: string;
  // The group photo's version, or null.
  photoId: string | null;
  memberCount: number;
}

export class UsersRepository {
  constructor(private readonly db: Database) {}

  // Live groups where both users are current members, by name. Only the
  // viewer's own memberships are the starting point, so nothing about
  // groups the viewer isn't in can be learned.
  async groupsInCommon(viewerId: string, otherId: string): Promise<CommonGroupDto[]> {
    const result = await this.db.execute<{
      chat_id: string;
      name: string;
      photo_id: string | null;
      member_count: number;
    }>(sql`
      SELECT g.chat_id, g.name, g.photo_upload_id AS photo_id,
        (SELECT COUNT(*)::int FROM chat_members c
         WHERE c.chat_id = g.chat_id AND c.left_at IS NULL) AS member_count
      FROM chat_members me
      JOIN chat_members them
        ON them.chat_id = me.chat_id AND them.user_id = ${otherId} AND them.left_at IS NULL
      JOIN groups g ON g.chat_id = me.chat_id AND g.deleted_at IS NULL
      WHERE me.user_id = ${viewerId} AND me.left_at IS NULL
      ORDER BY lower(g.name), g.chat_id
    `);
    return result.rows.map((row) => ({
      chatId: row.chat_id,
      name: row.name,
      photoId: row.photo_id,
      memberCount: row.member_count,
    }));
  }

  async updateProfile(userId: string, update: ProfileUpdate): Promise<User | undefined> {
    const [user] = await this.db
      .update(users)
      .set({
        ...(update.displayName !== undefined && { displayName: update.displayName }),
        ...(update.dateOfBirth !== undefined && { dateOfBirth: update.dateOfBirth }),
      })
      .where(eq(users.id, userId))
      .returning();
    return user;
  }

  // What the viewer may see about another user. The phone number is never
  // returned: the viewer already has the number in their
  // contacts if they discovered the user that way.
  async findProfile(viewerId: string, userId: string): Promise<PeerProfile | undefined> {
    const result = await this.db.execute<{
      id: string;
      display_name: string | null;
      status: User["status"];
      photo_id: string | null;
      blocked_by_me: boolean;
    }>(sql`
      SELECT u.id, u.display_name, u.status, ${photoIdFor(sql`u`, viewerId)} AS photo_id,
        EXISTS (
          SELECT 1 FROM blocked_users b
          WHERE b.user_id = ${viewerId} AND b.blocked_user_id = u.id
        ) AS blocked_by_me
      FROM users u
      WHERE u.id = ${userId}
    `);
    const row = result.rows[0];
    if (!row) return undefined;
    return {
      id: row.id,
      displayName: row.status === "active" ? row.display_name : null,
      available: row.status === "active",
      blockedByMe: row.blocked_by_me,
      photoId: row.photo_id,
    };
  }
}
