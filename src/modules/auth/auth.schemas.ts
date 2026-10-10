import { z } from "zod";

import { normalizePhoneNumber } from "../../lib/phone.js";
import { CHALLENGE_ID_PATTERN } from "./otp/index.js";

export const deviceInfo = z.object({
  platform: z.enum(["ios", "android"]),
  deviceName: z.string().trim().min(1).max(100).optional(),
  appVersion: z.string().trim().min(1).max(50).optional(),
  osVersion: z.string().trim().min(1).max(50).optional(),
  deviceId: z.uuid().optional(),
});

// Normalised to E.164; anything that is not a valid number is rejected.
const phoneNumber = z
  .string()
  .max(32)
  .transform((value, context) => {
    const normalized = normalizePhoneNumber(value);
    if (!normalized) {
      context.addIssue({ code: "custom", message: "Enter a valid phone number." });
      return z.NEVER;
    }
    return normalized;
  });

const challengeId = z.string().regex(CHALLENGE_ID_PATTERN, "Invalid challenge.");

export const phoneStartBody = z.object({ phoneNumber });

export const phoneResendBody = z.object({ challengeId });

export const phoneVerifyBody = z.object({
  challengeId,
  code: z.string().regex(/^\d{4,9}$/, "Enter the code you received."),
  device: deviceInfo,
});

export const refreshBody = z.object({
  refreshToken: z.string().min(1).max(200),
});

export type PhoneStartBody = z.infer<typeof phoneStartBody>;
export type PhoneResendBody = z.infer<typeof phoneResendBody>;
export type PhoneVerifyBody = z.infer<typeof phoneVerifyBody>;
export type RefreshBody = z.infer<typeof refreshBody>;
