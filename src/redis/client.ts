import { Redis } from "ioredis";

import { config } from "../config/index.js";
import { logger } from "../lib/logger.js";

const log = logger.child({ component: "redis" });

export const redis = new Redis(config.redis.url, {
  maxRetriesPerRequest: 1,
  enableOfflineQueue: false,
  enableReadyCheck: true,

  retryStrategy(times) {
    return Math.min(times * 200, 2_000);
  },
});

redis.on("error", (error: Error) => {
  log.error({ err: error.message }, "connection error");
});

redis.on("connect", () => {
  log.info("connecting");
});

redis.on("ready", () => {
  log.info("ready");
});

redis.on("close", () => {
  log.info("connection closed");
});

export async function checkRedisConnection(): Promise<void> {
  if (redis.status !== "ready") {
    throw new Error(`Redis is not ready: ${redis.status}`);
  }

  await redis.ping();
}

export async function closeRedis(): Promise<void> {
  // quit() needs a writable connection; with the offline queue disabled it
  // rejects while Redis is down, so fall back to a hard disconnect.
  if (redis.status === "ready") {
    await redis.quit();
  } else {
    redis.disconnect();
  }
}
