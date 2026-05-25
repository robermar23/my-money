import { defineConfig } from "drizzle-kit";

// Load .env.local for drizzle-kit CLI usage (Node 22+ built-in).
try {
  process.loadEnvFile(".env.local");
} catch {
  // .env.local may not exist in CI or prod; rely on real env vars in that case.
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "DATABASE_URL is not set. Run with --env-file=.env.local or export it in your shell.",
  );
}

export default defineConfig({
  schema: "./src/db/schema/index.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: databaseUrl,
  },
  verbose: true,
  strict: true,
});
