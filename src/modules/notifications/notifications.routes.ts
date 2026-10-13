import type { FastifyPluginCallback } from "fastify";

import { AppError } from "../../lib/errors.js";
import type { RateLimiter } from "../../lib/rate-limiter.js";
import { authErrors } from "../auth/auth.errors.js";
import type { NotificationsRepository } from "./notifications.repository.js";
import { registerPushTokenBody } from "./notifications.schemas.js";

// Apps re-register on every launch and token change; this is generous for
// that and stops a client from cycling tokens.
const REGISTER_LIMIT = { limit: 30, windowSeconds: 3600 };

export interface NotificationsRoutesOptions {
  repository: NotificationsRepository;
  rateLimiter: RateLimiter;
}

// The device is always the one of the authenticated session; no route
// accepts a user or device id.
export const notificationsRoutes: FastifyPluginCallback<NotificationsRoutesOptions> = (
  app,
  { repository, rateLimiter },
  done,
) => {
  app.addHook("preHandler", app.authenticate);

  // Whether this device will receive pushes. The token itself is never
  // returned.
  app.get("/current/push-token", async (request) => {
    const { userId, deviceId } = request.auth;
    return { pushToken: await repository.registration(userId, deviceId) };
  });

  app.put("/current/push-token", async (request) => {
    const { userId, deviceId } = request.auth;
    const body = registerPushTokenBody.parse(request.body);
    const limit = await rateLimiter.consume(
      `push:register:${deviceId}`,
      REGISTER_LIMIT.limit,
      REGISTER_LIMIT.windowSeconds,
    );
    if (!limit.allowed) {
      throw new AppError(429, "RATE_LIMITED", "Too many push token updates. Try again later.", {
        retryAfterSeconds: limit.retryAfterSeconds,
      });
    }
    const registration = await repository.registerToken(userId, deviceId, body.token);
    if (!registration) throw authErrors.unauthenticated();
    request.log.info({ deviceId }, "push token registered");
    return { pushToken: registration };
  });

  app.delete("/current/push-token", async (request, reply) => {
    const { userId, deviceId } = request.auth;
    await repository.unregisterToken(userId, deviceId);
    return reply.code(204).send();
  });

  done();
};
