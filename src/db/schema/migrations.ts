import { integer, pgTable, text } from "drizzle-orm/pg-core";

import { timestamptz } from "./types.js";

// Written by the migration runner (src/db/migrate.ts), not by application code.
export const schemaMigrations = pgTable("schema_migrations", {
  version: integer("version").primaryKey(),
  name: text("name").notNull(),
  appliedAt: timestamptz("applied_at").notNull().defaultNow(),
});
