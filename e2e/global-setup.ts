import postgres from "postgres";

/**
 * Truncate all domain tables once before any Playwright test runs.
 *
 * This guarantees every E2E spec starts from a clean DB — including a clean
 * `users` table, so the first-run setup wizard always triggers as expected.
 *
 * The DATABASE_URL is loaded from .env.local (which Node 22 auto-loads when
 * the script is invoked with `--env-file=.env.local`). When Playwright runs
 * its config, it doesn't auto-load .env.local, so we fall back to the same
 * hardcoded dev default that .env.example ships with.
 */
export default async function globalSetup(): Promise<void> {
  try {
    process.loadEnvFile(".env.local");
  } catch {
    // ignore: real env vars will be used
  }
  const databaseUrl =
    process.env.DATABASE_URL ?? "postgres://money:dev_password_change_me@127.0.0.1:5433/money";

  const sql = postgres(databaseUrl, { max: 1 });
  try {
    // Comprehensive truncate so no E2E-seeded row survives into a later run or
    // into manual testing — in particular Plaid Items, which carry FAKE access
    // tokens in tests and would otherwise 400 the connections/map flow. CASCADE
    // handles children; the Plaid + investment tables are listed explicitly
    // because truncating `accounts` doesn't reach plaid_items, plaid_sync_runs,
    // webhook_log, or securities.
    await sql.unsafe(
      "TRUNCATE users, accounts, holdings, securities, holding_lots, investment_transactions, account_snapshots, liabilities, transactions, import_batches, category_rules, plaid_items, plaid_sync_runs, webhook_log CASCADE",
    );
  } finally {
    await sql.end();
  }
}
