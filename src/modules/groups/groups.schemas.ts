import { z } from "zod";

import { photoRef } from "../media/media.schemas.js";

export const GROUP_NAME_MAX = 100;
export const GROUP_DESCRIPTION_MAX = 512;
const MAX_BATCH = 256;

const groupName = z
  .string()
  .trim()
  .min(1, "Enter a group name.")
  .max(GROUP_NAME_MAX, `Group names can be up to ${GROUP_NAME_MAX} characters.`);

// Empty after trimming clears the description.
const groupDescription = z
  .string()
  .trim()
  .max(GROUP_DESCRIPTION_MAX, `Descriptions can be up to ${GROUP_DESCRIPTION_MAX} characters.`)
  .transform((value) => (value.length === 0 ? null : value));

const userIds = z
  .array(z.uuid())
  .min(1)
  .max(MAX_BATCH)
  .transform((ids) => [...new Set(ids)]);

export const groupParams = z.object({ chatId: z.uuid() });
export const memberParams = z.object({ chatId: z.uuid(), userId: z.uuid() });
export const inviteParams = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) });

export const createGroupBody = z.object({
  clientRequestId: z.uuid(),
  name: groupName,
  description: groupDescription.nullable().optional(),
  memberIds: userIds,
  // Optional; claimed in the same transaction, so an unusable photo fails
  // the whole creation rather than leaving a half-made group.
  photo: photoRef.optional(),
});

export const updateGroupBody = z
  .object({
    name: groupName.optional(),
    description: groupDescription.nullable().optional(),
  })
  .refine((body) => body.name !== undefined || body.description !== undefined, {
    message: "Provide a name or description.",
  });

export const updateSettingsBody = z
  .object({
    onlyAdminsCanEditInfo: z.boolean().optional(),
    onlyAdminsCanMessage: z.boolean().optional(),
    onlyAdminsCanAddMembers: z.boolean().optional(),
    approvalRequired: z.boolean().optional(),
    inviteLinksEnabled: z.boolean().optional(),
    historyVisibleToNewMembers: z.boolean().optional(),
  })
  .strict()
  .refine((body) => Object.values(body).some((value) => value !== undefined), {
    message: "Provide at least one setting.",
  });

export const addMembersBody = z.object({ userIds });

export const roleBody = z.object({ role: z.enum(["admin", "member"]) });

export const transferOwnerBody = z.object({ userId: z.uuid() });

export const leaveBody = z.object({ newOwnerId: z.uuid().optional() }).default({});

export const createInviteBody = z
  .object({
    expiresInHours: z
      .number()
      .int()
      .min(1)
      .max(24 * 30)
      .optional(),
    maxUses: z.number().int().min(1).max(1000).optional(),
  })
  .default({});

export type CreateGroupBody = z.infer<typeof createGroupBody>;
export type UpdateGroupBody = z.infer<typeof updateGroupBody>;
export type UpdateSettingsBody = z.infer<typeof updateSettingsBody>;
export type CreateInviteBody = z.infer<typeof createInviteBody>;
