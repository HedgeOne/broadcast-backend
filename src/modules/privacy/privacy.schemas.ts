import { z } from "zod";

export const blockParams = z.object({ userId: z.uuid() });

export const reportBody = z.object({
  userId: z.uuid(),
  // The conversation the report concerns, if any. Must be the reporter's own.
  chatId: z.uuid().optional(),
  reason: z.enum(["spam", "harassment", "inappropriate", "impersonation", "other"]),
  block: z.boolean().default(false),
});

export type ReportBody = z.infer<typeof reportBody>;
