import type { FastifyPluginAsync } from "fastify";

import { config } from "../../config/index.js";
import { db } from "../../db/client.js";
import { redisRateLimiter, type RateLimiter } from "../../lib/rate-limiter.js";
import { GroupsRepository } from "../groups/groups.repository.js";
import { groupsRoutes, invitesRoutes } from "../groups/groups.routes.js";
import { GroupsService } from "../groups/groups.service.js";
import { MessagesRepository } from "../messages/messages.repository.js";
import { messagesRoutes } from "../messages/messages.routes.js";
import { MessagesService } from "../messages/messages.service.js";
import { ChatsRepository } from "./chats.repository.js";
import { chatsRoutes } from "./chats.routes.js";
import { ChatsService } from "./chats.service.js";

export interface ChatsModuleOptions {
  rateLimiter?: RateLimiter;
  groupMaxMembers?: number;
}

// Chats (direct and group), their messages, and group management.
// Requires the auth and realtime modules.
export const chatsModule: FastifyPluginAsync<ChatsModuleOptions> = async (app, options) => {
  const chats = new ChatsRepository(db);
  const groups = new GroupsRepository(db);
  const rateLimiter = options.rateLimiter ?? redisRateLimiter;

  await app.register(chatsRoutes, {
    prefix: "/chats",
    service: new ChatsService(chats, app.realtime),
  });

  await app.register(messagesRoutes, {
    prefix: "/chats",
    service: new MessagesService({
      messages: new MessagesRepository(db),
      chats,
      groups,
      realtime: app.realtime,
      rateLimiter,
    }),
  });

  const groupsService = new GroupsService({
    groups,
    chats,
    realtime: app.realtime,
    rateLimiter,
    maxMembers: options.groupMaxMembers ?? config.groups.maxMembers,
  });
  await app.register(groupsRoutes, { prefix: "/groups", service: groupsService });
  await app.register(invitesRoutes, { prefix: "/invites", service: groupsService });
};
