import type { FastifyBaseLogger, FastifyPluginCallback } from "fastify";

import { checkDatabaseConnection } from "../db/client.js";
import { checkRedisConnection } from "../redis/client.js";

type DependencyStatus = "ok" | "error";

async function probe(
  name: string,
  check: () => Promise<void>,
  log: FastifyBaseLogger,
): Promise<DependencyStatus> {
  try {
    await check();
    return "ok";
  } catch (error) {
    log.error({ err: error }, `${name} health check failed`);
    return "error";
  }
}

export const healthRoutes: FastifyPluginCallback = (app, _options, done) => {
  app.get("/health", async (request, reply) => {
    const [postgres, redis] = await Promise.all([
      probe("Database", checkDatabaseConnection, request.log),
      probe("Redis", checkRedisConnection, request.log),
    ]);

    const healthy = postgres === "ok" && redis === "ok";

    return reply.code(healthy ? 200 : 503).send({
      status: healthy ? "ok" : "degraded",
      service: "broadcast-backend",
      timestamp: new Date().toISOString(),
      dependencies: { postgres, redis },
    });
  });

  done();
};
