import { config } from "../../config/index.js";
import { getMigrationStatus, runMigrations } from "../migrator.js";

const command = process.argv[2] ?? "up";

async function main(): Promise<void> {
  switch (command) {
    case "up": {
      const applied = await runMigrations(config.database.url, (file) => {
        console.log(`applied ${file.fileName}`);
      });
      console.log(
        applied.length === 0
          ? "Database is up to date."
          : `Applied ${applied.length} migration(s).`,
      );
      return;
    }

    case "status": {
      const { applied, pending } = await getMigrationStatus(config.database.url);

      for (const migration of applied) {
        console.log(
          `  applied  ${String(migration.version).padStart(3, "0")}_${migration.name}  (${migration.appliedAt.toISOString()})`,
        );
      }
      for (const file of pending) {
        console.log(`  pending  ${file.fileName}`);
      }

      console.log(`\n${applied.length} applied, ${pending.length} pending.`);
      return;
    }

    default:
      throw new Error(`Unknown command "${command}". Use "up" or "status".`);
  }
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
