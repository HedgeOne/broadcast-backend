import { AppError } from "../../lib/errors.js";

// Client-facing auth errors. Messages are user-safe; codes are stable for the app.
export const authErrors = {
  rateLimited: (retryAfterSeconds: number) =>
    new AppError(429, "RATE_LIMITED", "Too many attempts. Please try again later.", {
      retryAfterSeconds,
    }),

  // Wrong code; the same challenge can still be used.
  invalidCode: (attemptsRemaining: number) =>
    new AppError(400, "INVALID_CODE", "That code is incorrect.", { attemptsRemaining }),

  // The challenge is gone: expired, already used, or out of attempts. The
  // client has to request a new code.
  codeExpired: () =>
    new AppError(410, "CODE_EXPIRED", "This code is no longer valid. Please request a new one."),

  resendLimitReached: () =>
    new AppError(
      429,
      "RESEND_LIMIT_REACHED",
      "No more codes can be sent for this request. Please start again.",
    ),

  // The OTP provider could not be used (outage, timeout, misconfiguration).
  verificationUnavailable: () =>
    new AppError(
      502,
      "VERIFICATION_UNAVAILABLE",
      "Verification is temporarily unavailable. Please try again.",
    ),

  // Challenge storage (Redis) is down; sign-in fails closed.
  verificationStoreUnavailable: () =>
    new AppError(
      503,
      "VERIFICATION_UNAVAILABLE",
      "Verification is temporarily unavailable. Please try again.",
    ),

  accountUnavailable: () =>
    new AppError(403, "ACCOUNT_UNAVAILABLE", "This account is not available."),

  invalidRefreshToken: () =>
    new AppError(401, "INVALID_REFRESH_TOKEN", "Your session has expired. Please sign in again."),

  unauthenticated: () => new AppError(401, "UNAUTHENTICATED", "Authentication required."),
};
