import type { FastifyPluginCallback } from "fastify";

import { AppError } from "../../lib/errors.js";
import { hashKeyPart, type RateLimiter } from "../../lib/rate-limiter.js";
import type { ContactsRepository } from "./contacts.repository.js";
import { matchContactsBody } from "./contacts.schemas.js";

export interface ContactsSettings {
  maxBatch: number;
  windowSeconds: number;
  userRequestLimit: number;
  ipRequestLimit: number;
  userNumberLimit: number;
}

export interface ContactsRoutesOptions {
  repository: ContactsRepository;
  rateLimiter: RateLimiter;
  settings: ContactsSettings;
}

// An E.164 number is at most 16 characters; this leaves room for JSON
// framing without accepting arbitrarily large bodies.
const BYTES_PER_NUMBER = 24;

function rateLimited(retryAfterSeconds: number): AppError {
  return new AppError(429, "RATE_LIMITED", "Too many contact lookups. Try again later.", {
    retryAfterSeconds,
  });
}

export const contactsRoutes: FastifyPluginCallback<ContactsRoutesOptions> = (
  app,
  { repository, rateLimiter, settings },
  done,
) => {
  const bodySchema = matchContactsBody(settings.maxBatch);

  // Returns which of the submitted numbers belong to people the caller may
  // message. The request body is never logged or stored.
  app.post(
    "/match",
    {
      preHandler: app.authenticate,
      bodyLimit: 1024 + settings.maxBatch * BYTES_PER_NUMBER,
    },
    async (request) => {
      const { userId } = request.auth;
      for (const [key, limit] of [
        [`contacts:match:ip:${hashKeyPart(request.ip || "unknown")}`, settings.ipRequestLimit],
        [`contacts:match:user:${userId}`, settings.userRequestLimit],
      ] as const) {
        const result = await rateLimiter.consume(key, limit, settings.windowSeconds);
        if (!result.allowed) throw rateLimited(result.retryAfterSeconds);
      }

      const body = bodySchema.parse(request.body);
      const unique = [...new Set(body.phoneNumbers)];

      // Caps how many distinct lookups one account makes per window, so
      // the endpoint cannot be used to sweep number ranges.
      const budget = await rateLimiter.consume(
        `contacts:match:numbers:${userId}`,
        settings.userNumberLimit,
        settings.windowSeconds,
        unique.length,
      );
      if (!budget.allowed) throw rateLimited(budget.retryAfterSeconds);

      return { matches: await repository.matchPhoneNumbers(userId, unique) };
    },
  );

  done();
};
