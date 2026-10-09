import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ageInYears, updateMeBody } from "../src/modules/users/users.schemas.js";
import {
  bearer,
  closeConnections,
  createTestApp,
  login,
  resetState,
  type TestContext,
} from "./helpers/auth.js";

afterAll(closeConnections);

function isoYearsAgo(years: number, dayOffset = 0): string {
  const now = new Date();
  const date = new Date(
    Date.UTC(now.getUTCFullYear() - years, now.getUTCMonth(), now.getUTCDate() + dayOffset),
  );
  return date.toISOString().slice(0, 10);
}

describe("PATCH /users/me", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  beforeEach(resetState);

  afterAll(async () => {
    await ctx.app.close();
  });

  function updateMe(token: string, payload: Record<string, unknown>) {
    return ctx.app.inject({ method: "PATCH", url: "/users/me", headers: bearer(token), payload });
  }

  it("requires authentication", async () => {
    const response = await ctx.app.inject({
      method: "PATCH",
      url: "/users/me",
      payload: { displayName: "Ana" },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: { code: "UNAUTHENTICATED" } });
  });

  it("completes onboarding and persists the profile", async () => {
    const session = await login(ctx, "new@example.com");
    expect(session.isNewUser).toBe(true);

    const dateOfBirth = isoYearsAgo(20);
    const response = await updateMe(session.accessToken, {
      displayName: "  Ana Silva  ",
      dateOfBirth,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      user: {
        id: session.user.id,
        email: "new@example.com",
        displayName: "Ana Silva",
        username: null,
        dateOfBirth,
      },
    });

    const me = await ctx.app.inject({
      method: "GET",
      url: "/auth/me",
      headers: bearer(session.accessToken),
    });
    expect(me.json()).toMatchObject({ user: { displayName: "Ana Silva", dateOfBirth } });

    const again = await login(ctx, "new@example.com");
    expect(again.isNewUser).toBe(false);
    expect(again.user).toMatchObject({ displayName: "Ana Silva", dateOfBirth });
  });

  it("updates only the fields provided", async () => {
    const session = await login(ctx, "partial@example.com");
    const dateOfBirth = isoYearsAgo(30);
    await updateMe(session.accessToken, { displayName: "First", dateOfBirth });

    const response = await updateMe(session.accessToken, { displayName: "Second" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ user: { displayName: "Second", dateOfBirth } });
  });

  it("ignores fields it does not own", async () => {
    const session = await login(ctx, "owner@example.com");
    const response = await updateMe(session.accessToken, {
      displayName: "Ana",
      email: "attacker@example.com",
      id: "00000000-0000-0000-0000-000000000000",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      user: { id: session.user.id, email: "owner@example.com" },
    });
  });

  it.each([
    ["an empty body", {}],
    ["a blank name", { displayName: "   " }],
    ["a name over 50 characters", { displayName: "a".repeat(51) }],
    ["a malformed date", { dateOfBirth: "06/10/2000" }],
    ["an impossible date", { dateOfBirth: "2001-02-29" }],
    ["a future date", { dateOfBirth: isoYearsAgo(-1) }],
    ["an implausibly old date", { dateOfBirth: "1890-01-01" }],
  ])("rejects %s", async (_label, payload) => {
    const session = await login(ctx, "invalid@example.com");
    const response = await updateMe(session.accessToken, payload);
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: "VALIDATION_ERROR" } });
  });

  it("rejects users younger than 16 and accepts exactly 16", async () => {
    const session = await login(ctx, "age@example.com");

    const tooYoung = await updateMe(session.accessToken, { dateOfBirth: isoYearsAgo(16, 1) });
    expect(tooYoung.statusCode).toBe(400);
    expect(tooYoung.json()).toMatchObject({
      error: {
        code: "VALIDATION_ERROR",
        details: {
          issues: [{ path: "dateOfBirth", message: "You must be at least 16 years old." }],
        },
      },
    });

    const sixteen = await updateMe(session.accessToken, { dateOfBirth: isoYearsAgo(16) });
    expect(sixteen.statusCode).toBe(200);
  });
});

describe("age rules", () => {
  it("counts whole years and handles 29 February", () => {
    const birth = { year: 2008, month: 2, day: 29 };
    expect(ageInYears(birth, { year: 2024, month: 2, day: 28 })).toBe(15);
    expect(ageInYears(birth, { year: 2024, month: 2, day: 29 })).toBe(16);
    expect(ageInYears(birth, { year: 2025, month: 2, day: 28 })).toBe(16);
  });

  it("evaluates the minimum age against the injected clock", () => {
    const schema = updateMeBody(() => new Date("2026-10-06T12:00:00Z"));
    expect(schema.safeParse({ dateOfBirth: "2010-10-06" }).success).toBe(true);
    expect(schema.safeParse({ dateOfBirth: "2010-10-07" }).success).toBe(false);
  });
});
