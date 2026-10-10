/**
 * PLAN19 P19-32 — `make seed-demo`: fill an **empty** instance with a
 * fictional household so it can be evaluated before it holds real finances.
 *
 * Every safety property lives in [seed.ts](../src/lib/demo/seed.ts) and is
 * tested there; this file only reports. It refuses (exit 1, nothing written)
 * when the book already holds records, and when `NODE_ENV=production` unless
 * `SEED_DEMO_CONFIRM=yes` is set.
 *
 * Usage:
 *   node --env-file=.env.local --import tsx --import ./scripts/loaders/register.mjs \
 *     scripts/seed-demo.ts [--today=YYYY-MM-DD]
 */

import { parseArgs } from "node:util";
import { DemoSeedRefused, seedDemo } from "../src/lib/demo/seed.ts";

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set.");
  const { values } = parseArgs({ options: { today: { type: "string" } } });
  if (values.today !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(values.today)) {
    throw new Error(`--today must be YYYY-MM-DD, got "${values.today}".`);
  }

  // The connection string itself is never printed (CLAUDE.md §Secrets).
  const database = new URL(process.env.DATABASE_URL).pathname.replace(/^\//, "");
  console.log(`Seeding the demo household into "${database}"…`);

  const summary = await seedDemo({ today: values.today });
  console.log(
    `✓ ${summary.accounts} accounts, ${summary.transactions} transactions and ` +
      `${summary.snapshots} balance snapshots, ${summary.from} → ${summary.today}.`,
  );
  console.log("  Every name and figure is fictional. To clear it: make db-reset.");
}

try {
  await main();
} catch (err) {
  if (err instanceof DemoSeedRefused) console.error(`✗ ${err.message}`);
  else console.error(err);
  process.exitCode = 1;
} finally {
  // The app's pooled client keeps the event loop alive otherwise.
  process.exit(process.exitCode ?? 0);
}
