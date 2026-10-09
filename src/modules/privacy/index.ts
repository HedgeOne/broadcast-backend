import type { FastifyPluginAsync } from "fastify";

import { db } from "../../db/client.js";
import { redisRateLimiter, type RateLimiter } from "../../lib/rate-limiter.js";
import { PrivacyRepository } from "./privacy.repository.js";
import { privacyRoutes } from "./privacy.routes.js";

export interface PrivacyModuleOptions {
  rateLimiter?: RateLimiter;
}

// Blocks and abuse reports. Requires the auth module.
export const privacyModule: FastifyPluginAsync<PrivacyModuleOptions> = async (app, options) => {
  await app.register(privacyRoutes, {
    prefix: "/privacy",
    repository: new PrivacyRepository(db),
    rateLimiter: options.rateLimiter ?? redisRateLimiter,
  });
};
