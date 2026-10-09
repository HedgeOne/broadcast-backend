import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { pool } from "../src/db/client.js";
import {
  ANDROID_DEVICE,
  IOS_DEVICE,
  bearer,
  closeConnections,
  createTestApp,
  login,
  resetState,
  verifyEmail,
  type LoginResult,
  type TestContext,
} from "./helpers/auth.js";

afterAll(closeConnections);

describe("POST /auth/email/verify", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  beforeEach(async () => {
    await resetState();
    ctx.verifier.reset();
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  async function userRow(email: string) {
    const { rows } = await pool.query<{
      id: string;
      email_verified_at: Date | null;
      status: string;
    }>("SELECT id, email_verified_at, status FROM users WHERE email = $1", [email]);
    return rows[0];
  }

  it("creates a verified user, device and session for a new email", async () => {
    const accessToken = ctx.verifier.issue("new@example.com");
    const response = await verifyEmail(ctx.app, { accessToken, device: IOS_DEVICE });

    expect(response.statusCode).toBe(200);
    const body = response.json<LoginResult & { accessTokenExpiresIn: number }>();
    expect(body.isNewUser).toBe(true);
    expect(body.user.email).toBe("new@example.com");
    expect(body.accessTokenExpiresIn).toBe(900);
    expect(body.refreshToken).toMatch(/^[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/);

    const user = await userRow("new@example.com");
    expect(user?.email_verified_at).toBeInstanceOf(Date);

    const sessions = await pool.query<{ refresh_token_hash: string }>(
      "SELECT refresh_token_hash FROM sessions WHERE user_id = $1",
      [body.user.id],
    );
    expect(sessions.rows).toHaveLength(1);
    expect(sessions.rows[0]?.refresh_token_hash).not.toContain(body.refreshToken.split(".")[1]);

    const me = await ctx.app.inject({
      method: "GET",
      url: "/auth/me",
      headers: bearer(body.accessToken),
    });
    expect(me.statusCode).toBe(200);
  });

  it("signs an existing user in without creating a duplicate", async () => {
    const first = await login(ctx, "returning@example.com");
    const second = await login(ctx, "returning@example.com", ANDROID_DEVICE);

    expect(second.isNewUser).toBe(false);
    expect(second.user.id).toBe(first.user.id);
    expect(second.device.id).not.toBe(first.device.id);

    const { rows } = await pool.query("SELECT 1 FROM users WHERE email = $1", [
      "returning@example.com",
    ]);
    expect(rows).toHaveLength(1);
  });

  it("marks an existing unverified email as verified", async () => {
    await pool.query("INSERT INTO users (email) VALUES ($1)", ["legacy@example.com"]);
    expect((await userRow("legacy@example.com"))?.email_verified_at).toBeNull();

    const session = await login(ctx, "legacy@example.com");

    expect(session.isNewUser).toBe(false);
    expect((await userRow("legacy@example.com"))?.email_verified_at).toBeInstanceOf(Date);
  });

  it("uses the MSG91-verified email and ignores any email sent by the client", async () => {
    const accessToken = ctx.verifier.issue("owner@example.com");
    const response = await verifyEmail(ctx.app, {
      accessToken,
      email: "attacker@example.com",
      device: IOS_DEVICE,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<LoginResult>().user.email).toBe("owner@example.com");
    expect(await userRow("attacker@example.com")).toBeUndefined();
  });

  it("normalises the verified email to lowercase", async () => {
    const session = await login(ctx, "Mixed.Case@Example.COM");
    expect(session.user.email).toBe("mixed.case@example.com");
  });

  it("rejects a token MSG91 does not accept and creates nothing", async () => {
    const response = await verifyEmail(ctx.app, {
      accessToken: "forged-token",
      device: IOS_DEVICE,
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: { code: "VERIFICATION_FAILED" } });
    expect((await pool.query("SELECT 1 FROM users")).rows).toHaveLength(0);
  });

  it("reports provider outages as a retryable 502", async () => {
    const accessToken = ctx.verifier.issue("outage@example.com");
    ctx.verifier.unavailable = true;

    const response = await verifyEmail(ctx.app, { accessToken, device: IOS_DEVICE });

    expect(response.statusCode).toBe(502);
    expect(response.json()).toMatchObject({ error: { code: "VERIFICATION_UNAVAILABLE" } });
  });

  it("accepts each MSG91 access token only once", async () => {
    const accessToken = ctx.verifier.issue("once@example.com");

    const first = await verifyEmail(ctx.app, { accessToken, device: IOS_DEVICE });
    const replay = await verifyEmail(ctx.app, { accessToken, device: IOS_DEVICE });

    expect(first.statusCode).toBe(200);
    expect(replay.statusCode).toBe(401);
    expect(replay.json()).toMatchObject({ error: { code: "VERIFICATION_FAILED" } });
  });

  it("rejects a token that proves a phone number on the email endpoint", async () => {
    const accessToken = ctx.verifier.issue("919999999999", "sms");
    const response = await verifyEmail(ctx.app, { accessToken, device: IOS_DEVICE });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: { code: "VERIFICATION_FAILED" } });
  });

  it("validates the request body", async () => {
    const missingToken = await verifyEmail(ctx.app, { device: IOS_DEVICE });
    const missingDevice = await verifyEmail(ctx.app, { accessToken: "abc" });
    const badPlatform = await verifyEmail(ctx.app, {
      accessToken: "abc",
      device: { platform: "windows" },
    });

    for (const response of [missingToken, missingDevice, badPlatform]) {
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: { code: "VALIDATION_ERROR" } });
    }
    expect(ctx.verifier.verifiedTokens).toHaveLength(0);
  });

  it("refuses accounts that are not active", async () => {
    await pool.query("INSERT INTO users (email, status) VALUES ($1, 'disabled')", [
      "disabled@example.com",
    ]);

    const accessToken = ctx.verifier.issue("disabled@example.com");
    const response = await verifyEmail(ctx.app, { accessToken, device: IOS_DEVICE });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: "ACCOUNT_UNAVAILABLE" } });
  });

  it("reuses this installation's device and ends its previous session", async () => {
    const first = await login(ctx, "device@example.com");
    const second = await login(ctx, "device@example.com", {
      ...IOS_DEVICE,
      deviceId: first.device.id,
    });

    expect(second.device.id).toBe(first.device.id);
    const refreshOld = await ctx.app.inject({
      method: "POST",
      url: "/auth/refresh",
      payload: { refreshToken: first.refreshToken },
    });
    expect(refreshOld.statusCode).toBe(401);
  });

  it("does not reuse a device id that belongs to another user", async () => {
    const alice = await login(ctx, "alice@example.com");
    const bob = await login(ctx, "bob@example.com", { ...IOS_DEVICE, deviceId: alice.device.id });

    expect(bob.device.id).not.toBe(alice.device.id);
  });

  it("rate limits verification attempts per client IP", async () => {
    const attempts = [];
    for (let i = 0; i < 21; i += 1) {
      attempts.push(
        await verifyEmail(ctx.app, { accessToken: `bad-${i}`, device: IOS_DEVICE }, "10.0.0.9"),
      );
    }

    expect(attempts.slice(0, 20).every((r) => r.statusCode === 401)).toBe(true);
    const limited = attempts[20];
    expect(limited?.statusCode).toBe(429);
    expect(limited?.json()).toMatchObject({ error: { code: "RATE_LIMITED" } });
  });

  it("never returns provider credentials or tokens it was given", async () => {
    const accessToken = ctx.verifier.issue("clean@example.com");
    const response = await verifyEmail(ctx.app, { accessToken, device: IOS_DEVICE });

    expect(response.body).not.toContain(accessToken);
    expect(response.body).not.toContain("test-msg91-auth-key");
  });
});
