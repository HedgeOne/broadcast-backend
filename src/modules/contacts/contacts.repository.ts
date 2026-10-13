import { sql } from "drizzle-orm";

import type { Database } from "../../db/client.js";
import { AppError } from "../../lib/errors.js";
import type { PeerProfile } from "../chats/chats.types.js";
import { photoIdFor } from "../photos/photos.access.js";

export interface ContactMatch {
  phoneNumber: string;
  user: PeerProfile;
}

const QUERY_CANCELED = "57014";

function isQueryCanceled(error: unknown): boolean {
  for (let e: unknown = error; e instanceof Error; e = e.cause) {
    if ((e as { code?: unknown }).code === QUERY_CANCELED) return true;
  }
  return false;
}

export class ContactsRepository {
  constructor(
    private readonly db: Database,
    private readonly queryTimeoutMs: number,
  ) {}

  // Matchable = active, verified phone number, not the caller, and no block
  // in either direction. Ineligible accounts are indistinguishable from
  // unregistered numbers. One indexed lookup on users_phone_number_unique,
  // with the whole (bounded) list bound as a single array parameter.
  // Nothing is written: the submitted numbers exist only for this query.
  async matchPhoneNumbers(viewerId: string, phoneNumbers: string[]): Promise<ContactMatch[]> {
    if (phoneNumbers.length === 0) return [];

    try {
      return await this.query(viewerId, phoneNumbers);
    } catch (error) {
      if (!isQueryCanceled(error)) throw error;
      throw new AppError(
        503,
        "CONTACTS_UNAVAILABLE",
        "Contact matching is busy. Try again shortly.",
      );
    }
  }

  private query(viewerId: string, phoneNumbers: string[]): Promise<ContactMatch[]> {
    return this.db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT set_config('statement_timeout', ${String(this.queryTimeoutMs)}, true)`,
      );
      const result = await tx.execute<{
        id: string;
        display_name: string | null;
        photo_id: string | null;
        phone_number: string;
      }>(sql`
        SELECT u.id, u.display_name, ${photoIdFor(sql`u`, viewerId)} AS photo_id, u.phone_number
        FROM users u
        WHERE u.phone_number = ANY(${sql.param(phoneNumbers)}::text[])
          AND u.status = 'active'
          AND u.phone_number_verified_at IS NOT NULL
          AND u.id <> ${viewerId}
          AND NOT EXISTS (
            SELECT 1 FROM blocked_users b
            WHERE (b.user_id = ${viewerId} AND b.blocked_user_id = u.id)
               OR (b.user_id = u.id AND b.blocked_user_id = ${viewerId})
          )
        ORDER BY u.phone_number
      `);
      return result.rows.map((row) => ({
        phoneNumber: row.phone_number,
        user: {
          id: row.id,
          displayName: row.display_name,
          available: true,
          blockedByMe: false,
          photoId: row.photo_id,
        },
      }));
    });
  }
}
