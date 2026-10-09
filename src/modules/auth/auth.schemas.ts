import { z } from "zod";

export const deviceInfo = z.object({
  platform: z.enum(["ios", "android"]),
  deviceName: z.string().trim().min(1).max(100).optional(),
  appVersion: z.string().trim().min(1).max(50).optional(),
  osVersion: z.string().trim().min(1).max(50).optional(),
  deviceId: z.uuid().optional(),
});

// Deliberately has no email field: the email comes only from MSG91's
// verification of the access token. Unknown keys are stripped.
export const emailVerifyBody = z.object({
  accessToken: z.string().trim().min(1).max(4096),
  device: deviceInfo,
});

export const refreshBody = z.object({
  refreshToken: z.string().min(1).max(200),
});

export type EmailVerifyBody = z.infer<typeof emailVerifyBody>;
export type RefreshBody = z.infer<typeof refreshBody>;
