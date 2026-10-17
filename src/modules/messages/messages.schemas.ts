import { z } from "zod";

import { attachmentRef } from "../media/media.schemas.js";

// 48 KiB of body bytes is far beyond any text message or caption; file
// bytes never travel in the body, only a reference to a verified upload.
export const MAX_CIPHERTEXT_BYTES = 48 * 1024;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const MAX_MENTIONS = 50;

export const REACTION_EMOJIS = ["👍", "❤️", "😂", "😮", "😢", "🙏"] as const;

export const MEDIA_MESSAGE_TYPES = ["image", "video", "audio", "document"] as const;

export const messageType = z.enum(["text", ...MEDIA_MESSAGE_TYPES]);

export const messageCiphertext = z
  .string()
  .max(Math.ceil(MAX_CIPHERTEXT_BYTES / 3) * 4)
  .refine((value) => value === "" || BASE64.test(value), "ciphertext must be base64");

// A text message has a non-empty body. A media message references one
// verified upload of the sender's; its body is the caption and may be
// empty.
export function checkMessageBody(
  body: { type: string; ciphertext: string; attachment?: unknown },
  ctx: z.RefinementCtx,
): void {
  if (body.type === "text") {
    if (body.ciphertext === "") {
      ctx.addIssue({ code: "custom", path: ["ciphertext"], message: "Text messages need a body." });
    }
    if (body.attachment) {
      ctx.addIssue({
        code: "custom",
        path: ["attachment"],
        message: "Text messages can't carry files.",
      });
    }
  } else if (!body.attachment) {
    ctx.addIssue({
      code: "custom",
      path: ["attachment"],
      message: "Media messages need an attachment.",
    });
  }
}

export const sendMessageBody = z
  .object({
    clientMessageId: z.uuid(),
    type: messageType,
    ciphertext: messageCiphertext,
    // Required for new sends. Legacy Base64 UTF-8 plaintext is rejected.
    protocol: z.literal("opene2ee-v1"),
    relayMessageId: z.string().trim().min(1).max(256).optional(),
    attachment: attachmentRef.optional(),
    replyToMessageId: z.uuid().optional(),
    // Group members referenced as @{userId} in the body.
    mentions: z
      .array(z.uuid())
      .max(MAX_MENTIONS)
      .transform((ids) => [...new Set(ids)])
      .optional(),
  })
  .superRefine(checkMessageBody)
  .superRefine((body, ctx) => {
    // Ciphertext must be an opaque protocol pointer, never recoverable UTF-8 plaintext.
    try {
      const binary = Buffer.from(body.ciphertext, "base64").toString("utf8");
      const parsed = JSON.parse(binary) as { v?: number; protocol?: string };
      if (parsed?.v !== 1 || parsed.protocol !== "opene2ee-v1") {
        ctx.addIssue({
          code: "custom",
          path: ["ciphertext"],
          message: "Ciphertext must be an OpenE2EE protocol pointer.",
        });
      }
    } catch {
      ctx.addIssue({
        code: "custom",
        path: ["ciphertext"],
        message: "Ciphertext must be an OpenE2EE protocol pointer.",
      });
    }
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

// Cursor paging, newest first: `before` is the last sequence of the
// previous page.
const pageQuery = {
  before: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
};

export const sharedQuery = z.object({ kind: z.enum(["media", "docs"]), ...pageQuery }).strict();

export const starredQuery = z.object(pageQuery).strict();

// Explicit so the client always states what happens to starred messages.
export const clearChatBody = z.object({ keepStarred: z.boolean() }).strict();

export const reactionBody = z.object({ emoji: z.enum(REACTION_EMOJIS) });

export type SendMessageBody = z.infer<typeof sendMessageBody>;
