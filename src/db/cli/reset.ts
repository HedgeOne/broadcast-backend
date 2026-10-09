import pg from "pg";

import { config } from "../../config/index.js";
import { runMigrations } from "../migrator.js";
import { assertLocalDatabase, describeDatabase } from "./local-database.js";

const connectionString = config.database.url;

async function main(): Promise<void> {
  assertLocalDatabase(connectionString, "reset the database");

  if (!process.argv.includes("--force")) {
    throw new Error(
      `This drops every table in ${describeDatabase(connectionString)}.\n` +
        "Re-run with --force to confirm: pnpm db:reset --force",
    );
  }

  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await client.query("DROP SCHEMA public CASCADE");
    await client.query("CREATE SCHEMA public");
  } finally {
    await client.end();
  }
  console.log(`Dropped schema public in ${describeDatabase(connectionString)}.`);

  const applied = await runMigrations(connectionString, (file) => {
    console.log(`applied ${file.fileName}`);
  });
  console.log(`Reset complete. Applied ${applied.length} migration(s).`);
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
