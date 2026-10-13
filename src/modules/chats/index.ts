import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";

import { config } from "../../config/index.js";
import { db } from "../../db/client.js";
import { redisRateLimiter, type RateLimiter } from "../../lib/rate-limiter.js";
import { BroadcastDispatcher } from "../broadcasts/broadcasts.dispatcher.js";
import { BroadcastsRepository } from "../broadcasts/broadcasts.repository.js";
import { broadcastsRoutes } from "../broadcasts/broadcasts.routes.js";
import { BroadcastsService } from "../broadcasts/broadcasts.service.js";
import { GroupsRepository } from "../groups/groups.repository.js";
import { MediaRepository } from "../media/media.repository.js";
import { mediaRoutes } from "../media/media.routes.js";
import { MediaService } from "../media/media.service.js";
import { S3ObjectStorage, type ObjectStorage } from "../media/media.storage.js";
import { MediaSweeper } from "../media/media.sweeper.js";
import { groupsRoutes, invitesRoutes } from "../groups/groups.routes.js";
import { GroupsService } from "../groups/groups.service.js";
import { MessagesRepository } from "../messages/messages.repository.js";
import { messagesRoutes } from "../messages/messages.routes.js";
import { MessagesService } from "../messages/messages.service.js";
import { PhotosRepository } from "../photos/photos.repository.js";
import { photosRoutes } from "../photos/photos.routes.js";
import { PhotosService } from "../photos/photos.service.js";
import { ChatsRepository } from "./chats.repository.js";
import { chatsRoutes } from "./chats.routes.js";
import { ChatsService } from "./chats.service.js";

export interface ChatsModuleOptions {
  rateLimiter?: RateLimiter;
  groupMaxMembers?: number;
  broadcastMaxRecipients?: number;
  // False leaves accepted broadcasts to the sweep (tests of recovery).
  broadcastDispatchInline?: boolean;
  // Object storage for media. Defaults to the configured S3 bucket; null
  // (or no bucket configured) disables media.
  storage?: ObjectStorage | null;
}

declare module "fastify" {
  interface FastifyInstance {
    broadcastDispatcher: BroadcastDispatcher;
    mediaSweeper: MediaSweeper;
  }
}

function defaultStorage(): ObjectStorage | null {
  return config.media.bucket ? new S3ObjectStorage(config.media.bucket, config.media.region) : null;
}

// Chats (direct and group), their messages, group management, broadcast
// lists, media and photos. Requires the auth and realtime modules. Not
// encapsulated, so `app.broadcastDispatcher` is reachable (tests drive the
// recovery sweep through it); its routes stay encapsulated.
export const chatsModule = fp<ChatsModuleOptions>(chatsPlugin, {
  name: "chats",
  dependencies: ["auth", "realtime", "notifications"],
});

async function chatsPlugin(app: FastifyInstance, options: ChatsModuleOptions): Promise<void> {
  const chats = new ChatsRepository(db);
  const groups = new GroupsRepository(db);
  const rateLimiter = options.rateLimiter ?? redisRateLimiter;

  // Messages enqueue their push in the same transaction; this only makes
  // the worker pick it up now rather than at the next sweep.
  const notifyCommitted = () => app.pushNotifier.kick();

  const broadcastsRepo = new BroadcastsRepository(db);
  const dispatcher = new BroadcastDispatcher(
    broadcastsRepo,
    app.realtime,
    app.log.child({ component: "broadcasts" }),
    notifyCommitted,
  );
  const broadcasts = new BroadcastsService({
    repo: broadcastsRepo,
    dispatcher,
    realtime: app.realtime,
    rateLimiter,
    maxRecipients: options.broadcastMaxRecipients ?? config.broadcasts.maxRecipients,
    dispatchInline: options.broadcastDispatchInline ?? true,
  });
  const storage = options.storage === undefined ? defaultStorage() : options.storage;
  const mediaRepo = new MediaRepository(db);
  const mediaLog = app.log.child({ component: "media" });
  const sweeper = new MediaSweeper(mediaRepo, storage, mediaLog, config.media.unattachedTtlSeconds);

  app.decorate("broadcastDispatcher", dispatcher);
  app.decorate("mediaSweeper", sweeper);
  app.addHook("onReady", (done) => {
    dispatcher.start(config.broadcasts.sweepIntervalMs);
    sweeper.start(config.media.sweepIntervalMs);
    done();
  });
  app.addHook("onClose", (_instance, done) => {
    dispatcher.stop();
    sweeper.stop();
    done();
  });

  await app.register(mediaRoutes, {
    prefix: "/media",
    service: new MediaService({
      repo: mediaRepo,
      chats,
      storage,
      rateLimiter,
      settings: config.media,
      log: mediaLog,
    }),
  });

  await app.register(photosRoutes, {
    service: new PhotosService({
      repo: new PhotosRepository(db),
      storage,
      rateLimiter,
      downloadUrlTtlSeconds: config.media.downloadUrlTtlSeconds,
    }),
  });

  await app.register(chatsRoutes, {
    prefix: "/chats",
    service: new ChatsService(chats, app.realtime, rateLimiter, (userId, chatId, receipts) =>
      broadcasts.onDirectReceipts(userId, chatId, receipts),
    ),
  });

  await app.register(messagesRoutes, {
    prefix: "/chats",
    service: new MessagesService({
      messages: new MessagesRepository(db),
      chats,
      groups,
      realtime: app.realtime,
      rateLimiter,
      onMessageCommitted: notifyCommitted,
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

  await app.register(broadcastsRoutes, { prefix: "/broadcasts", service: broadcasts });
}
