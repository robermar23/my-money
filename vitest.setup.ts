// Marker export to make this file a module (TS top-level await requires it).
export {};

// Load .env.local before any test code (including module-level db client init) runs.
// Node 22+ built-in; no dotenv dependency.
try {
  process.loadEnvFile(".env.local");
} catch {
  // CI environments inject real env vars; .env.local won't exist there.
}

// Several specs TRUNCATE shared tables in beforeEach. To guarantee that can
// never wipe development data, the suite REQUIRES a dedicated test database
// and refuses to run against anything else.
const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!testDatabaseUrl) {
  throw new Error(
    "TEST_DATABASE_URL is not set. The Vitest suite truncates shared tables and " +
      "must run against a dedicated test database — never the dev DB. " +
      'Add it to .env.local (see .env.example) and run "make up" to start the test Postgres container.',
  );
}
const parsed = new URL(testDatabaseUrl);
const dbName = parsed.pathname.replace(/^\//, "");
if (!dbName.includes("test")) {
  throw new Error(
    `TEST_DATABASE_URL points at database "${dbName}", which does not look like a test database. The name must contain "test" (e.g. money_test) so destructive TRUNCATEs cannot hit dev data by mistake.`,
  );
}
process.env.DATABASE_URL = testDatabaseUrl;

// Apply migrations against the (possibly fresh) test database before any spec
// loads the schema. drizzle-orm's migrator is idempotent — re-running against
// an already-migrated DB is a no-op.
const { drizzle } = await import("drizzle-orm/postgres-js");
const { migrate } = await import("drizzle-orm/postgres-js/migrator");
const postgres = (await import("postgres")).default;
const migrationClient = postgres(testDatabaseUrl, { max: 1 });
try {
  await migrate(drizzle(migrationClient), { migrationsFolder: "./drizzle" });
} finally {
  await migrationClient.end();
}
