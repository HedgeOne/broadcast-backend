import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyBaseLogger } from "fastify";

import { config } from "./config/index.js";
import { registerErrorHandling } from "./lib/error-handler.js";
import { logger } from "./lib/logger.js";
import { authModule, type AuthModuleOptions } from "./modules/auth/index.js";
import { chatsModule, type ChatsModuleOptions } from "./modules/chats/index.js";
import { contactsModule, type ContactsModuleOptions } from "./modules/contacts/index.js";
import { privacyModule } from "./modules/privacy/index.js";
import { usersModule } from "./modules/users/index.js";
import { realtimeModule } from "./realtime/index.js";
import { healthRoutes } from "./routes/health.js";

export interface BuildAppOptions {
  auth?: AuthModuleOptions;
  contacts?: ContactsModuleOptions;
  chats?: ChatsModuleOptions;
  logger?: FastifyBaseLogger | undefined;
}

export async function buildApp(options: BuildAppOptions = {}) {
  // Typed as the base logger so `app` is a plain FastifyInstance.
  const loggerInstance: FastifyBaseLogger = options.logger ?? logger;

  const app = Fastify({
    loggerInstance,
    trustProxy: config.server.trustProxy,
  });

  registerErrorHandling(app);

  await app.register(cors, {
    origin: true,
  });

  await app.register(helmet);

  // Coarse per-IP flood guard. Messaging clients send receipts and syncs
  // alongside messages; per-user limits on sensitive routes are in Redis.
  await app.register(rateLimit, {
    max: 300,
    timeWindow: "1 minute",
    // In-process WebSocket injection (tests) carries no remote address.
    keyGenerator: (request) => request.ip || "unknown",
  });

  await app.register(websocket);

  await app.register(healthRoutes);

  await app.register(authModule, options.auth ?? {});
  await app.register(realtimeModule);
  await app.register(usersModule);
  await app.register(contactsModule, options.contacts ?? {});
  await app.register(chatsModule, options.chats ?? {});
  await app.register(privacyModule);

  return app;
}

export type App = Awaited<ReturnType<typeof buildApp>>;
