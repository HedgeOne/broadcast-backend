import { createSecretKey } from "node:crypto";

import { jwtVerify } from "jose";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { AuthContext } from "../src/modules/auth/auth.types.js";

const SECRET = "test-open-e2ee-assertion-secret-32chars!!";
const ISSUER = "https://broadcast.test/e2ee";
const AUDIENCE = "open-e2ee-relay-test";
const RELAY = "https://relay.open-e2ee.dev/signal/v1/connection/pk_test_examplekey";

vi.mock("../src/config/index.js", () => ({
  config: {
    e2ee: {
      relayUrl: RELAY,
      assertionSecret: SECRET,
      assertionIssuer: ISSUER,
      assertionAudience: AUDIENCE,
    },
  },
}));

const { E2eeService } = await import("../src/modules/e2ee/e2ee.service.js");

describe("OpenE2EE identity assertions", () => {
  const auth: AuthContext = {
    userId: "11111111-1111-4111-8111-111111111111",
    sessionId: "22222222-2222-4222-8222-222222222222",
    deviceId: "33333333-3333-4333-8333-333333333333",
  };

  it("rejects sandbox assertions on the server path", async () => {
    const service = new E2eeService();
    await expect(
      service.mintAssertion(auth, {
        purpose: "register",
        assurance: "normal",
        environment: "sandbox",
        publishableKey: "pk_test_examplekey",
      }),
    ).rejects.toMatchObject({ code: "SANDBOX_ASSERTION_LOCAL", statusCode: 400 });
  });

  it("rejects a publishable key that does not match the configured relay", async () => {
    const service = new E2eeService();
    await expect(
      service.mintAssertion(auth, {
        purpose: "register",
        assurance: "normal",
        environment: "production",
        publishableKey: "pk_wrong_key",
      }),
    ).rejects.toMatchObject({ code: "E2EE_PUBLISHABLE_KEY_MISMATCH", statusCode: 400 });
  });

  it("mints a JWT bound to the authenticated subject, device, and session", async () => {
    const service = new E2eeService();
    const { assertion } = await service.mintAssertion(auth, {
      purpose: "register",
      assurance: "normal",
      environment: "production",
      publishableKey: "pk_test_examplekey",
    });

    const { payload } = await jwtVerify(assertion, createSecretKey(Buffer.from(SECRET)), {
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    expect(payload.sub).toBe(auth.userId);
    expect(payload.jti).toEqual(expect.any(String));
    expect(payload.deviceId).toBe(auth.deviceId);
    expect(payload.sessionId).toBe(auth.sessionId);
    expect(payload.purpose).toBe("register");
    expect(payload.publishableKey).toBe("pk_test_examplekey");
    const exp = payload.exp ?? 0;
    const iat = payload.iat ?? 0;
    expect(exp - iat).toBe(60);
  });

  it("issues distinct jti values so assertions are not reusable by id", async () => {
    const service = new E2eeService();
    const body = {
      purpose: "refresh" as const,
      assurance: "normal" as const,
      environment: "production" as const,
      publishableKey: "pk_test_examplekey",
    };
    const a = await service.mintAssertion(auth, body);
    const b = await service.mintAssertion(auth, body);
    const pa = await jwtVerify(a.assertion, createSecretKey(Buffer.from(SECRET)), {
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    const pb = await jwtVerify(b.assertion, createSecretKey(Buffer.from(SECRET)), {
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    expect(pa.payload.jti).not.toBe(pb.payload.jti);
  });
});

afterAll(() => {
  vi.restoreAllMocks();
});

beforeAll(() => {
  // Ensure the dynamic import completed.
  expect(E2eeService).toBeTruthy();
});
