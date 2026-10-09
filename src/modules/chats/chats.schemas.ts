import { z } from "zod";

export const chatParams = z.object({ chatId: z.uuid() });

export const createDirectChatBody = z.object({ userId: z.uuid() });

export const muteBody = z.object({ muted: z.boolean() });

export const receiptsBody = z
  .object({
    deliveredSequence: z.number().int().min(0).optional(),
    readSequence: z.number().int().min(0).optional(),
  })
  .refine((body) => body.deliveredSequence !== undefined || body.readSequence !== undefined, {
    message: "Provide deliveredSequence or readSequence.",
  });
