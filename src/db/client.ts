import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";

import { config } from "../config/index.js";
import { logger } from "../lib/logger.js";
import * as schema from "./schema/index.js";

const { Pool } = pg;

export const pool = new Pool({
  connectionString: config.database.url,
  max: config.database.poolMax,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

// Without a listener, an error on an idle client (e.g. Postgres restart)
// is emitted as an unhandled 'error' event and crashes the process.
pool.on("error", (error) => {
  logger.error({ err: error }, "[postgres] idle client error");
});

export const db = drizzle(pool, { schema });

export type Database = typeof db;

export async function checkDatabaseConnection(): Promise<void> {
  await pool.query("SELECT 1");
}

export async function closeDatabase(): Promise<void> {
  await pool.end();
}
