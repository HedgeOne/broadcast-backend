import { z } from "zod";

import { normalizePhoneNumber } from "../../lib/phone.js";

// Clients send numbers already normalised to E.164 on the device. Anything
// that is not canonical E.164 for a valid number is rejected rather than
// guessed at, so a request can never probe a number it did not spell out.
const e164 = z
  .string()
  .max(16)
  .refine((value) => normalizePhoneNumber(value) === value, "Expected an E.164 phone number.");

export function matchContactsBody(maxBatch: number) {
  return z.object({
    phoneNumbers: z.array(e164).min(1).max(maxBatch),
  });
}

export type MatchContactsBody = z.infer<ReturnType<typeof matchContactsBody>>;
