import { z } from "zod";

import { attachmentRef, photoRef } from "../media/media.schemas.js";
import { checkMessageBody, messageCiphertext, messageType } from "../messages/messages.schemas.js";

export const BROADCAST_LIST_NAME_MAX = 100;
// Bounds the request size; the configured recipient limit is enforced by
// the service.
const MAX_BATCH = 1024;

const listName = z
  .string()
  .trim()
  .min(1, "Enter a list name.")
  .max(BROADCAST_LIST_NAME_MAX, `List names can be up to ${BROADCAST_LIST_NAME_MAX} characters.`);

const recipientIds = z
  .array(z.uuid())
  .min(1)
  .max(MAX_BATCH)
  .transform((ids) => [...new Set(ids)]);

export const listParams = z.object({ listId: z.uuid() });
export const recipientParams = z.object({ listId: z.uuid(), userId: z.uuid() });
export const broadcastParams = z.object({ listId: z.uuid(), broadcastId: z.uuid() });

export const createListBody = z
  .object({
    clientRequestId: z.uuid(),
    name: listName,
    recipientIds,
    // Optional; claimed in the same transaction as the list.
    photo: photoRef.optional(),
  })
  .strict();

export const updateListBody = z
  .object({
    name: listName.optional(),
    muted: z.boolean().optional(),
  })
  .strict()
  .refine((body) => body.name !== undefined || body.muted !== undefined, {
    message: "Provide a name or mute setting.",
  });

export const addRecipientsBody = z.object({ recipientIds }).strict();

// Opaque OpenE2EE pointer for the owner's history. Per-recipient plaintext is
// delivered only through the Signal Protocol Relay, never fan-out from here.
export const sendBroadcastBody = z
  .object({
    clientMessageId: z.uuid(),
    type: messageType,
    ciphertext: messageCiphertext,
    protocol: z.literal("opene2ee-v1"),
    relayMessageId: z.string().trim().min(1).max(256).optional(),
    attachment: attachmentRef.optional(),
  })
  .strict()
  .superRefine(checkMessageBody)
  .superRefine((body, ctx) => {
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

export const historyQuery = z.object({
  before: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

// Newest first; `before` is the last `sequence` of the previous page.
const pageQuery = {
  before: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
};

export const sharedQuery = z.object({ kind: z.enum(["media", "docs"]), ...pageQuery }).strict();

export const starredQuery = z.object(pageQuery).strict();

export const clearListBody = z.object({ keepStarred: z.boolean() }).strict();

export type CreateListBody = z.infer<typeof createListBody>;
export type UpdateListBody = z.infer<typeof updateListBody>;
export type SendBroadcastBody = z.infer<typeof sendBroadcastBody>;
