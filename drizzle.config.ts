import { defineConfig } from "drizzle-kit";

import { env } from "./src/config/env.js";

// drizzle-kit is used to draft SQL from schema changes and for Studio.
// Drafts land in ./drizzle and are reviewed, then copied into
// ./migrations as NNN_name.sql, which `pnpm db:migrate` applies.
// See docs/database.md.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema/*.ts",
  out: "./drizzle",
  dbCredentials: {
    url: env.DATABASE_URL,
  },
  strict: true,
  verbose: true,
});
