import { z } from "zod";

// 48 KiB of body bytes is far beyond any text message; media bodies will
// reference uploaded attachments rather than inline data.
export const MAX_CIPHERTEXT_BYTES = 48 * 1024;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const MAX_MENTIONS = 50;

export const REACTION_EMOJIS = ["👍", "❤️", "😂", "😮", "😢", "🙏"] as const;

export const sendMessageBody = z.object({
  clientMessageId: z.uuid(),
  // Only text is supported in this batch; other message types need media.
  type: z.literal("text"),
  ciphertext: z
    .string()
    .min(1)
    .max(Math.ceil(MAX_CIPHERTEXT_BYTES / 3) * 4)
    .regex(BASE64, "ciphertext must be base64"),
  replyToMessageId: z.uuid().optional(),
  // Group members referenced as @{userId} in the body.
  mentions: z
    .array(z.uuid())
    .max(MAX_MENTIONS)
    .transform((ids) => [...new Set(ids)])
    .optional(),
});

export const listMessagesQuery = z
  .object({
    after: z.coerce.number().int().min(0).optional(),
    before: z.coerce.number().int().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .refine((query) => query.after === undefined || query.before === undefined, {
    message: "Use either after or before, not both.",
  });

export const messageParams = z.object({ chatId: z.uuid(), messageId: z.uuid() });

export const reactionBody = z.object({ emoji: z.enum(REACTION_EMOJIS) });

export type SendMessageBody = z.infer<typeof sendMessageBody>;
