import { eq, sql } from "drizzle-orm";

import type { Database } from "../../db/client.js";
import { users, type User } from "../../db/schema/index.js";
import type { PeerProfile } from "../chats/chats.types.js";

export interface ProfileUpdate {
  displayName?: string | undefined;
  dateOfBirth?: string | undefined;
}

export class UsersRepository {
  constructor(private readonly db: Database) {}

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
      blocked_by_me: boolean;
    }>(sql`
      SELECT u.id, u.display_name, u.status,
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
    };
  }
}
