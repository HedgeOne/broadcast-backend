import { z } from "zod";

// Expo push tokens look like ExponentPushToken[xxxxxxxx]; the database
// enforces the same format.
export const EXPO_PUSH_TOKEN = /^(Expo|Exponent)PushToken\[[A-Za-z0-9_:.-]+\]$/;

export const registerPushTokenBody = z.object({
  token: z.string().trim().max(255).regex(EXPO_PUSH_TOKEN, "must be an Expo push token"),
});
