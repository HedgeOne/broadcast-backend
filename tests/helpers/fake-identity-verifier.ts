import { randomUUID } from "node:crypto";

import {
  IdentityProviderUnavailableError,
  IdentityTokenRejectedError,
  type IdentityVerifier,
  type VerificationChannel,
  type VerifiedIdentity,
} from "../../src/modules/auth/verification/index.js";

// Stands in for MSG91: `issue()` plays the part of the widget's verifyOTP
// (returning an access token), `verifyAccessToken` the server-side check.
export class FakeIdentityVerifier implements IdentityVerifier {
  readonly name = "fake";

  unavailable = false;
  readonly verifiedTokens: string[] = [];

  private readonly identities = new Map<string, VerifiedIdentity>();

  reset(): void {
    this.unavailable = false;
    this.verifiedTokens.length = 0;
    this.identities.clear();
  }

  issue(identifier: string, channel: VerificationChannel = "email"): string {
    const token = `fake-msg91-token-${randomUUID()}`;
    this.identities.set(token, { channel, identifier });
    return token;
  }

  verifyAccessToken(accessToken: string): Promise<VerifiedIdentity> {
    if (this.unavailable) {
      return Promise.reject(new IdentityProviderUnavailableError(this.name, "simulated outage"));
    }

    this.verifiedTokens.push(accessToken);
    const identity = this.identities.get(accessToken);
    return identity
      ? Promise.resolve(identity)
      : Promise.reject(new IdentityTokenRejectedError(this.name, "unknown token"));
  }
}
