import pg from "pg";

import { config } from "../../config/index.js";
import { runMigrations } from "../migrator.js";
import { assertLocalDatabase, describeDatabase } from "./local-database.js";

async function main(): Promise<void> {
  const testUrl = config.database.testUrl;
  if (!testUrl) {
    throw new Error("TEST_DATABASE_URL is not configured.");
  }

  assertLocalDatabase(testUrl, "prepare the test database");

  const testDatabaseName = decodeURIComponent(new URL(testUrl).pathname.slice(1));
  const mainDatabaseName = decodeURIComponent(new URL(config.database.url).pathname.slice(1));

  if (!testDatabaseName || testDatabaseName === mainDatabaseName) {
    throw new Error("TEST_DATABASE_URL must point to a separate database from DATABASE_URL.");
  }

  const admin = new pg.Client({ connectionString: config.database.url });
  await admin.connect();
  try {
    const existing = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [
      testDatabaseName,
    ]);

    if (existing.rowCount === 0) {
      await admin.query(`CREATE DATABASE ${pg.escapeIdentifier(testDatabaseName)}`);
      console.log(`Created database ${testDatabaseName}.`);
    }
  } finally {
    await admin.end();
  }

  const applied = await runMigrations(testUrl, (file) => {
    console.log(`applied ${file.fileName}`);
  });
  console.log(
    `Test database ${describeDatabase(testUrl)} ready (${applied.length} migration(s) applied).`,
  );
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
