import { randomUUID } from "node:crypto";

import { SignJWT } from "jose";

import { config } from "../../config/index.js";
import { AppError } from "../../lib/errors.js";
import type { AuthContext } from "../auth/auth.types.js";

import type { IdentityAssertionBody } from "./e2ee.schemas.js";

const ASSERTION_TTL_SECONDS = 60;

function publishableKeyFromRelayUrl(relayUrl: string | undefined): string | null {
  if (!relayUrl) return null;
  try {
    const path = new URL(relayUrl).pathname;
    const match = /\/(pk_[A-Za-z0-9_-]+)$/.exec(path);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * Mints a short-lived assertion for the OpenE2EE custom-token verifier.
 * Sandbox assertions are minted on-device by the SDK; this path is production only.
 * The OpenE2EE project must be configured with the matching issuer, audience, and HS256 secret.
 *
 * Subject, deviceId, and sessionId come only from the authenticated Broadcast session —
 * never from client-supplied identity fields.
 */
export class E2eeService {
  async mintAssertion(
    auth: AuthContext,
    body: IdentityAssertionBody,
  ): Promise<{ assertion: string }> {
    if (body.environment === "sandbox") {
      throw new AppError(
        400,
        "SANDBOX_ASSERTION_LOCAL",
        "Sandbox identity assertions are minted on the device, not by Broadcast.",
      );
    }

    const secret = config.e2ee.assertionSecret;
    const issuer = config.e2ee.assertionIssuer;
    const audience = config.e2ee.assertionAudience;
    if (!secret || !issuer || !audience) {
      throw new AppError(
        503,
        "E2EE_ASSERTION_UNCONFIGURED",
        "Production OpenE2EE identity assertions are not configured on this server.",
      );
    }

    const expectedKey = publishableKeyFromRelayUrl(config.e2ee.relayUrl);
    if (expectedKey && body.publishableKey !== expectedKey) {
      throw new AppError(
        400,
        "E2EE_PUBLISHABLE_KEY_MISMATCH",
        "The publishable key does not match this server's OpenE2EE relay configuration.",
      );
    }

    const now = Math.floor(Date.now() / 1000);
    const assertion = await new SignJWT({
      purpose: body.purpose,
      assurance: body.assurance,
      publishableKey: body.publishableKey,
      ...(body.migration ? { migration: body.migration } : {}),
      // Bound to the authenticated device/session — not client-claimed IDs.
      deviceId: auth.deviceId,
      sessionId: auth.sessionId,
    })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setIssuer(issuer)
      .setAudience(audience)
      .setSubject(auth.userId)
      .setJti(randomUUID())
      .setIssuedAt(now)
      .setExpirationTime(now + ASSERTION_TTL_SECONDS)
      .sign(new TextEncoder().encode(secret));

    return { assertion };
  }
}
