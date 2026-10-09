import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { buildApp, type App } from "../src/app.js";
import { closeDatabase } from "../src/db/client.js";
import type * as RedisClient from "../src/redis/client.js";
import { closeRedis } from "../src/redis/client.js";

vi.mock("../src/redis/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof RedisClient>()),
  checkRedisConnection: () => Promise.reject(new Error("Redis is not ready: reconnecting")),
}));

describe("GET /health with Redis unavailable", () => {
  let app: App;

  beforeAll(async () => {
    app = await buildApp();
  });

  afterAll(async () => {
    await app.close();
    await Promise.allSettled([closeDatabase(), closeRedis()]);
  });

  it("reports degraded with 503 instead of failing", async () => {
    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      status: "degraded",
      dependencies: { postgres: "ok", redis: "error" },
    });
  });
});
