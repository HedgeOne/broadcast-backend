import { z } from "zod";

import {
  IdentityProviderUnavailableError,
  IdentityTokenRejectedError,
  type IdentityVerifier,
  type VerifiedIdentity,
} from "./identity-verifier.js";

export interface Msg91WidgetConfig {
  apiBaseUrl: string;
  authKey: string;
  timeoutMs: number;
}

interface Msg91Response {
  type?: unknown;
  message?: unknown;
  code?: unknown;
}

// MSG91 account-level rejections: 201 = invalid auth key, 418 = calling IP not
// on the auth key's whitelist (API security). Both are our misconfiguration,
// so they must not be reported as the user's failure.
const AUTH_KEY_REJECTION_CODES: Record<string, string> = {
  "201": "auth key rejected (check MSG91_AUTH_KEY)",
  "418": "server IP not whitelisted for MSG91_AUTH_KEY",
};

const emailSchema = z.email();
// MSG91 mobile identifiers are digits with country code, no "+".
const MOBILE_PATTERN = /^\d{8,15}$/;

// Server-side check of an access token issued by the MSG91 OTP widget after
// the user verified their code. Success returns the verified identifier in
// `message`: {"type":"success","message":"user@example.com"}.
// https://docs.msg91.com/otp-widget/verify-access-token
export class Msg91WidgetVerifier implements IdentityVerifier {
  readonly name = "msg91";

  constructor(
    private readonly config: Msg91WidgetConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async verifyAccessToken(accessToken: string): Promise<VerifiedIdentity> {
    let response: Response;
    try {
      response = await this.fetchImpl(
        new URL("/api/v5/widget/verifyAccessToken", this.config.apiBaseUrl),
        {
          method: "POST",
          headers: { accept: "application/json", "content-type": "application/json" },
          body: JSON.stringify({ authkey: this.config.authKey, "access-token": accessToken }),
          signal: AbortSignal.timeout(this.config.timeoutMs),
        },
      );
    } catch (error) {
      const reason =
        error instanceof Error && error.name === "TimeoutError" ? "timeout" : "network error";
      throw new IdentityProviderUnavailableError(this.name, reason);
    }

    const payload = (await response.json().catch(() => ({}))) as Msg91Response;

    if (response.status >= 500 || response.status === 429) {
      throw new IdentityProviderUnavailableError(
        this.name,
        `HTTP ${response.status}: ${describe(payload)}`,
      );
    }

    const authKeyRejection = AUTH_KEY_REJECTION_CODES[String(payload.code)];
    if (authKeyRejection) {
      throw new IdentityProviderUnavailableError(
        this.name,
        `${authKeyRejection}: ${describe(payload)}`,
      );
    }

    if (!response.ok || payload.type !== "success") {
      throw new IdentityTokenRejectedError(
        this.name,
        `HTTP ${response.status}: ${describe(payload)}`,
      );
    }

    const identifier = typeof payload.message === "string" ? payload.message.trim() : "";

    if (emailSchema.safeParse(identifier).success) {
      return { channel: "email", identifier: identifier.toLowerCase() };
    }
    if (MOBILE_PATTERN.test(identifier)) {
      return { channel: "sms", identifier };
    }

    throw new IdentityProviderUnavailableError(
      this.name,
      "success response without a recognisable identifier",
    );
  }
}

// Provider error text only. Never includes the access token, auth key, or a
// verified identifier (success bodies never reach this function).
function describe(payload: Msg91Response): string {
  const detail = typeof payload.message === "string" ? payload.message : "no details";
  const code =
    typeof payload.code === "string" || typeof payload.code === "number"
      ? ` (code ${payload.code})`
      : "";
  return `${detail.slice(0, 200)}${code}`;
}
