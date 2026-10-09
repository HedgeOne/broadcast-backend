import type { FastifyPluginAsync } from "fastify";

import { db } from "../../db/client.js";
import { redisRateLimiter, type RateLimiter } from "../../lib/rate-limiter.js";
import { MessagesRepository } from "../messages/messages.repository.js";
import { messagesRoutes } from "../messages/messages.routes.js";
import { MessagesService } from "../messages/messages.service.js";
import { ChatsRepository } from "./chats.repository.js";
import { chatsRoutes } from "./chats.routes.js";
import { ChatsService } from "./chats.service.js";

export interface ChatsModuleOptions {
  rateLimiter?: RateLimiter;
}

// Chats and their messages. Requires the auth and realtime modules.
export const chatsModule: FastifyPluginAsync<ChatsModuleOptions> = async (app, options) => {
  const chats = new ChatsRepository(db);

  await app.register(chatsRoutes, {
    prefix: "/chats",
    service: new ChatsService(chats, app.realtime),
  });

  await app.register(messagesRoutes, {
    prefix: "/chats",
    service: new MessagesService({
      messages: new MessagesRepository(db),
      chats,
      realtime: app.realtime,
      rateLimiter: options.rateLimiter ?? redisRateLimiter,
    }),
  });
};
