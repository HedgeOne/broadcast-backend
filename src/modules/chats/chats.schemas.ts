import { z } from "zod";

export const chatParams = z.object({ chatId: z.uuid() });

export const createDirectChatBody = z.object({ userId: z.uuid() });

export const MUTE_DURATIONS = ["8h", "1w", "always"] as const;
export type MuteDuration = (typeof MUTE_DURATIONS)[number];

// The server computes the expiry from the duration; clients can't send one.
// `{ muted: true }` alone means "always".
export const muteBody = z.union([
  z.strictObject({ muted: z.literal(false) }),
  z.strictObject({ muted: z.literal(true), duration: z.enum(MUTE_DURATIONS).default("always") }),
]);

export const receiptsBody = z
  .object({
    deliveredSequence: z.number().int().min(0).optional(),
    readSequence: z.number().int().min(0).optional(),
  })
  .refine((body) => body.deliveredSequence !== undefined || body.readSequence !== undefined, {
    message: "Provide deliveredSequence or readSequence.",
  });
