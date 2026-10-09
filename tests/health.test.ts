import { once } from "node:events";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp, type App } from "../src/app.js";
import { closeDatabase } from "../src/db/client.js";
import { closeRedis, redis } from "../src/redis/client.js";

describe("GET /health", () => {
  let app: App;

  beforeAll(async () => {
    if (redis.status !== "ready") {
      await once(redis, "ready");
    }
    app = await buildApp();
  });

  afterAll(async () => {
    await app.close();
    await Promise.allSettled([closeDatabase(), closeRedis()]);
  });

  it("reports ok when PostgreSQL and Redis are reachable", async () => {
    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: "ok",
      service: "broadcast-backend",
      dependencies: { postgres: "ok", redis: "ok" },
    });
  });
});
