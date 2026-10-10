// Sends and checks one-time codes for mobile numbers. Knows nothing about
// users, sessions or our own challenges; numbers are always E.164.
//
// The provider owns the code: it generates it, delivers it and checks it,
// keyed by phone number. Callers bind numbers to their own challenges.
export interface MobileOtpProvider {
  readonly name: string;
  // Sends a fresh code. Returns the provider's reference for the send,
  // kept for support/tracing only.
  sendOtp(phoneNumber: string): Promise<{ requestId: string }>;
  // Re-delivers the pending code for the number by SMS. The code itself
  // does not change.
  resendOtp(phoneNumber: string): Promise<void>;
  // Resolves only when the provider positively confirmed `code` for the
  // number; every other outcome rejects with an OtpProviderError.
  verifyOtp(phoneNumber: string, code: string): Promise<void>;
}

export type OtpProviderErrorKind =
  // The code is wrong; the pending code is still usable.
  | "invalid_code"
  // The provider has no pending code for the number (expired, never sent
  // or already verified).
  | "expired"
  // The provider will not accept more attempts or resends for this code.
  | "exhausted"
  // The provider is rate limiting us (per IP, per number or account-wide).
  | "throttled"
  // No usable answer: network error, timeout, 5xx or malformed/unknown
  // response.
  | "unavailable"
  // Our credentials or provider-side configuration are wrong.
  | "misconfigured";

// `reason` is for server logs only. It never contains codes, tokens, keys or
// phone numbers.
export class OtpProviderError extends Error {
  constructor(
    readonly provider: string,
    readonly kind: OtpProviderErrorKind,
    readonly reason: string,
  ) {
    super(`${provider} ${kind}: ${reason}`);
    this.name = "OtpProviderError";
  }
}
