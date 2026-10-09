import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";

// Resolves to <repo>/migrations from both src/db and dist/db.
export const MIGRATIONS_DIR = fileURLToPath(new URL("../../migrations", import.meta.url));

const MIGRATION_FILE_PATTERN = /^(\d{3})_([a-z0-9_]+)\.sql$/;

// Arbitrary constant; serialises concurrent migration runs.
const MIGRATION_LOCK_ID = 7_316_402_115;

export interface MigrationFile {
  version: number;
  name: string;
  fileName: string;
  filePath: string;
}

export interface AppliedMigration {
  version: number;
  name: string;
  appliedAt: Date;
}

export interface MigrationStatus {
  applied: AppliedMigration[];
  pending: MigrationFile[];
}

export async function readMigrationFiles(dir = MIGRATIONS_DIR): Promise<MigrationFile[]> {
  const entries = await readdir(dir);
  const files: MigrationFile[] = [];
  const seen = new Map<number, string>();

  for (const fileName of entries) {
    if (!fileName.endsWith(".sql")) {
      continue;
    }

    const match = MIGRATION_FILE_PATTERN.exec(fileName);
    if (!match?.[1] || !match[2]) {
      throw new Error(`Invalid migration file name "${fileName}". Expected NNN_snake_case.sql`);
    }

    const version = Number(match[1]);
    const existing = seen.get(version);
    if (existing) {
      throw new Error(`Duplicate migration version ${version}: ${existing} and ${fileName}`);
    }
    seen.set(version, fileName);

    files.push({ version, name: match[2], fileName, filePath: path.join(dir, fileName) });
  }

  return files.sort((a, b) => a.version - b.version);
}

async function readAppliedMigrations(client: pg.ClientBase): Promise<AppliedMigration[]> {
  const exists = await client.query<{ exists: boolean }>(
    "SELECT to_regclass('public.schema_migrations') IS NOT NULL AS exists",
  );

  if (!exists.rows[0]?.exists) {
    return [];
  }

  const result = await client.query<{ version: number; name: string; applied_at: Date }>(
    "SELECT version, name, applied_at FROM schema_migrations ORDER BY version",
  );

  return result.rows.map((row) => ({
    version: row.version,
    name: row.name,
    appliedAt: row.applied_at,
  }));
}

function resolvePending(files: MigrationFile[], applied: AppliedMigration[]): MigrationFile[] {
  const fileByVersion = new Map(files.map((file) => [file.version, file]));

  for (const migration of applied) {
    if (!fileByVersion.has(migration.version)) {
      throw new Error(
        `Migration ${migration.version} (${migration.name}) is recorded in schema_migrations but has no file in ${MIGRATIONS_DIR}`,
      );
    }
  }

  const appliedVersions = new Set(applied.map((migration) => migration.version));
  const latestApplied = Math.max(0, ...appliedVersions);
  const pending = files.filter((file) => !appliedVersions.has(file.version));

  const outOfOrder = pending.find((file) => file.version < latestApplied);
  if (outOfOrder) {
    throw new Error(
      `Migration ${outOfOrder.fileName} is older than the latest applied version (${latestApplied}). ` +
        "Renumber it after the latest applied migration.",
    );
  }

  return pending;
}

// Migration 001 contains its own BEGIN/COMMIT and records itself in
// schema_migrations. New migrations should omit both; the runner wraps
// them in a transaction and records them.
function managesOwnTransaction(sql: string): boolean {
  return /^\s*BEGIN\s*;/im.test(sql) && /^\s*COMMIT\s*;/im.test(sql);
}

async function applyMigration(client: pg.ClientBase, file: MigrationFile): Promise<void> {
  const sql = await readFile(file.filePath, "utf8");
  const record = {
    text: "INSERT INTO schema_migrations (version, name) VALUES ($1, $2) ON CONFLICT (version) DO NOTHING",
    values: [file.version, file.name],
  };

  if (managesOwnTransaction(sql)) {
    await client.query(sql);
    await client.query(record);
    return;
  }

  await client.query("BEGIN");
  try {
    await client.query(sql);
    await client.query(record);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function withClient<T>(
  connectionString: string,
  fn: (client: pg.Client) => Promise<T>,
): Promise<T> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

export async function getMigrationStatus(connectionString: string): Promise<MigrationStatus> {
  const files = await readMigrationFiles();

  return withClient(connectionString, async (client) => {
    const applied = await readAppliedMigrations(client);
    return { applied, pending: resolvePending(files, applied) };
  });
}

export async function runMigrations(
  connectionString: string,
  onApplied: (file: MigrationFile) => void = () => {},
): Promise<MigrationFile[]> {
  const files = await readMigrationFiles();

  return withClient(connectionString, async (client) => {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_ID]);

    try {
      const applied = await readAppliedMigrations(client);
      const pending = resolvePending(files, applied);

      for (const file of pending) {
        await applyMigration(client, file);
        onApplied(file);
      }

      return pending;
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_ID]);
    }
  });
}
