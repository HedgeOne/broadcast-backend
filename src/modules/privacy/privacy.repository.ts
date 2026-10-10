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

  // The sender of a message the reporter can see (sent after they joined),
  // excluding system events.
  async reportableMessageSender(
    userId: string,
    chatId: string,
    messageId: string,
  ): Promise<string | undefined> {
    const result = await this.db.execute<{ sender_id: string }>(sql`
      SELECT m.sender_id FROM messages m
      JOIN chat_members me ON me.chat_id = m.chat_id AND me.user_id = ${userId}
      WHERE m.id = ${messageId} AND m.chat_id = ${chatId}
        AND m.type <> 'system' AND m.sequence > me.history_from_sequence
    `);
    return result.rows[0]?.sender_id;
  }

  async report(
    reporterId: string,
    report: {
      userId: string | null;
      chatId: string | null;
      messageId: string | null;
      reason: ReportBody["reason"];
      block: boolean;
    },
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.insert(userReports).values({
        reporterId,
        reportedUserId: report.userId,
        chatId: report.chatId,
        messageId: report.messageId,
        reason: report.reason,
      });
      if (report.block && report.userId) {
        await tx
          .insert(blockedUsers)
          .values({ userId: reporterId, blockedUserId: report.userId })
          .onConflictDoNothing();
      }
    });
  }
}
