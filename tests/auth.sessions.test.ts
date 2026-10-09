import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  ANDROID_DEVICE,
  bearer,
  closeConnections,
  createTestApp,
  login,
  resetState,
  type TestContext,
} from "./helpers/auth.js";

afterAll(closeConnections);

describe("sessions and tokens", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  beforeEach(resetState);

  afterAll(async () => {
    await ctx.app.close();
  });

  function me(token: string) {
    return ctx.app.inject({ method: "GET", url: "/auth/me", headers: bearer(token) });
  }

  function refresh(refreshToken: string) {
    return ctx.app.inject({ method: "POST", url: "/auth/refresh", payload: { refreshToken } });
  }

  it("rejects /auth/me without a token", async () => {
    const response = await ctx.app.inject({ method: "GET", url: "/auth/me" });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: { code: "UNAUTHENTICATED" } });
  });

  it("rejects /auth/me with a forged token", async () => {
    const response = await me("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.invalid");
    expect(response.statusCode).toBe(401);
  });

  it("returns the identity for a valid access token without sensitive fields", async () => {
    const session = await login(ctx, "me@example.com");
    const response = await me(session.accessToken);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      user: {
        id: session.user.id,
        email: "me@example.com",
        displayName: null,
        username: null,
        dateOfBirth: null,
      },
      device: { id: session.device.id, platform: "ios", name: "Test iPhone" },
    });
    expect(response.body).not.toMatch(/refreshToken|token_?hash|phone_?number|sessionId/i);
  });

  it("issues short-lived access tokens with minimal claims", async () => {
    const session = await login(ctx, "claims@example.com");
    const claims = ctx.app.jwt.decode<Record<string, unknown>>(session.accessToken);

    expect(claims).not.toBeNull();
    expect(Object.keys(claims ?? {}).sort()).toEqual(["did", "exp", "iat", "sid", "sub"]);
    expect(claims?.sub).toBe(session.user.id);
    expect(claims?.did).toBe(session.device.id);
    expect(Number(claims?.exp) - Number(claims?.iat)).toBe(900);
  });

  it("refreshes and rotates the refresh token", async () => {
    const session = await login(ctx, "rotate@example.com");

    const response = await refresh(session.refreshToken);
    expect(response.statusCode).toBe(200);

    const tokens = response.json<{ accessToken: string; refreshToken: string }>();
    expect(tokens.refreshToken).not.toBe(session.refreshToken);
    expect(tokens.refreshToken.split(".")[0]).toBe(session.refreshToken.split(".")[0]);
    expect((await me(tokens.accessToken)).statusCode).toBe(200);

    const next = await refresh(tokens.refreshToken);
    expect(next.statusCode).toBe(200);
  });

  it("treats reuse of a rotated refresh token as theft and revokes the session", async () => {
    const session = await login(ctx, "theft@example.com");

    const rotated = (await refresh(session.refreshToken)).json<{
      accessToken: string;
      refreshToken: string;
    }>();

    const replay = await refresh(session.refreshToken);
    expect(replay.statusCode).toBe(401);
    expect(replay.json()).toMatchObject({ error: { code: "INVALID_REFRESH_TOKEN" } });

    expect((await refresh(rotated.refreshToken)).statusCode).toBe(401);
    expect((await me(rotated.accessToken)).statusCode).toBe(401);
  });

  it("rejects malformed refresh tokens", async () => {
    const response = await refresh("definitely-not-a-token");
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: { code: "INVALID_REFRESH_TOKEN" } });
  });

  it("logout revokes the session for both access and refresh tokens", async () => {
    const session = await login(ctx, "logout@example.com");

    const response = await ctx.app.inject({
      method: "POST",
      url: "/auth/logout",
      headers: bearer(session.accessToken),
    });
    expect(response.statusCode).toBe(204);

    expect((await me(session.accessToken)).statusCode).toBe(401);
    expect((await refresh(session.refreshToken)).statusCode).toBe(401);
  });

  it("logout-all revokes every session of the user", async () => {
    const email = "everywhere@example.com";
    const phone = await login(ctx, email);
    const tablet = await login(ctx, email, ANDROID_DEVICE);

    const response = await ctx.app.inject({
      method: "POST",
      url: "/auth/logout-all",
      headers: bearer(phone.accessToken),
    });
    expect(response.statusCode).toBe(204);

    expect((await refresh(phone.refreshToken)).statusCode).toBe(401);
    expect((await refresh(tablet.refreshToken)).statusCode).toBe(401);
    expect((await me(tablet.accessToken)).statusCode).toBe(401);
  });

  it("keeps other users' sessions intact on logout-all", async () => {
    const alice = await login(ctx, "alice@example.com");
    const bob = await login(ctx, "bob@example.com");

    await ctx.app.inject({
      method: "POST",
      url: "/auth/logout-all",
      headers: bearer(alice.accessToken),
    });

    expect((await me(bob.accessToken)).statusCode).toBe(200);
  });
});
