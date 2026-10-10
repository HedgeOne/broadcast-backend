import { randomBytes } from "node:crypto";

import type { Redis } from "ioredis";

import { hashKeyPart } from "../../../lib/rate-limiter.js";

// One sign-in attempt for one phone number: our side of an OTP request. The
// client only ever holds the opaque id; the phone number and the provider's
// request id stay here. Challenges expire, count attempts and resends, and
// are deleted the moment they are used successfully.
export interface OtpChallenge {
  id: string;
  phoneNumber: string;
  requestId: string;
  attempts: number;
  resends: number;
  resendAvailableAt: number; // epoch ms
  expiresAt: number; // epoch ms
}

export type AttemptClaim =
  { status: "ok"; challenge: OtpChallenge } | { status: "missing" } | { status: "exhausted" };

export type ResendClaim =
  | { status: "ok"; challenge: OtpChallenge }
  | { status: "missing" }
  | { status: "cooldown"; retryAfterSeconds: number }
  | { status: "limit" };

export interface ChallengeStore {
  // Created before the provider is called, so an unusable store never lets
  // an SMS go out. The challenge is inert until a request id is attached.
  create(input: {
    phoneNumber: string;
    ttlSeconds: number;
    resendCooldownSeconds: number;
  }): Promise<OtpChallenge>;
  attachRequest(id: string, requestId: string): Promise<boolean>;
  claimAttempt(id: string, maxAttempts: number): Promise<AttemptClaim>;
  claimResend(id: string, maxResends: number, cooldownSeconds: number): Promise<ResendClaim>;
  // True only for the single caller that removes the challenge.
  consume(id: string): Promise<boolean>;
  remove(id: string): Promise<void>;
  // Returns 0 if the phone may receive a new code now, else seconds to wait.
  claimPhoneCooldown(phoneNumber: string, seconds: number): Promise<number>;
  releasePhoneCooldown(phoneNumber: string): Promise<void>;
}

// Redis could not be reached or answered with an error. Challenges are the
// only record of who may verify what, so callers must fail closed.
export class ChallengeStoreUnavailableError extends Error {
  constructor(cause: unknown) {
    super(`challenge store unavailable: ${cause instanceof Error ? cause.message : "unknown"}`);
    this.name = "ChallengeStoreUnavailableError";
  }
}

export const CHALLENGE_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/;

const ATTACH_SCRIPT = `
if redis.call("EXISTS", KEYS[1]) == 0 then return 0 end
redis.call("HSET", KEYS[1], "req", ARGV[1])
return 1
`;

// Counts the attempt before the provider is asked, so concurrent guesses
// cannot exceed the limit. The challenge is deleted once it is exceeded.
const CLAIM_ATTEMPT_SCRIPT = `
local fields = redis.call("HMGET", KEYS[1], "phone", "req", "resends", "resendAt", "expiresAt")
if not fields[1] or not fields[2] or fields[2] == "" then return {0} end
local attempts = redis.call("HINCRBY", KEYS[1], "attempts", 1)
if attempts > tonumber(ARGV[1]) then
  redis.call("DEL", KEYS[1])
  return {-1}
end
return {1, fields[1], fields[2], attempts, fields[3], fields[4], fields[5]}
`;

const CLAIM_RESEND_SCRIPT = `
local fields = redis.call("HMGET", KEYS[1], "phone", "req", "attempts", "resends", "resendAt", "expiresAt")
if not fields[1] or not fields[2] or fields[2] == "" then return {0} end
local now = tonumber(ARGV[1])
local resendAt = tonumber(fields[5])
if now < resendAt then return {-1, math.ceil((resendAt - now) / 1000)} end
local resends = tonumber(fields[4])
if resends >= tonumber(ARGV[2]) then return {-2} end
local nextAt = now + tonumber(ARGV[3]) * 1000
redis.call("HSET", KEYS[1], "resends", resends + 1, "resendAt", nextAt)
return {1, fields[1], fields[2], fields[3], tostring(resends + 1), tostring(nextAt), fields[6]}
`;

const challengeKey = (id: string) => `otp:challenge:${id}`;
const cooldownKey = (phoneNumber: string) => `otp:phone-cooldown:${hashKeyPart(phoneNumber)}`;

