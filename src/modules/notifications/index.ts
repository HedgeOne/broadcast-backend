import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";

import { config } from "../../config/index.js";
import { db } from "../../db/client.js";
import { redisRateLimiter, type RateLimiter } from "../../lib/rate-limiter.js";
import { ExpoPushProvider, type PushProvider } from "./notifications.provider.js";
import { NotificationsRepository } from "./notifications.repository.js";
import { notificationsRoutes } from "./notifications.routes.js";
import { PushNotifier, type PushNotifierSettings } from "./notifications.worker.js";

export interface NotificationsModuleOptions {
  // Defaults to the Expo Push Service; tests pass a fake.
  provider?: PushProvider;
  rateLimiter?: RateLimiter;
  settings?: Partial<PushNotifierSettings>;
}

declare module "fastify" {
  interface FastifyInstance {
    pushNotifier: PushNotifier;
  }
}

// Push token registration and the push worker. Requires the auth module.
// Not encapsulated, so the chats module can kick the worker after a
// message commits (and tests can drive it).
export const notificationsModule = fp<NotificationsModuleOptions>(notificationsPlugin, {
  name: "notifications",
  dependencies: ["auth"],
});

async function notificationsPlugin(
  app: FastifyInstance,
  options: NotificationsModuleOptions,
): Promise<void> {
  const repository = new NotificationsRepository(db);
  const provider =
    options.provider ??
    new ExpoPushProvider({
      apiUrl: config.push.apiUrl,
      accessToken: config.push.accessToken,
      requestTimeoutMs: config.push.requestTimeoutMs,
    });
  const notifier = new PushNotifier(repository, provider, app.log.child({ component: "push" }), {
    maxAttempts: config.push.maxAttempts,
    maxAgeSeconds: config.push.maxAgeSeconds,
    receiptDelaySeconds: config.push.receiptDelaySeconds,
    ...options.settings,
  });

  app.decorate("pushNotifier", notifier);
  app.addHook("onReady", (done) => {
    notifier.start(config.push.sweepIntervalMs);
    done();
  });
  app.addHook("onClose", async () => {
    notifier.stop();
    await notifier.idle();
  });

  await app.register(notificationsRoutes, {
    prefix: "/devices",
    repository,
    rateLimiter: options.rateLimiter ?? redisRateLimiter,
  });
}
