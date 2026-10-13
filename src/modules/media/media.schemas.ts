import { z } from "zod";

import { FILE_NAME_MAX, MEDIA_CATEGORIES, MEDIA_PURPOSES } from "./media.policy.js";

const MAX_DIMENSION = 20_000;
const MAX_DURATION_MS = 24 * 3600 * 1000;

// The file's size is bounded by configuration in the service; this only
// rejects absurd values early.
export const createUploadBody = z
  .object({
    clientUploadId: z.uuid(),
    purpose: z.enum(MEDIA_PURPOSES).default("attachment"),
    category: z.enum(MEDIA_CATEGORIES),
    mimeType: z.string().trim().min(3).max(127),
    fileName: z
      .string()
      .max(FILE_NAME_MAX * 4)
      .nullish(),
    fileSize: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    width: z.number().int().min(1).max(MAX_DIMENSION).nullish(),
    height: z.number().int().min(1).max(MAX_DIMENSION).nullish(),
    durationMs: z.number().int().min(0).max(MAX_DURATION_MS).nullish(),
  })
  .strict();

export const uploadParams = z.object({ uploadId: z.uuid() });
export const attachmentParams = z.object({ attachmentId: z.uuid() });
export const urlQuery = z
  .object({ variant: z.enum(["original", "thumbnail"]).default("original") })
  .strict();

// How a message references media: a verified upload of the sender's, and
// optionally a small image preview (video poster) uploaded the same way.
export const attachmentRef = z
  .object({
    uploadId: z.uuid(),
    thumbnailUploadId: z.uuid().optional(),
  })
  .strict();

// A photo for a profile, group or broadcast list: the cropped image and its
// avatar-sized thumbnail, both verified uploads of the caller's made for
// that purpose.
export const photoRef = z
  .object({
    uploadId: z.uuid(),
    thumbnailUploadId: z.uuid(),
  })
  .strict()
  .refine((ref) => ref.uploadId !== ref.thumbnailUploadId, {
    message: "The photo and its thumbnail must be different uploads.",
    path: ["thumbnailUploadId"],
  });

export const photoUrlQuery = z
  .object({ variant: z.enum(["original", "thumbnail"]).default("thumbnail") })
  .strict();

export type CreateUploadBody = z.input<typeof createUploadBody>;
export type PhotoRef = z.infer<typeof photoRef>;
export type AttachmentRef = z.infer<typeof attachmentRef>;
