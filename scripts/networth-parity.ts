/**
 * NW-07 — prove the set-based `netWorthSeries` matches the old per-date loop
 * **on the user's real data**, not just on fixtures.
 *
 * The Vitest parity suite ([series-parity.test.ts](../src/lib/net-worth/series-parity.test.ts))
 * covers a hand-built book and randomized small ones. This covers the book that
 * actually matters: whatever is in the live database, with its real gaps, closed
 * accounts, and price history. It is the last gate before the rewrite ships.
 *
 * **Read-only by construction.** It issues nothing but SELECTs — no TRUNCATE, no
 * INSERT, no migration. It is therefore safe (and intended) to point at the dev
 * database, unlike `perf:dashboard` and the Vitest suite, which both refuse to
 * run anywhere but a test DB precisely because they destroy data.
 *
 * Output is deliberately quiet about money: it prints the number of points
 * compared and, for any mismatch, the **date** only. `--verbose` adds the two
 * amounts, for when you are actually debugging a divergence.
 *
 * Usage:
 *   node --env-file=.env.local --import tsx --import ./scripts/loaders/register.mjs \
 *     scripts/networth-parity.ts [--verbose]
 */

import { sql } from "drizzle-orm";
import { db } from "../src/db/client.ts";
import { accountSnapshots } from "../src/db/schema/index.ts";
import {
  type NetWorthPoint,
  computeNetWorth,
  netWorthSeries,
} from "../src/lib/net-worth/compute.ts";

const VERBOSE = process.argv.includes("--verbose");

/**
 * The pre-rewrite implementation, reproduced here as the oracle: walk every
 * distinct snapshot date and call `computeNetWorth` once per date.
 *
 * `computeNetWorth` is untouched by the rewrite, which is what makes this a
 * genuine independent check rather than the new code grading its own homework.
 *
 * @param baseCurrency - Currency to sum in.
 * @returns Ascending points, one per distinct snapshot date.
 */
async function referenceSeries(baseCurrency = "USD"): Promise<NetWorthPoint[]> {
  const dates = await db
    .select({ date: accountSnapshots.date })
    .from(accountSnapshots)
    .groupBy(accountSnapshots.date)
    .orderBy(sql`${accountSnapshots.date} asc`);

  const points: NetWorthPoint[] = [];
  for (const { date } of dates) {
    const snap = await computeNetWorth(new Date(`${date}T00:00:00Z`), baseCurrency);
    points.push({ date, value: snap.total.toString() });
  }
  return points;
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not set.");
  }
  // The connection string itself is never printed (CLAUDE.md §Secrets).
  const database = new URL(process.env.DATABASE_URL).pathname.replace(/^\//, "");
  console.log(`Comparing netWorthSeries against the per-date reference on "${database}"…`);

  const t0 = performance.now();
  const actual = await netWorthSeries();
  const setBasedMs = performance.now() - t0;

  const t1 = performance.now();
  const expected = await referenceSeries();
  const referenceMs = performance.now() - t1;

  const mismatches: Array<{ date: string; actual: string | null; expected: string | null }> = [];
  const byDate = new Map(actual.map((p) => [p.date, p.value]));
  const seen = new Set<string>();

  for (const point of expected) {
    seen.add(point.date);
    const got = byDate.get(point.date) ?? null;
    if (got !== point.value) {
      mismatches.push({ date: point.date, actual: got, expected: point.value });
    }
  }
  // A date the rewrite invented that the reference never produced.
  for (const point of actual) {
    if (!seen.has(point.date)) {
      mismatches.push({ date: point.date, actual: point.value, expected: null });
    }
  }

  console.log(
    `\n  set-based: ${actual.length} points in ${setBasedMs.toFixed(0)} ms` +
      `\n  reference: ${expected.length} points in ${referenceMs.toFixed(0)} ms`,
  );
  if (expected.length > 0 && setBasedMs > 0) {
    console.log(`  speedup:   ${(referenceMs / setBasedMs).toFixed(1)}×`);
  }

  if (expected.length === 0) {
    // Worth saying out loud: agreeing on nothing proves nothing. An empty
    // result usually means this database has no snapshots yet.
    console.log("\n⚠ 0 points to compare — this database has no account_snapshots rows.");
    return;
  }
  if (mismatches.length === 0) {
    console.log(`\n✓ 0 mismatches over ${expected.length} points`);
    return;
  }

  console.log(`\n✗ ${mismatches.length} mismatch(es) over ${expected.length} points:`);
  for (const m of mismatches) {
    console.log(
      VERBOSE
        ? `    ${m.date}: set-based ${m.actual ?? "(missing)"} vs reference ${m.expected ?? "(missing)"}`
        : `    ${m.date}`,
    );
  }
  if (!VERBOSE) console.log("  (re-run with --verbose to see the amounts)");
  process.exitCode = 1;
}

try {
  await main();
} catch (err) {
  console.error(err);
  process.exitCode = 1;
} finally {
  // The app's pooled client keeps the event loop alive otherwise.
  process.exit(process.exitCode ?? 0);
}
