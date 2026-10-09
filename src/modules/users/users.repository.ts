import { eq, sql } from "drizzle-orm";

import type { Database } from "../../db/client.js";
import { users, type User } from "../../db/schema/index.js";
import type { PeerProfile } from "../chats/chats.types.js";

export interface ProfileUpdate {
  displayName?: string | undefined;
  dateOfBirth?: string | undefined;
}

export interface DiscoveryMatch {
  phoneHash: string;
  user: PeerProfile;
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

  // Discoverable = active, with a verified phone number, not the caller,
  // and no block in either direction. Only hashes are compared; the
  // caller's address book is never stored.
  async discoverByPhoneHashes(viewerId: string, hashesHex: string[]): Promise<DiscoveryMatch[]> {
    if (hashesHex.length === 0) return [];
    const result = await this.db.execute<{
      id: string;
      display_name: string | null;
      phone_hash: string;
    }>(sql`
      SELECT u.id, u.display_name, encode(u.phone_number_sha256, 'hex') AS phone_hash
      FROM users u
      WHERE u.phone_number_sha256 IN (
          ${sql.join(
            hashesHex.map((hash) => sql`decode(${hash}, 'hex')`),
            sql`, `,
          )}
        )
        AND u.status = 'active'
        AND u.phone_number_verified_at IS NOT NULL
        AND u.id <> ${viewerId}
        AND NOT EXISTS (
          SELECT 1 FROM blocked_users b
          WHERE (b.user_id = ${viewerId} AND b.blocked_user_id = u.id)
             OR (b.user_id = u.id AND b.blocked_user_id = ${viewerId})
        )
    `);
    return result.rows.map((row) => ({
      phoneHash: row.phone_hash,
      user: { id: row.id, displayName: row.display_name, available: true, blockedByMe: false },
    }));
  }

  // What the viewer may see about another user. No identifiers (phone,
  // email) are returned: the viewer already has the number in their
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
