import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { pool } from "../src/db/client.js";
import {
  ChallengeStoreUnavailableError,
  type ChallengeStore,
} from "../src/modules/auth/otp/index.js";
import { redis } from "../src/redis/client.js";
import {
  IOS_DEVICE,
  clearPhoneCooldown,
  closeConnections,
  createTestApp,
  login,
  resendPhone,
  resetState,
  startChallenge,
  startPhone,
  testPhone,
  uniqueIp,
  verifyPhone,
  type ChallengeResult,
  type LoginResult,
  type TestContext,
} from "./helpers/auth.js";
import { FakeMobileOtpProvider } from "./helpers/fake-otp-provider.js";

afterAll(closeConnections);

async function usersWithPhone(phoneNumber: string) {
  const { rows } = await pool.query<{
    id: string;
    phone_number_verified_at: Date | null;
  }>("SELECT id, phone_number_verified_at FROM users WHERE phone_number = $1", [phoneNumber]);
  return rows;
}

async function count(table: "users" | "sessions"): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(`SELECT count(*) AS n FROM ${table}`);
  return Number(rows[0]?.n);
}

function wrongCodeFor(code: string): string {
  return code === "123456" ? "654321" : "123456";
}

// Lets a resend through without waiting out the cooldown.
async function skipResendCooldown(challengeId: string): Promise<void> {
  await redis.hset(`otp:challenge:${challengeId}`, "resendAt", 0);
}

