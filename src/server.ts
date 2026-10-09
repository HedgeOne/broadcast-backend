import { buildApp } from "./app.js";
import { config } from "./config/index.js";
import { closeDatabase } from "./db/client.js";
import { logger } from "./lib/logger.js";
import { closeRedis } from "./redis/client.js";

const app = await buildApp();

let shuttingDown = false;

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;

  logger.info({ signal }, "shutting down");

  const forceExit = setTimeout(() => {
    logger.error("graceful shutdown timed out; forcing exit");
    process.exit(1);
  }, 10_000);
  forceExit.unref();

  try {
    await app.close();
    await Promise.allSettled([closeDatabase(), closeRedis()]);
    process.exit(0);
  } catch (error) {
    logger.error({ err: error }, "error during shutdown");
    process.exit(1);
  }
}

process.once("SIGINT", (signal) => void shutdown(signal));
process.once("SIGTERM", (signal) => void shutdown(signal));

try {
  await app.listen({
    host: config.server.host,
    port: config.server.port,
  });
} catch (error) {
  logger.error({ err: error }, "failed to start server");
  await Promise.allSettled([closeDatabase(), closeRedis()]);
  process.exit(1);
}
