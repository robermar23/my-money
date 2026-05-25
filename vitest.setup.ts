// Load .env.local before any test code (including module-level db client init) runs.
// Node 22+ built-in; no dotenv dependency.
try {
  process.loadEnvFile(".env.local");
} catch {
  // CI environments inject real env vars; .env.local won't exist there.
}
