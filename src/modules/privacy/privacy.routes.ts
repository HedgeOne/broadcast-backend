import type { FastifyPluginCallback } from "fastify";

import { AppError } from "../../lib/errors.js";
import type { RateLimiter } from "../../lib/rate-limiter.js";
import { chatErrors } from "../chats/chats.errors.js";
import type { PrivacyRepository } from "./privacy.repository.js";
import { blockParams, reportBody } from "./privacy.schemas.js";

const REPORT_LIMIT = { limit: 20, windowSeconds: 86_400 };

export interface PrivacyRoutesOptions {
  repository: PrivacyRepository;
  rateLimiter: RateLimiter;
}

const cannotTargetSelf = () =>
  new AppError(400, "INVALID_TARGET", "You can't do this to your own account.");

export const privacyRoutes: FastifyPluginCallback<PrivacyRoutesOptions> = (
  app,
  { repository, rateLimiter },
  done,
) => {
  app.addHook("preHandler", app.authenticate);

  // Blocking is silent: the blocked user is not notified.
  app.put("/blocks/:userId", async (request, reply) => {
    const { userId } = blockParams.parse(request.params);
    if (userId === request.auth.userId) throw cannotTargetSelf();
    if (!(await repository.userExists(userId))) throw chatErrors.userNotFound();
    await repository.block(request.auth.userId, userId);
    return reply.code(204).send();
  });

  app.delete("/blocks/:userId", async (request, reply) => {
    const { userId } = blockParams.parse(request.params);
    await repository.unblock(request.auth.userId, userId);
    return reply.code(204).send();
  });

  app.post("/reports", async (request, reply) => {
    const body = reportBody.parse(request.body);
    const reporterId = request.auth.userId;
    if (body.chatId && !(await repository.isChatMember(reporterId, body.chatId))) {
      throw chatErrors.chatNotFound();
    }
    let userId = body.userId ?? null;
    if (body.chatId && body.messageId) {
      const sender = await repository.reportableMessageSender(
        reporterId,
        body.chatId,
        body.messageId,
      );
      if (!sender) throw chatErrors.messageNotFound();
      if (userId && userId !== sender) throw chatErrors.messageNotFound();
      userId = sender;
    }
    if (userId === reporterId) throw cannotTargetSelf();
    if (userId && !(await repository.userExists(userId))) throw chatErrors.userNotFound();
    if (body.block && !userId) {
      throw new AppError(400, "INVALID_TARGET", "Choose a person to block.");
    }

    const limit = await rateLimiter.consume(
      `privacy:report:${request.auth.userId}`,
      REPORT_LIMIT.limit,
      REPORT_LIMIT.windowSeconds,
    );
    if (!limit.allowed) {
      throw new AppError(429, "RATE_LIMITED", "Too many reports. Try again later.", {
        retryAfterSeconds: limit.retryAfterSeconds,
      });
    }

    await repository.report(reporterId, {
      userId,
      chatId: body.chatId ?? null,
      messageId: body.messageId ?? null,
      reason: body.reason,
      block: body.block,
    });
    return reply.code(201).send({ reported: true, blocked: body.block });
  });

  done();
};
