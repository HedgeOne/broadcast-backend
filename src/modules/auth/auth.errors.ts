import { AppError } from "../../lib/errors.js";

// Client-facing auth errors. Messages are user-safe; codes are stable for the app.
export const authErrors = {
  rateLimited: (retryAfterSeconds: number) =>
    new AppError(429, "RATE_LIMITED", "Too many attempts. Please try again later.", {
      retryAfterSeconds,
    }),

  // The provider rejected the proof (invalid, expired or already used), or it
  // proves a channel this endpoint does not accept.
  verificationFailed: () =>
    new AppError(
      401,
      "VERIFICATION_FAILED",
      "We couldn't confirm your verification. Please request a new code.",
    ),

  verificationUnavailable: () =>
    new AppError(
      502,
      "VERIFICATION_UNAVAILABLE",
      "Verification is temporarily unavailable. Please try again.",
    ),

  accountUnavailable: () =>
    new AppError(403, "ACCOUNT_UNAVAILABLE", "This account is not available."),

  invalidRefreshToken: () =>
    new AppError(401, "INVALID_REFRESH_TOKEN", "Your session has expired. Please sign in again."),

  unauthenticated: () => new AppError(401, "UNAUTHENTICATED", "Authentication required."),
};
