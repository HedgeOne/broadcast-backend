import { createHash } from "node:crypto";

import { redis } from "../redis/client.js";
import { logger } from "./logger.js";

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

export interface RateLimiter {
  // `cost` lets one request spend several units (e.g. numbers looked up).
  consume(
    key: string,
    limit: number,
    windowSeconds: number,
    cost?: number,
  ): Promise<RateLimitResult>;
}

// Atomic fixed window: INCRBY cost, set TTL when the key has none, return
// count and TTL.
const FIXED_WINDOW_SCRIPT = `
local count = redis.call("INCRBY", KEYS[1], ARGV[2])
if redis.call("TTL", KEYS[1]) == -1 then
  redis.call("EXPIRE", KEYS[1], ARGV[1])
end
local ttl = redis.call("TTL", KEYS[1])
return { count, ttl }
`;

const log = logger.child({ component: "rate-limiter" });

export const redisRateLimiter: RateLimiter = {
  async consume(key, limit, windowSeconds, cost = 1) {
    try {
      const [count, ttl] = (await redis.eval(
        FIXED_WINDOW_SCRIPT,
        1,
        `rl:${key}`,
        windowSeconds,
        cost,
      )) as [number, number];

      return {
        allowed: count <= limit,
        retryAfterSeconds: ttl > 0 ? ttl : windowSeconds,
      };
    } catch (error) {
      // Fail open: Redis holds only ephemeral state. Phone sign-in still
      // fails closed during an outage, because OTP challenges live in Redis.
      log.warn(
        { err: error instanceof Error ? error.message : error, key },
        "rate limiter unavailable",
      );
      return { allowed: true, retryAfterSeconds: 0 };
    }
  },
};

// Keeps raw identifiers (phone numbers) out of Redis keys.
export function hashKeyPart(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}
