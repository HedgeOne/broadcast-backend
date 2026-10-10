import { once } from "node:events";

import type { FastifyBaseLogger, LightMyRequestResponse } from "fastify";

import { buildApp, type App, type BuildAppOptions } from "../../src/app.js";
import { config } from "../../src/config/index.js";
import { closeDatabase, pool } from "../../src/db/client.js";
import { hashKeyPart } from "../../src/lib/rate-limiter.js";
import { closeRedis, redis } from "../../src/redis/client.js";

import { FakeMobileOtpProvider } from "./fake-otp-provider.js";

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
  otp: FakeMobileOtpProvider;
}

export async function createTestApp(
  options: {
    logger?: FastifyBaseLogger;
    contacts?: BuildAppOptions["contacts"];
    chats?: BuildAppOptions["chats"];
  } = {},
): Promise<TestContext> {
  if (redis.status !== "ready") {
    await once(redis, "ready");
  }

  const otp = new FakeMobileOtpProvider();
  const app = await buildApp({
    auth: { otpProvider: otp },
    logger: options.logger,
    ...(options.contacts ? { contacts: options.contacts } : {}),
    ...(options.chats ? { chats: options.chats } : {}),
  });
  await app.ready();
  return { app, otp };
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

let phoneCounter = 0;

// Valid Indian mobile numbers (E.164), unique within a test run. The +9197
// range is reserved for these; tests that pick numbers use other ranges.
export function testPhone(): string {
  phoneCounter += 1;
  return `+9197${String(phoneCounter).padStart(8, "0")}`;
}

let ipCounter = 0;

// A fresh client address per call keeps per-IP limits out of unrelated tests.
export function uniqueIp(): string {
  ipCounter += 1;
  return `10.${(ipCounter >> 16) & 255}.${(ipCounter >> 8) & 255}.${ipCounter & 255}`;
}

export function startPhone(
  app: App,
  payload: Record<string, unknown>,
  remoteAddress = "127.0.0.1",
): Promise<LightMyRequestResponse> {
  return app.inject({ method: "POST", url: "/auth/phone/start", payload, remoteAddress });
}

export function resendPhone(
  app: App,
  payload: Record<string, unknown>,
  remoteAddress = "127.0.0.1",
): Promise<LightMyRequestResponse> {
  return app.inject({ method: "POST", url: "/auth/phone/resend", payload, remoteAddress });
}

export function verifyPhone(
  app: App,
  payload: Record<string, unknown>,
  remoteAddress = "127.0.0.1",
): Promise<LightMyRequestResponse> {
  return app.inject({ method: "POST", url: "/auth/phone/verify", payload, remoteAddress });
}

export interface ChallengeResult {
  challengeId: string;
  codeLength: number;
  expiresInSeconds: number;
  resendAvailableInSeconds: number;
  resendsRemaining: number;
}

export interface LoginResult {
  accessToken: string;
  refreshToken: string;
  user: { id: string; phoneNumber: string };
  device: { id: string };
  isNewUser: boolean;
}

// Lets a test sign the same number in again without waiting out the
// per-number send cooldown.
export async function clearPhoneCooldown(phoneNumber: string): Promise<void> {
  await redis.del(`otp:phone-cooldown:${hashKeyPart(phoneNumber)}`);
}

export async function startChallenge(
  ctx: TestContext,
  phoneNumber: string,
  remoteAddress = uniqueIp(),
): Promise<ChallengeResult> {
  await clearPhoneCooldown(phoneNumber);
  const response = await startPhone(ctx.app, { phoneNumber }, remoteAddress);
  if (response.statusCode !== 200) {
    throw new Error(`phone start failed: ${response.body}`);
  }
  return response.json<ChallengeResult>();
}

// The full client flow: request a code, read it from the "SMS", verify it.
export async function login(
  ctx: TestContext,
  phoneNumber: string = testPhone(),
  device: Record<string, unknown> = IOS_DEVICE,
): Promise<LoginResult> {
  const remoteAddress = uniqueIp();
  const { challengeId } = await startChallenge(ctx, phoneNumber, remoteAddress);
  const response = await verifyPhone(
    ctx.app,
    { challengeId, code: ctx.otp.latestCode(phoneNumber), device },
    remoteAddress,
  );
  if (response.statusCode !== 200) {
    throw new Error(`phone verify failed: ${response.body}`);
  }
  return response.json<LoginResult>();
}

export function bearer(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}