describe("phone sign-in", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  beforeEach(async () => {
    await resetState();
    ctx.otp.reset();
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  // Holds provider verify answers until `count` calls are in flight and
  // treats each as accepted, so concurrent requests all get past the
  // provider before any reaches our own one-time claim.
  async function withHeldProviderVerifies<T>(count: number, run: () => Promise<T>): Promise<T> {
    const provider = ctx.otp;
    const verify = provider.verifyOtp.bind(provider);
    let inFlight = 0;
    provider.verifyOtp = async (phoneNumber, code) => {
      inFlight += 1;
      const result = verify(phoneNumber, code).catch(() => undefined);
      while (inFlight < count) await new Promise((resolve) => setTimeout(resolve, 5));
      return result;
    };
    try {
      return await run();
    } finally {
      provider.verifyOtp = verify;
    }
  }

  describe("POST /auth/phone/start", () => {
    it("sends one code and returns an opaque challenge", async () => {
      const phoneNumber = testPhone();
      const response = await startPhone(ctx.app, { phoneNumber });

      expect(response.statusCode).toBe(200);
      const body = response.json<ChallengeResult>();
      expect(Object.keys(body).sort()).toEqual([
        "challengeId",
        "codeLength",
        "expiresInSeconds",
        "resendAvailableInSeconds",
        "resendsRemaining",
      ]);
      expect(body).toMatchObject({
        codeLength: 6,
        expiresInSeconds: 900,
        resendAvailableInSeconds: 30,
        resendsRemaining: 2,
      });
      expect(body.challengeId).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(response.body).not.toContain(phoneNumber.slice(3));
      expect(ctx.otp.sendCount(phoneNumber)).toBe(1);
      expect(await count("users")).toBe(0);
    });

    it("answers the same way for registered and unregistered numbers", async () => {
      const existing = await login(ctx);
      await clearPhoneCooldown(existing.user.phoneNumber);

      const known = await startPhone(ctx.app, { phoneNumber: existing.user.phoneNumber });
      const unknown = await startPhone(ctx.app, { phoneNumber: testPhone() });

      expect(known.statusCode).toBe(200);
      expect(unknown.statusCode).toBe(200);
      const strip = (body: ChallengeResult) => ({ ...body, challengeId: "x" });
      expect(strip(known.json<ChallengeResult>())).toEqual(strip(unknown.json<ChallengeResult>()));
    });

    it.each([
      ["Indian, formatted", "+91 98765 43210", "+919876543210"],
      ["Indian, dashes", "+91-98765-43210", "+919876543210"],
      ["US", "+1 (415) 555-2671", "+14155552671"],
      ["UK", "+44 7911 123456", "+447911123456"],
      ["UAE", "+971 50 123 4567", "+971501234567"],
    ])("normalises %s numbers to E.164", async (_label, input, e164) => {
      const response = await startPhone(ctx.app, { phoneNumber: input }, uniqueIp());
      expect(response.statusCode).toBe(200);
      expect(ctx.otp.calls.at(-1)).toMatchObject({ operation: "send", phoneNumber: e164 });
    });

    it.each([
      ["missing", undefined],
      ["empty", ""],
      ["without a country code", "9876543210"],
      ["too short", "+91 98765"],
      ["in an unassigned range", "+1 555 555 0101"],
      ["letters", "+91 abcde fghij"],
      ["too long", `+91${"9".repeat(40)}`],
      ["a non-string", 919876543210],
    ])("rejects a number that is %s", async (_label, phoneNumber) => {
      const response = await startPhone(ctx.app, { phoneNumber }, uniqueIp());
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: { code: "VALIDATION_ERROR" } });
      expect(ctx.otp.calls).toHaveLength(0);
    });

    it("makes a number wait before it can be sent another code", async () => {
      const phoneNumber = testPhone();
      expect((await startPhone(ctx.app, { phoneNumber }, uniqueIp())).statusCode).toBe(200);

      const again = await startPhone(ctx.app, { phoneNumber }, uniqueIp());
      expect(again.statusCode).toBe(429);
      const { error } = again.json<{
        error: { code: string; details: { retryAfterSeconds: number } };
      }>();
      expect(error.code).toBe("RATE_LIMITED");
      expect(error.details.retryAfterSeconds).toBeGreaterThan(0);
      expect(error.details.retryAfterSeconds).toBeLessThanOrEqual(30);
      expect(ctx.otp.sendCount(phoneNumber)).toBe(1);
    });

    it("limits sends per phone number", async () => {
      const phoneNumber = testPhone();
      for (let i = 0; i < 5; i += 1) {
        await clearPhoneCooldown(phoneNumber);
        expect((await startPhone(ctx.app, { phoneNumber }, uniqueIp())).statusCode).toBe(200);
      }
      await clearPhoneCooldown(phoneNumber);
      const blocked = await startPhone(ctx.app, { phoneNumber }, uniqueIp());
      expect(blocked.statusCode).toBe(429);
      expect(ctx.otp.sendCount(phoneNumber)).toBe(5);
    });

    it("limits sends per client IP", async () => {
      const ip = "10.99.0.1";
      for (let i = 0; i < 10; i += 1) {
        expect((await startPhone(ctx.app, { phoneNumber: testPhone() }, ip)).statusCode).toBe(200);
      }
      const blocked = await startPhone(ctx.app, { phoneNumber: testPhone() }, ip);
      expect(blocked.statusCode).toBe(429);
      expect(blocked.json()).toMatchObject({ error: { code: "RATE_LIMITED" } });
    });

    it("reports provider timeouts and lets the user retry at once", async () => {
      const phoneNumber = testPhone();
      ctx.otp.failNext("send", "unavailable");

      const failed = await startPhone(ctx.app, { phoneNumber });
      expect(failed.statusCode).toBe(502);
      expect(failed.json()).toMatchObject({ error: { code: "VERIFICATION_UNAVAILABLE" } });

      const retry = await startPhone(ctx.app, { phoneNumber });
      expect(retry.statusCode).toBe(200);
    });

    it("maps provider throttling to RATE_LIMITED", async () => {
      ctx.otp.failNext("send", "throttled");
      const response = await startPhone(ctx.app, { phoneNumber: testPhone() });
      expect(response.statusCode).toBe(429);
      expect(response.json()).toMatchObject({
        error: { code: "RATE_LIMITED", details: { retryAfterSeconds: 60 } },
      });
    });

    it("hides provider misconfiguration behind a generic error", async () => {
      ctx.otp.failNext("send", "misconfigured");
      const response = await startPhone(ctx.app, { phoneNumber: testPhone() });
      expect(response.statusCode).toBe(502);
      expect(response.json()).toEqual({
        error: {
          code: "VERIFICATION_UNAVAILABLE",
          message: "Verification is temporarily unavailable. Please try again.",
        },
      });
    });
  });

  describe("POST /auth/phone/verify", () => {
    it("creates a verified user, device and session for a new number", async () => {
      const phoneNumber = testPhone();
      const { challengeId } = await startChallenge(ctx, phoneNumber);

      const response = await verifyPhone(ctx.app, {
        challengeId,
        code: ctx.otp.latestCode(phoneNumber),
        device: IOS_DEVICE,
      });

      expect(response.statusCode).toBe(200);
      const body = response.json<LoginResult & { refreshTokenExpiresAt: string }>();
      expect(body.isNewUser).toBe(true);
      expect(body.user.phoneNumber).toBe(phoneNumber);
      expect(body.accessToken).toBeTruthy();
      expect(body.refreshToken).toMatch(/^[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/);

      const rows = await usersWithPhone(phoneNumber);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.phone_number_verified_at).toBeInstanceOf(Date);
    });

    it("signs an existing user in without creating a duplicate", async () => {
      const phoneNumber = testPhone();
      const first = await login(ctx, phoneNumber);
      const second = await login(ctx, phoneNumber);

      expect(first.isNewUser).toBe(true);
      expect(second.isNewUser).toBe(false);
      expect(second.user.id).toBe(first.user.id);
      expect(await usersWithPhone(phoneNumber)).toHaveLength(1);
    });

    it("treats differently formatted input as the same account", async () => {
      const first = await login(ctx, "+919876543210");
      await clearPhoneCooldown("+919876543210");

      const start = await startPhone(ctx.app, { phoneNumber: "+91 98765-43210" }, uniqueIp());
      const { challengeId } = start.json<ChallengeResult>();
      const second = await verifyPhone(ctx.app, {
        challengeId,
        code: ctx.otp.latestCode("+919876543210"),
        device: IOS_DEVICE,
      });

      expect(second.json<LoginResult>().user.id).toBe(first.user.id);
      expect(await count("users")).toBe(1);
    });

    it("rejects a wrong code and still accepts the right one", async () => {
      const phoneNumber = testPhone();
      const { challengeId } = await startChallenge(ctx, phoneNumber);
      const code = ctx.otp.latestCode(phoneNumber);

      const wrong = await verifyPhone(ctx.app, {
        challengeId,
        code: wrongCodeFor(code),
        device: IOS_DEVICE,
      });
      expect(wrong.statusCode).toBe(400);
      expect(wrong.json()).toMatchObject({
        error: { code: "INVALID_CODE", details: { attemptsRemaining: 2 } },
      });
      expect(await count("users")).toBe(0);

      const right = await verifyPhone(ctx.app, { challengeId, code, device: IOS_DEVICE });
      expect(right.statusCode).toBe(200);
    });

    it("expires the challenge after too many wrong codes", async () => {
      const phoneNumber = testPhone();
      const { challengeId } = await startChallenge(ctx, phoneNumber);
      const code = ctx.otp.latestCode(phoneNumber);
      const wrong = { challengeId, code: wrongCodeFor(code), device: IOS_DEVICE };

      expect((await verifyPhone(ctx.app, wrong)).json()).toMatchObject({
        error: { details: { attemptsRemaining: 2 } },
      });
      expect((await verifyPhone(ctx.app, wrong)).json()).toMatchObject({
        error: { details: { attemptsRemaining: 1 } },
      });
      const last = await verifyPhone(ctx.app, wrong);
      expect(last.statusCode).toBe(410);
      expect(last.json()).toMatchObject({ error: { code: "CODE_EXPIRED" } });

      const tooLate = await verifyPhone(ctx.app, { challengeId, code, device: IOS_DEVICE });
      expect(tooLate.statusCode).toBe(410);
      expect(await count("users")).toBe(0);
    });

    it("rejects an expired challenge", async () => {
      const phoneNumber = testPhone();
      const { challengeId } = await startChallenge(ctx, phoneNumber);
      await redis.del(`otp:challenge:${challengeId}`);

      const response = await verifyPhone(ctx.app, {
        challengeId,
        code: ctx.otp.latestCode(phoneNumber),
        device: IOS_DEVICE,
      });
      expect(response.statusCode).toBe(410);
      expect(response.json()).toMatchObject({ error: { code: "CODE_EXPIRED" } });
    });

    it("stores challenges with a TTL", async () => {
      const { challengeId } = await startChallenge(ctx, testPhone());
      const ttl = await redis.ttl(`otp:challenge:${challengeId}`);
      expect(ttl).toBeGreaterThan(890);
      expect(ttl).toBeLessThanOrEqual(900);
    });

    it("rejects a code the provider says has expired", async () => {
      const phoneNumber = testPhone();
      const { challengeId } = await startChallenge(ctx, phoneNumber);
      ctx.otp.failNext("verify", "expired");

      const response = await verifyPhone(ctx.app, {
        challengeId,
        code: ctx.otp.latestCode(phoneNumber),
        device: IOS_DEVICE,
      });
      expect(response.statusCode).toBe(410);
      expect(await redis.exists(`otp:challenge:${challengeId}`)).toBe(0);
    });

    it("accepts each challenge only once", async () => {
      const phoneNumber = testPhone();
      const { challengeId } = await startChallenge(ctx, phoneNumber);
      const payload = { challengeId, code: ctx.otp.latestCode(phoneNumber), device: IOS_DEVICE };

      expect((await verifyPhone(ctx.app, payload)).statusCode).toBe(200);
      const replay = await verifyPhone(ctx.app, payload);
      expect(replay.statusCode).toBe(410);
      expect(await count("sessions")).toBe(1);
    });

    it("issues one session when the same challenge is verified concurrently", async () => {
      const phoneNumber = testPhone();
      const { challengeId } = await startChallenge(ctx, phoneNumber);
      const payload = { challengeId, code: ctx.otp.latestCode(phoneNumber), device: IOS_DEVICE };

      // The fake provider, like MSG91, spends a code once it is verified;
      // without holding the answers the second call would simply see it
      // spent. Answering both before either is consumed exercises our own
      // one-time claim.
      const results = await withHeldProviderVerifies(2, () =>
        Promise.all([
          verifyPhone(ctx.app, payload, uniqueIp()),
          verifyPhone(ctx.app, payload, uniqueIp()),
        ]),
      );
      expect(results.map((r) => r.statusCode).sort()).toEqual([200, 410]);

      expect(await count("users")).toBe(1);
      expect(await count("sessions")).toBe(1);
    });

    it("creates the user once when two challenges for a new number verify together", async () => {
      const phoneNumber = testPhone();
      const first = await startChallenge(ctx, phoneNumber);
      await clearPhoneCooldown(phoneNumber);
      const second = await startChallenge(ctx, phoneNumber);
      const code = ctx.otp.latestCode(phoneNumber);

      const [a, b] = await withHeldProviderVerifies(2, () =>
        Promise.all([
          verifyPhone(
            ctx.app,
            { challengeId: first.challengeId, code, device: IOS_DEVICE },
            uniqueIp(),
          ),
          verifyPhone(
            ctx.app,
            { challengeId: second.challengeId, code, device: IOS_DEVICE },
            uniqueIp(),
          ),
        ]),
      );

      expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
      const bodies = [a.json<LoginResult>(), b.json<LoginResult>()];
      expect(bodies[0]?.user.id).toBe(bodies[1]?.user.id);
      expect(bodies.map((body) => body.isNewUser).sort()).toEqual([false, true]);
      expect(await usersWithPhone(phoneNumber)).toHaveLength(1);
    });

    it("rejects a code that a newer send has replaced", async () => {
      const phoneNumber = testPhone();
      const first = await startChallenge(ctx, phoneNumber);
      const oldCode = ctx.otp.latestCode(phoneNumber);
      await clearPhoneCooldown(phoneNumber);
      await startChallenge(ctx, phoneNumber);
      const newCode = ctx.otp.latestCode(phoneNumber);
      if (newCode === oldCode) return;

      const response = await verifyPhone(ctx.app, {
        challengeId: first.challengeId,
        code: oldCode,
        device: IOS_DEVICE,
      });
      expect(response.statusCode).toBe(400);
      expect(await count("users")).toBe(0);
    });

    it("verifies against the challenge's number, ignoring one sent by the client", async () => {
      const phoneNumber = testPhone();
      const { challengeId } = await startChallenge(ctx, phoneNumber);

      const response = await verifyPhone(ctx.app, {
        challengeId,
        code: ctx.otp.latestCode(phoneNumber),
        phoneNumber: "+919811111111",
        device: IOS_DEVICE,
      });
      expect(response.json<LoginResult>().user.phoneNumber).toBe(phoneNumber);
      expect(ctx.otp.calls.filter((call) => call.operation === "verify")).toEqual([
        { operation: "verify", phoneNumber },
      ]);
      expect(await usersWithPhone("+919811111111")).toHaveLength(0);
    });

    it("reports provider outages without creating a user", async () => {
      const phoneNumber = testPhone();
      const { challengeId } = await startChallenge(ctx, phoneNumber);
      ctx.otp.failNext("verify", "unavailable");

      const response = await verifyPhone(ctx.app, {
        challengeId,
        code: ctx.otp.latestCode(phoneNumber),
        device: IOS_DEVICE,
      });
      expect(response.statusCode).toBe(502);
      expect(await count("users")).toBe(0);
    });

    it("maps provider attempt exhaustion to CODE_EXPIRED", async () => {
      const phoneNumber = testPhone();
      const { challengeId } = await startChallenge(ctx, phoneNumber);
      ctx.otp.failNext("verify", "exhausted");

      const response = await verifyPhone(ctx.app, {
        challengeId,
        code: ctx.otp.latestCode(phoneNumber),
        device: IOS_DEVICE,
      });
      expect(response.statusCode).toBe(410);
    });

    it("rejects malformed and unknown challenges", async () => {
      const malformed = await verifyPhone(ctx.app, {
        challengeId: "short",
        code: "123456",
        device: IOS_DEVICE,
      });
      expect(malformed.statusCode).toBe(400);

      const unknown = await verifyPhone(ctx.app, {
        challengeId: "A".repeat(43),
        code: "123456",
        device: IOS_DEVICE,
      });
      expect(unknown.statusCode).toBe(410);
    });

    it.each([
      ["a missing code", { device: IOS_DEVICE }],
      ["a non-numeric code", { code: "12ab56", device: IOS_DEVICE }],
      ["a missing device", { code: "123456" }],
      ["an unknown platform", { code: "123456", device: { platform: "web" } }],
    ])("rejects %s", async (_label, payload) => {
      const response = await verifyPhone(ctx.app, { challengeId: "A".repeat(43), ...payload });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: { code: "VALIDATION_ERROR" } });
    });

    it("refuses disabled accounts", async () => {
      const phoneNumber = testPhone();
      await pool.query(
        "INSERT INTO users (phone_number, phone_number_verified_at, status) VALUES ($1, now(), 'disabled')",
        [phoneNumber],
      );
      const { challengeId } = await startChallenge(ctx, phoneNumber);

      const response = await verifyPhone(ctx.app, {
        challengeId,
        code: ctx.otp.latestCode(phoneNumber),
        device: IOS_DEVICE,
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ error: { code: "ACCOUNT_UNAVAILABLE" } });
      expect(await count("sessions")).toBe(0);
    });

    it("reuses the device id issued to this installation", async () => {
      const phoneNumber = testPhone();
      const first = await login(ctx, phoneNumber);
      const second = await login(ctx, phoneNumber, { ...IOS_DEVICE, deviceId: first.device.id });
      expect(second.device.id).toBe(first.device.id);
    });

    it("limits verify attempts per client IP", async () => {
      const ip = "10.98.0.1";
      const payload = { challengeId: "B".repeat(43), code: "123456", device: IOS_DEVICE };
      for (let i = 0; i < 20; i += 1) {
        expect((await verifyPhone(ctx.app, payload, ip)).statusCode).toBe(410);
      }
      expect((await verifyPhone(ctx.app, payload, ip)).statusCode).toBe(429);
    });

    it("limits guesses per number across challenges", async () => {
      const phoneNumber = testPhone();
      const statuses: number[] = [];
      for (let round = 0; round < 3; round += 1) {
        const { challengeId } = await startChallenge(ctx, phoneNumber);
        const wrong = wrongCodeFor(ctx.otp.latestCode(phoneNumber));
        for (let i = 0; i < 3; i += 1) {
          const response = await verifyPhone(
            ctx.app,
            { challengeId, code: wrong, device: IOS_DEVICE },
            uniqueIp(),
          );
          statuses.push(response.statusCode);
        }
      }
      expect(statuses.slice(0, 8)).not.toContain(429);
      expect(statuses[8]).toBe(429);
    });
  });

  describe("POST /auth/phone/resend", () => {
    it("enforces the resend cooldown", async () => {
      const { challengeId } = await startChallenge(ctx, testPhone());
      const response = await resendPhone(ctx.app, { challengeId });
      expect(response.statusCode).toBe(429);
      expect(response.json()).toMatchObject({ error: { code: "RATE_LIMITED" } });
    });

    it("re-delivers the same code for the challenge's number", async () => {
      const phoneNumber = testPhone();
      const { challengeId } = await startChallenge(ctx, phoneNumber);
      const code = ctx.otp.latestCode(phoneNumber);
      await skipResendCooldown(challengeId);

      const response = await resendPhone(ctx.app, { challengeId });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ resendsRemaining: 1, resendAvailableInSeconds: 30 });
      expect(ctx.otp.calls.at(-1)).toEqual({ operation: "resend", phoneNumber });

      const verified = await verifyPhone(ctx.app, { challengeId, code, device: IOS_DEVICE });
      expect(verified.statusCode).toBe(200);
    });

    it("stops after the maximum number of resends", async () => {
      const { challengeId } = await startChallenge(ctx, testPhone());
      for (let i = 0; i < 2; i += 1) {
        await skipResendCooldown(challengeId);
        expect((await resendPhone(ctx.app, { challengeId }, uniqueIp())).statusCode).toBe(200);
      }
      await skipResendCooldown(challengeId);
      const blocked = await resendPhone(ctx.app, { challengeId }, uniqueIp());
      expect(blocked.statusCode).toBe(429);
      expect(blocked.json()).toMatchObject({ error: { code: "RESEND_LIMIT_REACHED" } });
    });

    it("rejects unknown challenges", async () => {
      const response = await resendPhone(ctx.app, { challengeId: "C".repeat(43) });
      expect(response.statusCode).toBe(410);
    });

    it("drops the challenge when the provider has expired the request", async () => {
      const { challengeId } = await startChallenge(ctx, testPhone());
      await skipResendCooldown(challengeId);
      ctx.otp.failNext("resend", "expired");

      const response = await resendPhone(ctx.app, { challengeId });
      expect(response.statusCode).toBe(410);
      expect(await redis.exists(`otp:challenge:${challengeId}`)).toBe(0);
    });

    it("drops the challenge when the provider's retry limit is spent", async () => {
      const { challengeId } = await startChallenge(ctx, testPhone());
      await skipResendCooldown(challengeId);
      ctx.otp.failNext("resend", "exhausted");

      const response = await resendPhone(ctx.app, { challengeId });
      expect(response.statusCode).toBe(410);
      expect(response.json()).toMatchObject({ error: { code: "CODE_EXPIRED" } });
      expect(await redis.exists(`otp:challenge:${challengeId}`)).toBe(0);
    });

    it("maps provider throttling on resend to RATE_LIMITED", async () => {
      const { challengeId } = await startChallenge(ctx, testPhone());
      await skipResendCooldown(challengeId);
      ctx.otp.failNext("resend", "throttled");

      const response = await resendPhone(ctx.app, { challengeId });
      expect(response.statusCode).toBe(429);
      expect(response.json()).toMatchObject({ error: { code: "RATE_LIMITED" } });
    });
  });
});

describe("phone sign-in without Redis", () => {
  const unavailable = (): Promise<never> =>
    Promise.reject(new ChallengeStoreUnavailableError(new Error("connection refused")));
  const brokenStore: ChallengeStore = {
    create: unavailable,
    attachRequest: unavailable,
    claimAttempt: unavailable,
    claimResend: unavailable,
    consume: unavailable,
    remove: unavailable,
    claimPhoneCooldown: unavailable,
    releasePhoneCooldown: unavailable,
  };

  it("fails closed and never sends a code", async () => {
    const otp = new FakeMobileOtpProvider();
    const app = await buildApp({ auth: { otpProvider: otp, challengeStore: brokenStore } });
    await app.ready();
    try {
      const start = await startPhone(app, { phoneNumber: testPhone() }, uniqueIp());
      expect(start.statusCode).toBe(503);
      expect(start.json()).toMatchObject({ error: { code: "VERIFICATION_UNAVAILABLE" } });
      expect(otp.calls).toHaveLength(0);

      const verify = await verifyPhone(
        app,
        { challengeId: "D".repeat(43), code: "123456", device: IOS_DEVICE },
        uniqueIp(),
      );
      expect(verify.statusCode).toBe(503);
    } finally {
      await app.close();
    }
  });
});
