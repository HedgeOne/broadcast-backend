import { z } from "zod";

export const blockParams = z.object({ userId: z.uuid() });

// Only settings the server can enforce are offered. Profile photos: there
// are no server-side contact relationships, so "my contacts" can't be.
export const updateSettingsBody = z
  .object({
    profilePhotoVisibility: z.enum(["everyone", "nobody"]).optional(),
  })
  .strict()
  .refine((body) => body.profilePhotoVisibility !== undefined, {
    message: "Provide a setting to change.",
  });

// A report concerns a user, a conversation (e.g. a group), or a specific
// message in a conversation. A message report targets its sender.
export const reportBody = z
  .object({
    userId: z.uuid().optional(),
    // Must be a conversation the reporter belongs (or belonged) to.
    chatId: z.uuid().optional(),
    messageId: z.uuid().optional(),
    reason: z.enum(["spam", "harassment", "inappropriate", "impersonation", "other"]),
    block: z.boolean().default(false),
  })
  .refine((body) => body.userId !== undefined || body.chatId !== undefined, {
    message: "Report a user, a conversation or a message.",
  })
  .refine((body) => body.messageId === undefined || body.chatId !== undefined, {
    message: "A message report needs its conversation.",
    path: ["chatId"],
  });

export type ReportBody = z.infer<typeof reportBody>;
export type UpdateSettingsBody = z.infer<typeof updateSettingsBody>;
