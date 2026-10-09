import { once } from "node:events";

import type { FastifyBaseLogger, LightMyRequestResponse } from "fastify";

import { buildApp, type App } from "../../src/app.js";
import { config } from "../../src/config/index.js";
import { closeDatabase, pool } from "../../src/db/client.js";
import { closeRedis, redis } from "../../src/redis/client.js";

import { FakeIdentityVerifier } from "./fake-identity-verifier.js";

export const IOS_DEVICE = {
  platform: "ios",
  deviceName: "Test iPhone",
  appVersion: "1.0.0",
  osVersion: "19.0",
} as const;

export const ANDROID_DEVICE = {
  platform: "android",
  deviceName: "Test Pixel",
  appVersion: "1.0.0",
  osVersion: "16",
} as const;

export interface TestContext {
  app: App;
  verifier: FakeIdentityVerifier;
}

export async function createTestApp(
  options: { logger?: FastifyBaseLogger } = {},
): Promise<TestContext> {
  if (redis.status !== "ready") {
    await once(redis, "ready");
  }

  const verifier = new FakeIdentityVerifier();
  const app = await buildApp({ auth: { identityVerifier: verifier }, logger: options.logger });
  await app.ready();
  return { app, verifier };
}

// Call once per test file, after every app in the file is closed.
export async function closeConnections(): Promise<void> {
  await Promise.allSettled([closeDatabase(), closeRedis()]);
}

// Refuses to run against anything but the dedicated test database / Redis db.
export async function resetState(): Promise<void> {
  const database = new URL(config.database.url).pathname.slice(1);
  const redisDb = new URL(config.redis.url).pathname.slice(1);

  if (!database.endsWith("_test")) {
    throw new Error(`Refusing to truncate non-test database "${database}"`);
  }
  if (redisDb === "" || redisDb === "0") {
    throw new Error("Refusing to flush Redis db 0; set TEST_REDIS_URL");
  }

  await pool.query("TRUNCATE users RESTART IDENTITY CASCADE");
  await redis.flushdb();
}

export function verifyEmail(
  app: App,
  payload: Record<string, unknown>,
  remoteAddress = "127.0.0.1",
): Promise<LightMyRequestResponse> {
  return app.inject({ method: "POST", url: "/auth/email/verify", payload, remoteAddress });
}

export interface LoginResult {
  accessToken: string;
  refreshToken: string;
  user: { id: string; email: string };
  device: { id: string };
  isNewUser: boolean;
}

// Simulates the full client flow: the widget verifies the OTP and yields an
// access token, which the app exchanges for our session.
export async function login(
  ctx: TestContext,
  email: string,
  device: Record<string, unknown> = IOS_DEVICE,
): Promise<LoginResult> {
  const accessToken = ctx.verifier.issue(email);
  const response = await verifyEmail(ctx.app, { accessToken, device });
  if (response.statusCode !== 200) {
    throw new Error(`email verify failed: ${response.body}`);
  }
  return response.json<LoginResult>();
}

export function bearer(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}
