import type { FastifyPluginCallback } from "fastify";

import { AppError } from "../../lib/errors.js";
import type { RateLimiter } from "../../lib/rate-limiter.js";
import { authErrors } from "../auth/auth.errors.js";
import { toPublicUser } from "../auth/auth.types.js";
import { chatErrors } from "../chats/chats.errors.js";
import type { UsersRepository } from "./users.repository.js";
import { discoverBody, updateMeBody, userParams } from "./users.schemas.js";

// Bounds address-book enumeration: 20 batches of up to 1000 hashes an hour.
const DISCOVERY_LIMIT = { limit: 20, windowSeconds: 3600 };

export interface UsersRoutesOptions {
  repository: UsersRepository;
  rateLimiter: RateLimiter;
}

export const usersRoutes: FastifyPluginCallback<UsersRoutesOptions> = (
  app,
  { repository, rateLimiter },
  done,
) => {
  const bodySchema = updateMeBody();

  app.patch("/me", { preHandler: app.authenticate }, async (request) => {
    const body = bodySchema.parse(request.body);
    const user = await repository.updateProfile(request.auth.userId, body);
    if (!user) {
      throw authErrors.unauthenticated();
    }
    return { user: toPublicUser(user) };
  });

  app.post("/discover", { preHandler: app.authenticate }, async (request) => {
    const body = discoverBody.parse(request.body);
    const limit = await rateLimiter.consume(
      `users:discover:${request.auth.userId}`,
      DISCOVERY_LIMIT.limit,
      DISCOVERY_LIMIT.windowSeconds,
    );
    if (!limit.allowed) {
      throw new AppError(429, "RATE_LIMITED", "Too many contact lookups. Try again later.", {
        retryAfterSeconds: limit.retryAfterSeconds,
      });
    }
    const unique = [...new Set(body.phoneHashes)];
    return { matches: await repository.discoverByPhoneHashes(request.auth.userId, unique) };
  });

  app.get("/:userId", { preHandler: app.authenticate }, async (request) => {
    const { userId } = userParams.parse(request.params);
    const user = await repository.findProfile(request.auth.userId, userId);
    if (!user) throw chatErrors.userNotFound();
    return { user };
  });

  done();
};
