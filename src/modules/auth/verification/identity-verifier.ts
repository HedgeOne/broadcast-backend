export type VerificationChannel = "email" | "sms";

// An identifier whose ownership the provider has proven (email address, or
// phone number for SMS once that channel exists).
export interface VerifiedIdentity {
  channel: VerificationChannel;
  identifier: string;
}

// Exchanges a provider-issued proof (e.g. the MSG91 widget access token) for
// the identity it proves. Knows nothing about users, sessions or our tokens.
export interface IdentityVerifier {
  readonly name: string;
  verifyAccessToken(accessToken: string): Promise<VerifiedIdentity>;
}

// The provider looked at the token and said no (invalid, expired, reused).
// `reason` is for server logs only, never for clients.
export class IdentityTokenRejectedError extends Error {
  constructor(
    readonly provider: string,
    readonly reason: string,
  ) {
    super(`${provider} rejected the access token: ${reason}`);
    this.name = "IdentityTokenRejectedError";
  }
}

// The provider could not give an answer (network, timeout, 5xx, bad response).
export class IdentityProviderUnavailableError extends Error {
  constructor(
    readonly provider: string,
    readonly reason: string,
  ) {
    super(`${provider} unavailable: ${reason}`);
    this.name = "IdentityProviderUnavailableError";
  }
}
