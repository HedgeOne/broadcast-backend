import type { VerificationChannel, VerifiedIdentity } from "./verification/index.js";

// What a user has proven ownership of. Phone is reserved for SMS OTP; the
// users table already has phone_number / phone_number_verified_at.
export type IdentifierType = "email" | "phone";

export interface Identifier {
  type: IdentifierType;
  value: string;
}

const TYPE_BY_CHANNEL: Record<VerificationChannel, IdentifierType> = {
  email: "email",
  sms: "phone",
};

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function identifierFromVerified(identity: VerifiedIdentity): Identifier {
  const type = TYPE_BY_CHANNEL[identity.channel];
  return {
    type,
    value: type === "email" ? normalizeEmail(identity.identifier) : identity.identifier,
  };
}
