import { and, eq, sql } from "drizzle-orm";

import type { Database } from "../../db/client.js";
import { blockedUsers, userReports, users } from "../../db/schema/index.js";
import type { ReportBody } from "./privacy.schemas.js";

export class PrivacyRepository {
  constructor(private readonly db: Database) {}

  async userExists(userId: string): Promise<boolean> {
    const [row] = await this.db.select({ id: users.id }).from(users).where(eq(users.id, userId));
    return row !== undefined;
  }

  // Idempotent: blocking twice keeps the original row.
  async block(userId: string, blockedUserId: string): Promise<void> {
    await this.db.insert(blockedUsers).values({ userId, blockedUserId }).onConflictDoNothing();
  }

  async unblock(userId: string, blockedUserId: string): Promise<void> {
    await this.db
      .delete(blockedUsers)
      .where(and(eq(blockedUsers.userId, userId), eq(blockedUsers.blockedUserId, blockedUserId)));
  }

  async isChatMember(userId: string, chatId: string): Promise<boolean> {
    const result = await this.db.execute(sql`
      SELECT 1 FROM chat_members WHERE chat_id = ${chatId} AND user_id = ${userId}
    `);
    return result.rows.length > 0;
  }

  async report(reporterId: string, body: ReportBody): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.insert(userReports).values({
        reporterId,
        reportedUserId: body.userId,
        chatId: body.chatId ?? null,
        reason: body.reason,
      });
      if (body.block) {
        await tx
          .insert(blockedUsers)
          .values({ userId: reporterId, blockedUserId: body.userId })
          .onConflictDoNothing();
      }
    });
  }
}
