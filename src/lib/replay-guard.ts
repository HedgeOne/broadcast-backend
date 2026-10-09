import { redis } from "../redis/client.js";
import { logger } from "./logger.js";

export interface ReplayGuard {
  // True the first time `key` is claimed within `ttlSeconds`, false after.
  claim(key: string, ttlSeconds: number): Promise<boolean>;
}

const log = logger.child({ component: "replay-guard" });

export const redisReplayGuard: ReplayGuard = {
  async claim(key, ttlSeconds) {
    try {
      const result = await redis.set(`once:${key}`, "1", "EX", ttlSeconds, "NX");
      return result === "OK";
    } catch (error) {
      // Fail open like the rate limiter: an outage must not block every
      // sign-in. Provider tokens are still verified server-side.
      log.warn({ err: error instanceof Error ? error.message : error }, "replay guard unavailable");
      return true;
    }
  },
};
