/**
 * PLAN19 P19-31 — Hard boundary #3 as a measurement: capture every headline
 * figure the app computes, so two versions of the code can be compared
 * byte for byte over the same book.
 *
 * Shaped like [networth-parity.ts](./networth-parity.ts): a script, not a
 * Vitest suite, because the comparison spans two checkouts. The protocol (the
 * one PLAN19's Batch 7 record documents):
 *
 *   1. Make a scratch database, migrate it with the OLD tree, and seed it with
 *      `make seed-demo` (deterministic for a given `--today`).
 *   2. On the old tree: `capture --out before.json`. Repeat 1–2 into a second
 *      file; the two must be identical, or the harness is not deterministic.
 *   3. Repeat 1, apply the new tree's migrations, and on the new tree
 *      `capture --out after.json`.
 *   4. `compare before.json after.json --allow-alert=<type>`: every figure must
 *      match, and the only permitted difference is new alert rows of the named
 *      types (ADR-052's `backup_not_configured`).
 *
 * **It writes to the database**, unlike networth-parity: it clears `alerts` and
 * runs the four alert-writing jobs so their output can be compared. It
 * therefore refuses any database whose name does not contain "parity", and
 * each capture wants a freshly seeded one: the cash-flow job materializes
 * occurrences, so a second capture on the same database reads a different book.
 *
 * The capture uses only functions that predate Phase 19, so the same file runs
 * unchanged on both trees. The clock is fixed (`--today`, noon UTC) and every
 * loader and job takes it explicitly, so nothing reads the wall clock.
 *
 * Usage:
 *   DATABASE_URL=… node --import tsx --import ./scripts/loaders/register.mjs \
 *     scripts/figures-parity.ts capture --today=2026-10-10 --out=before.json
 *   node --import tsx scripts/figures-parity.ts compare before.json after.json \
 *     --allow-alert=backup_not_configured
 */

import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";

const BENCHMARK = "^GSPC";

