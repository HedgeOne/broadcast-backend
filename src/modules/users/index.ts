import type { FastifyPluginAsync } from "fastify";

import { db } from "../../db/client.js";
import { redisRateLimiter, type RateLimiter } from "../../lib/rate-limiter.js";
import { UsersRepository } from "./users.repository.js";
import { usersRoutes } from "./users.routes.js";

export interface UsersModuleOptions {
  rateLimiter?: RateLimiter;
}

// Must be registered after the auth module, which provides `app.authenticate`.
export const usersModule: FastifyPluginAsync<UsersModuleOptions> = async (app, options) => {
  await app.register(usersRoutes, {
    prefix: "/users",
    repository: new UsersRepository(db),
    rateLimiter: options.rateLimiter ?? redisRateLimiter,
  });
};
