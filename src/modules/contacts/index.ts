import type { FastifyPluginAsync } from "fastify";

import { config } from "../../config/index.js";
import { db } from "../../db/client.js";
import { redisRateLimiter, type RateLimiter } from "../../lib/rate-limiter.js";
import { ContactsRepository } from "./contacts.repository.js";
import { contactsRoutes, type ContactsSettings } from "./contacts.routes.js";

export interface ContactsModuleOptions {
  rateLimiter?: RateLimiter;
  settings?: Partial<ContactsSettings>;
  queryTimeoutMs?: number;
}

// Must be registered after the auth module, which provides `app.authenticate`.
export const contactsModule: FastifyPluginAsync<ContactsModuleOptions> = async (app, options) => {
  const { queryTimeoutMs, ...defaults } = config.contacts;
  await app.register(contactsRoutes, {
    prefix: "/contacts",
    repository: new ContactsRepository(db, options.queryTimeoutMs ?? queryTimeoutMs),
    rateLimiter: options.rateLimiter ?? redisRateLimiter,
    settings: { ...defaults, ...options.settings },
  });
};
