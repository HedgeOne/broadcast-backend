import { createHash } from "node:crypto";

import { redis } from "../redis/client.js";
import { logger } from "./logger.js";

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

export interface RateLimiter {
  consume(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult>;
}

// Atomic fixed window: INCR, set TTL on first hit, return count and TTL.
const FIXED_WINDOW_SCRIPT = `
local count = redis.call("INCR", KEYS[1])
if count == 1 then
  redis.call("EXPIRE", KEYS[1], ARGV[1])
end
local ttl = redis.call("TTL", KEYS[1])
return { count, ttl }
`;

const log = logger.child({ component: "rate-limiter" });

export const redisRateLimiter: RateLimiter = {
  async consume(key, limit, windowSeconds) {
    try {
      const [count, ttl] = (await redis.eval(
        FIXED_WINDOW_SCRIPT,
        1,
        `rl:${key}`,
        windowSeconds,
      )) as [number, number];

      return {
        allowed: count <= limit,
        retryAfterSeconds: ttl > 0 ? ttl : windowSeconds,
      };
    } catch (error) {
      // Fail open: Redis holds only ephemeral state. OTP attempt limits and
      // resend intervals are enforced by MSG91, not by these counters.
      log.warn(
        { err: error instanceof Error ? error.message : error, key },
        "rate limiter unavailable",
      );
      return { allowed: true, retryAfterSeconds: 0 };
    }
  },
};

// Keeps raw identifiers (emails, phone numbers) out of Redis keys.
export function hashKeyPart(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}