export class RedisChallengeStore implements ChallengeStore {
  constructor(private readonly redis: Redis) {}

  async create(input: {
    phoneNumber: string;
    ttlSeconds: number;
    resendCooldownSeconds: number;
  }): Promise<OtpChallenge> {
    const now = Date.now();
    const challenge: OtpChallenge = {
      id: randomBytes(32).toString("base64url"),
      phoneNumber: input.phoneNumber,
      requestId: "",
      attempts: 0,
      resends: 0,
      resendAvailableAt: now + input.resendCooldownSeconds * 1000,
      expiresAt: now + input.ttlSeconds * 1000,
    };

    await this.run(async () => {
      const key = challengeKey(challenge.id);
      const results = await this.redis
        .multi()
        .hset(key, {
          phone: challenge.phoneNumber,
          req: "",
          attempts: 0,
          resends: 0,
          resendAt: challenge.resendAvailableAt,
          expiresAt: challenge.expiresAt,
        })
        .expire(key, input.ttlSeconds)
        .exec();
      if (!results || results.some(([error]) => error)) {
        throw new Error("challenge write failed");
      }
    });
    return challenge;
  }

  async attachRequest(id: string, requestId: string): Promise<boolean> {
    const result = await this.run(() =>
      this.redis.eval(ATTACH_SCRIPT, 1, challengeKey(id), requestId),
    );
    return result === 1;
  }

  async claimAttempt(id: string, maxAttempts: number): Promise<AttemptClaim> {
    const result = (await this.run(() =>
      this.redis.eval(CLAIM_ATTEMPT_SCRIPT, 1, challengeKey(id), maxAttempts),
    )) as [number, ...string[]];

    if (result[0] === 0) return { status: "missing" };
    if (result[0] === -1) return { status: "exhausted" };
    const [, phoneNumber, requestId, attempts, resends, resendAt, expiresAt] = result;
    return {
      status: "ok",
      challenge: {
        id,
        phoneNumber: String(phoneNumber),
        requestId: String(requestId),
        attempts: Number(attempts),
        resends: Number(resends),
        resendAvailableAt: Number(resendAt),
        expiresAt: Number(expiresAt),
      },
    };
  }

  async claimResend(id: string, maxResends: number, cooldownSeconds: number): Promise<ResendClaim> {
    const result = (await this.run(() =>
      this.redis.eval(
        CLAIM_RESEND_SCRIPT,
        1,
        challengeKey(id),
        Date.now(),
        maxResends,
        cooldownSeconds,
      ),
    )) as [number, ...(string | number)[]];

    if (result[0] === 0) return { status: "missing" };
    if (result[0] === -1) return { status: "cooldown", retryAfterSeconds: Number(result[1]) };
    if (result[0] === -2) return { status: "limit" };
    const [, phoneNumber, requestId, attempts, resends, resendAt, expiresAt] = result;
    return {
      status: "ok",
      challenge: {
        id,
        phoneNumber: String(phoneNumber),
        requestId: String(requestId),
        attempts: Number(attempts),
        resends: Number(resends),
        resendAvailableAt: Number(resendAt),
        expiresAt: Number(expiresAt),
      },
    };
  }

  async consume(id: string): Promise<boolean> {
    return (await this.run(() => this.redis.del(challengeKey(id)))) === 1;
  }

  async remove(id: string): Promise<void> {
    await this.run(() => this.redis.del(challengeKey(id)));
  }

  async claimPhoneCooldown(phoneNumber: string, seconds: number): Promise<number> {
    const key = cooldownKey(phoneNumber);
    const claimed = await this.run(() => this.redis.set(key, "1", "EX", seconds, "NX"));
    if (claimed === "OK") return 0;
    const ttl = await this.run(() => this.redis.ttl(key));
    return ttl > 0 ? ttl : seconds;
  }

  async releasePhoneCooldown(phoneNumber: string): Promise<void> {
    await this.run(() => this.redis.del(cooldownKey(phoneNumber)));
  }

  private async run<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      throw new ChallengeStoreUnavailableError(error);
    }
  }
}