/** Fixed windows, so both trees read exactly the same ranges. */
function windows(today: string): Record<string, { from: string; to: string }> {
  const back = (days: number): string => {
    const d = new Date(`${today}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - days);
    return d.toISOString().slice(0, 10);
  };
  return { "3M": { from: back(91), to: today }, "1Y": { from: back(364), to: today } };
}

/** JSON with Money, Decimal, Map and Date flattened to stable strings. */
function stable(value: unknown): unknown {
  if (value === null || value === undefined) return value ?? null;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Map) return [...value.entries()].map(([k, v]) => [k, stable(v)]);
  if (value instanceof Set) return [...value].map(stable);
  if (Array.isArray(value)) return value.map(stable);
  if (typeof value === "object") {
    const ctor = (value as { constructor?: { name?: string } }).constructor?.name;
    if (ctor === "Money" || ctor === "Decimal") return String(value);
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = stable((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

async function capture(today: string, outPath: string): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set.");
  const database = new URL(url).pathname.replace(/^\//, "");
  if (!database.includes("parity")) {
    throw new Error(
      `Refusing: "${database}" is not a parity database. This capture clears alerts and runs jobs.`,
    );
  }

  const { sql } = await import("drizzle-orm");
  const { db } = await import("../src/db/client.ts");
  const { computeNetWorth, netWorthSeries } = await import("../src/lib/net-worth/compute.ts");
  const { loadDashboard } = await import("../src/lib/dashboard/loader.ts");
  const { loadAttribution } = await import("../src/lib/net-worth/attribution-loader.ts");
  const { listValuedPositions } = await import("../src/lib/investments/valued.ts");
  const q = await import("../src/lib/investments/queries.ts");
  const perf = await import("../src/lib/investments/performance.ts");
  const spend = await import("../src/lib/analytics/spending.ts");
  const { budgetVsActual } = await import("../src/lib/budgets/queries.ts");
  const { loadCashFlow } = await import("../src/lib/cashflow/loader.ts");
  const { loadSinkingFund } = await import("../src/lib/sinking/loader.ts");
  const { loadPlan } = await import("../src/lib/advice/plan.ts");
  const { detectAnomaliesDailyProcessor } = await import(
    "../src/worker/jobs/detect-anomalies-daily.ts"
  );
  const { evaluateAdviceProcessor } = await import("../src/worker/jobs/evaluate-advice.ts");
  const { projectCashFlowDailyProcessor } = await import(
    "../src/worker/jobs/project-cashflow-daily.ts"
  );
  const { backupDatabaseDailyProcessor } = await import(
    "../src/worker/jobs/backup-database-daily.ts"
  );

  const now = new Date(`${today}T12:00:00Z`);
  const figures: Record<string, unknown> = {};

  figures.netWorth = await computeNetWorth(now, "USD");
  figures.netWorthSeries = await netWorthSeries();
  for (const range of ["1M", "1Y", "ALL"] as const) {
    figures[`dashboard.${range}`] = await loadDashboard(range, now);
  }

  for (const [label, w] of Object.entries(windows(today))) {
    figures[`attribution.${label}`] = await loadAttribution(w);
    figures[`spending.summary.${label}`] = await spend.spendingSummary(w);
    figures[`spending.byCategory.${label}`] = await spend.spendByCategory(w);
    figures[`spending.byMonth.${label}`] = await spend.spendByMonth(w);

    // /investments/performance, assembled exactly as the page assembles it.
    const [snaps, flowTxns, bench] = await Promise.all([
      q.listHoldingSnapshots(w),
      q.listInvestmentFlows(w),
      q.benchmarkCloseSeries(BENCHMARK, w),
    ]);
    const values = perf.valueSeries(snaps, "USD");
    const flows = flowTxns.map(perf.externalFlow).filter((f) => f !== null);
    const first = values[0];
    const last = values.at(-1);
    figures[`performance.${label}`] = {
      values,
      gains: perf.gainLossSeries(snaps, "USD"),
      twr: perf.twr(values, flows),
      benchmarkTwr: perf.benchmarkTwr(bench),
      mwr:
        first && last
          ? perf.moneyWeightedReturn({
              startValue: first.value,
              startDate: first.date,
              endValue: last.value,
              endDate: last.date,
              flows,
            })
          : null,
      attribution: first && last ? perf.attribution(first.value, last.value, flows, "USD") : null,
    };
  }

  figures.valuedPositions = await listValuedPositions(today);
  const month = today.slice(0, 7);
  figures[`budgets.${month}`] = await budgetVsActual(month);
  figures.cashFlow = await loadCashFlow({ today, now });
  figures.sinking = await loadSinkingFund({ today });
  figures.plan = await loadPlan({ today }, now);

  // Alerts: start from none, run every alert-writing job once on the fixed
  // clock with no backup recipient and no mail, and record what they wrote.
  await db.execute(sql`TRUNCATE alerts`);
  const job = {} as Parameters<typeof detectAnomaliesDailyProcessor>[0];
  const quiet = async () => ({ sent: false });
  await detectAnomaliesDailyProcessor(job, { env: {}, now: () => now, notify: quiet });
  await evaluateAdviceProcessor(job, { now: () => now, notify: quiet });
  await projectCashFlowDailyProcessor(job, { now: () => now, notify: quiet });
  await backupDatabaseDailyProcessor(job, { env: { DATABASE_URL: url }, now: () => now });
  figures.alerts = Array.from(
    await db.execute(sql`
      SELECT type, severity, dedup_hash, title, detail, resolved_at
      FROM alerts ORDER BY type, dedup_hash`),
  );

  await writeFile(outPath, `${JSON.stringify(stable(figures), null, 1)}\n`);
  console.log(`✓ captured ${Object.keys(figures).length} figure groups → ${outPath}`);
}

interface AlertRow {
  readonly type: string;
  readonly dedup_hash: string;
}

async function compare(beforePath: string, afterPath: string, allowed: readonly string[]) {
  const before = JSON.parse(await readFile(beforePath, "utf8")) as Record<string, unknown>;
  const after = JSON.parse(await readFile(afterPath, "utf8")) as Record<string, unknown>;
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  const moved: string[] = [];

  for (const key of keys) {
    if (key === "alerts") continue;
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) moved.push(key);
  }

  // Alerts: every row before must still be there, byte for byte; the only new
  // rows allowed are of the sanctioned types.
  const b = (before.alerts ?? []) as AlertRow[];
  const a = (after.alerts ?? []) as AlertRow[];
  const afterSet = new Set(a.map((r) => JSON.stringify(r)));
  const beforeSet = new Set(b.map((r) => JSON.stringify(r)));
  const lost = b.filter((r) => !afterSet.has(JSON.stringify(r)));
  const added = a.filter((r) => !beforeSet.has(JSON.stringify(r)));
  const unsanctioned = added.filter((r) => !allowed.includes(r.type));

  console.log(
    `Compared ${keys.length - 1} figure groups and ${b.length} → ${a.length} alert rows.`,
  );
  for (const r of added)
    console.log(`  + alert ${r.type}${allowed.includes(r.type) ? " (sanctioned)" : ""}`);
  for (const r of lost) console.log(`  - alert ${r.type} (disappeared)`);
  for (const k of moved) console.log(`  ✗ moved: ${k}`);

  if (moved.length === 0 && lost.length === 0 && unsanctioned.length === 0) {
    console.log("\n✓ No figure moved.");
    return;
  }
  console.log("\n✗ Parity failed.");
  process.exitCode = 1;
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      today: { type: "string" },
      out: { type: "string" },
      "allow-alert": { type: "string", multiple: true },
    },
  });
  const [command, ...files] = positionals;
  if (command === "capture") {
    if (!values.today || !values.out) throw new Error("capture needs --today and --out.");
    await capture(values.today, values.out);
  } else if (command === "compare" && files.length === 2) {
    await compare(files[0] ?? "", files[1] ?? "", values["allow-alert"] ?? []);
  } else {
    throw new Error("Usage: figures-parity.ts capture --today=… --out=… | compare a.json b.json");
  }
}

try {
  await main();
} catch (err) {
  console.error(err);
  process.exitCode = 1;
} finally {
  process.exit(process.exitCode ?? 0);
}
