/**
 * P13-20 — dashboard perf sanity harness (ADR-029, CLAUDE.md §Performance).
 *
 * "Measure, don't guess." This seeds a **multi-year** book into the *test*
 * database and times `loadDashboard(range)` end to end, then answers the three
 * questions P13-20 asks:
 *
 *   1. How long does the heaviest range (`ALL`) take?
 *   2. Is the fan-out actually parallel? — compares the one `Promise.all` wall
 *      time against the sum of the same ten reads run one after another.
 *   3. Does any card trigger an N+1? — counts the queries a single
 *      `loadDashboard("ALL")` issues. A constant count (~the number of reads)
 *      means no; a count that tracks the account/holding count means yes.
 *
 * Safety: this script TRUNCATEs and rewrites tables, so it refuses to run
 * against anything but `TEST_DATABASE_URL` whose database name contains "test" —
 * the same guard `vitest.setup.ts` uses so a stray run can never hit dev data.
 *
 * Usage:
 *   pnpm perf:dashboard            # seed, then measure
 *   pnpm perf:dashboard --no-seed  # re-measure against the existing seed
 */

import postgres from "postgres";

// ── Safety guard: test database only ─────────────────────────────────────────

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!testDatabaseUrl) {
  throw new Error(
    "TEST_DATABASE_URL is not set. This harness seeds (and truncates) tables and " +
      "must run against a dedicated test database — never the dev DB.",
  );
}
const dbName = new URL(testDatabaseUrl).pathname.replace(/^\//, "");
if (!dbName.includes("test")) {
  throw new Error(
    `TEST_DATABASE_URL points at "${dbName}", which does not look like a test database.`,
  );
}
// The Drizzle client reads DATABASE_URL lazily on its first query, so setting it
// here — before the dynamic import below — is what binds the app to the test DB.
process.env.DATABASE_URL = testDatabaseUrl;

const RESEED = !process.argv.includes("--no-seed");

// ── Dataset shape (a generous three-year single-user book) ───────────────────

const YEARS = 3;
const DAYS = YEARS * 365;
/** Investment accounts get itemized holdings; the rest are balance/snapshot based. */
const INVESTMENT_ACCOUNTS = 4;
const DEPOSITORY_ACCOUNTS = 4;
const CREDIT_ACCOUNTS = 2;
const PROPERTY_ACCOUNTS = 2;
const HOLDINGS_PER_INVESTMENT = 8;
const TXNS_PER_YEAR = 2500;
const WATCHLIST_ITEMS = 20;
const OPEN_ALERTS = 6;
const BENCHMARK_SYMBOL = "^GSPC";

/** Deterministic LCG — same dataset every run, so numbers are comparable. */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

/** ISO date `n` days before today (UTC). */
function daysAgo(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

function money(n: number): string {
  return n.toFixed(2);
}

// ── Seeding ──────────────────────────────────────────────────────────────────

interface SeedStats {
  readonly accounts: number;
  readonly holdings: number;
  readonly accountSnapshots: number;
  readonly holdingSnapshots: number;
  readonly prices: number;
  readonly transactions: number;
}

async function seed(sql: postgres.Sql): Promise<SeedStats> {
  const rand = makeRandom(20260809);

  await sql.unsafe(`TRUNCATE
    accounts, holdings, holding_snapshots, account_snapshots, securities, prices,
    transactions, categories, category_groups, category_budgets, watchlist_items,
    alerts, investment_transactions, holding_lots, liabilities
    RESTART IDENTITY CASCADE`);

  // ── accounts ───────────────────────────────────────────────────────────────
  const accountRows: Array<{
    id: string;
    name: string;
    institution: string;
    type: string;
    currency: string;
  }> = [];
  const push = (type: string, count: number, prefix: string): void => {
    for (let i = 0; i < count; i++) {
      accountRows.push({
        id: crypto.randomUUID(),
        name: `${prefix} ${i + 1}`,
        institution: `Institution ${i + 1}`,
        type,
        currency: "USD",
      });
    }
  };
  push("investment", INVESTMENT_ACCOUNTS, "Brokerage");
  push("depository", DEPOSITORY_ACCOUNTS, "Checking");
  push("credit_card", CREDIT_ACCOUNTS, "Card");
  push("property", PROPERTY_ACCOUNTS, "Property");
  await sql`INSERT INTO accounts ${sql(accountRows, "id", "name", "institution", "type", "currency")}`;

  const investmentAccounts = accountRows.filter((a) => a.type === "investment");

  // ── securities + holdings ──────────────────────────────────────────────────
  const symbols: string[] = [];
  for (let i = 0; i < INVESTMENT_ACCOUNTS * HOLDINGS_PER_INVESTMENT; i++) {
    symbols.push(`SYM${String(i).padStart(3, "0")}`);
  }
  const securityRows = symbols.map((symbol, i) => ({
    id: crypto.randomUUID(),
    symbol,
    name: `${symbol} Fund`,
    sector: ["Technology", "Healthcare", "Financials", "Energy"][i % 4] ?? null,
    region: ["US", "Developed ex-US", "Emerging"][i % 3] ?? null,
    asset_type: "etf",
    // Two-thirds of the book pays a distribution → a realistic forward-income card.
    dividend_rate: i % 3 === 0 ? null : money(0.5 + rand() * 3),
  }));
  await sql`INSERT INTO securities ${sql(
    securityRows,
    "id",
    "symbol",
    "name",
    "sector",
    "region",
    "asset_type",
    "dividend_rate",
  )}`;

  const holdingRows = symbols.map((symbol, i) => {
    const account = investmentAccounts[i % INVESTMENT_ACCOUNTS];
    if (!account) throw new Error("no investment account");
    const security = securityRows[i];
    if (!security) throw new Error("no security");
    return {
      id: crypto.randomUUID(),
      account_id: account.id,
      symbol,
      quantity: (50 + Math.floor(rand() * 400)).toFixed(8),
      quantity_unit: "shares",
      asset_class: "equity",
      cost_basis: money(5000 + rand() * 40000),
      security_id: security.id,
      source: "manual",
    };
  });
  await sql`INSERT INTO holdings ${sql(
    holdingRows,
    "id",
    "account_id",
    "symbol",
    "quantity",
    "quantity_unit",
    "asset_class",
    "cost_basis",
    "security_id",
    "source",
  )}`;

  // ── prices: daily closes for every symbol + the benchmark ──────────────────
  const priceRows: Array<{ symbol: string; date: string; close: string; source: string }> = [];
  for (const symbol of [...symbols, BENCHMARK_SYMBOL]) {
    let close = symbol === BENCHMARK_SYMBOL ? 4000 : 20 + rand() * 300;
    for (let d = DAYS; d >= 0; d--) {
      close = Math.max(1, close * (1 + (rand() - 0.49) * 0.02));
      priceRows.push({ symbol, date: daysAgo(d), close: close.toFixed(8), source: "seed" });
    }
  }
  await insertChunked(sql, "prices", priceRows, ["symbol", "date", "close", "source"]);

  // ── snapshots: daily per account and per holding ───────────────────────────
  const accountSnapshotRows: Array<{ account_id: string; date: string; balance: string }> = [];
  for (const account of accountRows) {
    let balance = account.type === "credit_card" ? -2500 : 25000 + rand() * 400000;
    for (let d = DAYS; d >= 0; d--) {
      balance = balance * (1 + (rand() - 0.49) * 0.004);
      accountSnapshotRows.push({
        account_id: account.id,
        date: daysAgo(d),
        balance: money(balance),
      });
    }
  }
  await insertChunked(sql, "account_snapshots", accountSnapshotRows, [
    "account_id",
    "date",
    "balance",
  ]);

  const holdingSnapshotRows: Array<{
    holding_id: string;
    date: string;
    quantity: string;
    value: string;
    cost_basis: string;
    currency: string;
  }> = [];
  for (const holding of holdingRows) {
    let value = 10000 + rand() * 90000;
    for (let d = DAYS; d >= 0; d--) {
      value = Math.max(100, value * (1 + (rand() - 0.49) * 0.01));
      holdingSnapshotRows.push({
        holding_id: holding.id,
        date: daysAgo(d),
        quantity: holding.quantity,
        value: money(value),
        cost_basis: holding.cost_basis,
        currency: "USD",
      });
    }
  }
  await insertChunked(sql, "holding_snapshots", holdingSnapshotRows, [
    "holding_id",
    "date",
    "quantity",
    "value",
    "cost_basis",
    "currency",
  ]);

  // ── categories + budgets ───────────────────────────────────────────────────
  const categoryRows = [
    "Groceries",
    "Dining",
    "Transit",
    "Utilities",
    "Housing",
    "Health",
    "Shopping",
    "Travel",
    "Entertainment",
    "Pets",
    "Insurance",
    "Subscriptions",
  ].map((name, i) => ({
    id: crypto.randomUUID(),
    name,
    kind: "expense",
    sort_order: i,
  }));
  categoryRows.push({
    id: crypto.randomUUID(),
    name: "Paycheck",
    kind: "income",
    sort_order: 99,
  });
  await sql`INSERT INTO categories ${sql(categoryRows, "id", "name", "kind", "sort_order")}`;

  const expenseCategories = categoryRows.filter((c) => c.kind === "expense");
  const budgetRows = expenseCategories.map((c) => ({
    category_id: c.id,
    amount: money(100 + rand() * 900),
    currency: "USD",
  }));
  await sql`INSERT INTO category_budgets ${sql(budgetRows, "category_id", "amount", "currency")}`;

  // ── transactions: three years across the cash/credit accounts ──────────────
  const spendAccounts = accountRows.filter(
    (a) => a.type === "depository" || a.type === "credit_card",
  );
  const txnRows: Array<{
    account_id: string;
    posted_at: string;
    amount: string;
    name: string;
    fitid: string;
    source: string;
    category_id: string;
  }> = [];
  const totalTxns = TXNS_PER_YEAR * YEARS;
  for (let i = 0; i < totalTxns; i++) {
    const account = spendAccounts[i % spendAccounts.length];
    const category = categoryRows[i % categoryRows.length];
    if (!account || !category) continue;
    const income = category.kind === "income";
    txnRows.push({
      account_id: account.id,
      // Bias toward recent days so the current month is well populated.
      posted_at: daysAgo(Math.floor(rand() * DAYS)),
      amount: income ? money(2000 + rand() * 1500) : money(-(5 + rand() * 300)),
      name: `Merchant ${i % 250}`,
      fitid: crypto.randomUUID(),
      source: "manual",
      category_id: category.id,
    });
  }
  // Guarantee a populated current month regardless of the random spread.
  for (let i = 0; i < 120; i++) {
    const account = spendAccounts[i % spendAccounts.length];
    const category = expenseCategories[i % expenseCategories.length];
    if (!account || !category) continue;
    txnRows.push({
      account_id: account.id,
      posted_at: daysAgo(i % 14),
      amount: money(-(10 + rand() * 200)),
      name: `Merchant ${i % 60}`,
      fitid: crypto.randomUUID(),
      source: "manual",
      category_id: category.id,
    });
  }
  await insertChunked(sql, "transactions", txnRows, [
    "account_id",
    "posted_at",
    "amount",
    "name",
    "fitid",
    "source",
    "category_id",
  ]);

  // ── watchlist (paper positions → the movers card) ──────────────────────────
  const watchRows = Array.from({ length: WATCHLIST_ITEMS }, (_, i) => {
    const symbol = symbols[i % symbols.length];
    if (!symbol) throw new Error("no symbol");
    return {
      id: crypto.randomUUID(),
      symbol,
      asset_class: "equity",
      label: `Watch ${i}`,
      pretend_quantity: (10 + Math.floor(rand() * 100)).toFixed(8),
      pretend_unit_cost: (10 + rand() * 200).toFixed(8),
      pretend_purchased_at: daysAgo(200 + i),
      currency: "USD",
    };
  });
  await sql`INSERT INTO watchlist_items ${sql(
    watchRows,
    "id",
    "symbol",
    "asset_class",
    "label",
    "pretend_quantity",
    "pretend_unit_cost",
    "pretend_purchased_at",
    "currency",
  )}`;

  // ── open alerts ────────────────────────────────────────────────────────────
  const alertRows = Array.from({ length: OPEN_ALERTS }, (_, i) => ({
    type: "stale_snapshot",
    severity: "warning",
    dedup_hash: `perf-${i}`,
    title: `Account ${i} has not updated`,
    detail: JSON.stringify({ accountId: accountRows[i]?.id ?? null }),
  }));
  await sql`INSERT INTO alerts ${sql(
    alertRows,
    "type",
    "severity",
    "dedup_hash",
    "title",
    "detail",
  )}`;

  await sql.unsafe("ANALYZE");

  return {
    accounts: accountRows.length,
    holdings: holdingRows.length,
    accountSnapshots: accountSnapshotRows.length,
    holdingSnapshots: holdingSnapshotRows.length,
    prices: priceRows.length,
    transactions: txnRows.length,
  };
}

/** Bulk-insert in chunks — one giant multi-row INSERT blows the parameter cap. */
async function insertChunked<T extends Record<string, unknown>>(
  sql: postgres.Sql,
  table: string,
  rows: readonly T[],
  columns: readonly string[],
): Promise<void> {
  const CHUNK = 2000;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);
    await sql`INSERT INTO ${sql(table)} ${sql(slice as never, ...(columns as never[]))}`;
  }
}

// ── Measurement ──────────────────────────────────────────────────────────────

/** Committed-transaction counter — a per-statement proxy for "queries issued". */
async function xactCount(sql: postgres.Sql, database: string): Promise<number> {
  const [row] = await sql<{ n: string }[]>`
    SELECT (xact_commit + xact_rollback)::text AS n
    FROM pg_stat_database WHERE datname = ${database}
  `;
  return Number(row?.n ?? 0);
}

function stats(samples: readonly number[]): { min: number; median: number; max: number } {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    min: sorted[0] ?? 0,
    median: sorted[Math.floor(sorted.length / 2)] ?? 0,
    max: sorted[sorted.length - 1] ?? 0,
  };
}

const ms = (n: number): string => `${n.toFixed(0)} ms`;

async function main(): Promise<void> {
  const sql = postgres(testDatabaseUrl as string, { max: 1 });
  try {
    if (RESEED) {
      console.log(`Seeding ${YEARS} years into ${dbName}…`);
      const t0 = performance.now();
      const s = await seed(sql);
      console.log(`Seeded in ${ms(performance.now() - t0)}:`);
      console.table(s);
    } else {
      console.log("Skipping seed (--no-seed).");
    }

    // Imported AFTER DATABASE_URL is redirected at the test DB.
    const { loadDashboard } = await import("../src/lib/dashboard/loader.ts");

    // ── Per-read cost + query count ─────────────────────────────────────────
    const { computeNetWorth, netWorthSeries } = await import("../src/lib/net-worth/compute.ts");
    const { listValuedPositions } = await import("../src/lib/investments/valued.ts");
    const { listHoldingSnapshots, listInvestmentFlows, benchmarkCloseSeries } = await import(
      "../src/lib/investments/queries.ts"
    );
    const { budgetVsActual, monthRange } = await import("../src/lib/budgets/queries.ts");
    const { spendingSummary } = await import("../src/lib/analytics/spending.ts");
    const { listOpenAlerts } = await import("../src/lib/alerts/queries.ts");
    const { listWatchlist } = await import("../src/lib/watchlist/queries.ts");
    const { rangeWindow } = await import("../src/lib/dashboard/range.ts");

    const now = new Date();
    const w = rangeWindow("ALL", now);
    // A narrow window, to prove the series read actually honors its bounds
    // rather than reading all of history and filtering afterwards.
    const wMonth = rangeWindow("1M", now);
    const month = now.toISOString().slice(0, 7);
    const today = now.toISOString().slice(0, 10);
    const bounds = monthRange(month);

    const reads: ReadonlyArray<readonly [string, () => Promise<unknown>]> = [
      ["computeNetWorth", () => computeNetWorth(now, "USD")],
      ["netWorthSeries (ALL)", () => netWorthSeries("USD")],
      ["netWorthSeries (1M)", () => netWorthSeries("USD", { from: wMonth.from, to: wMonth.to })],
      ["listValuedPositions", () => listValuedPositions(today)],
      ["listHoldingSnapshots", () => listHoldingSnapshots({ from: w.from, to: w.to })],
      ["listInvestmentFlows", () => listInvestmentFlows({ from: w.from, to: w.to })],
      ["benchmarkCloseSeries", () => benchmarkCloseSeries("^GSPC", { from: w.from, to: w.to })],
      ["budgetVsActual", () => budgetVsActual(month, now)],
      ["spendingSummary", () => spendingSummary({ from: bounds.from, to: bounds.to })],
      ["listOpenAlerts", () => listOpenAlerts()],
      ["listWatchlist", () => listWatchlist()],
    ];

    // Each read is timed AND counted. A read whose query count tracks the
    // account/holding/day count — rather than staying flat — is the N+1 the task
    // is looking for.
    console.log("\nPer-read cost + queries issued (ALL window, run sequentially)");
    const perRead: Record<string, { ms: string; queries: number }> = {};
    let sequentialTotal = 0;
    let slowestRead = 0;
    for (const [name, run] of reads) {
      const before = await xactCount(sql, dbName);
      const t = performance.now();
      await run();
      const elapsed = performance.now() - t;
      const after = await xactCount(sql, dbName);
      sequentialTotal += elapsed;
      slowestRead = Math.max(slowestRead, elapsed);
      // −1 for the `xactCount` SELECT that ran between the two samples. Clamped
      // at 0: Postgres flushes per-database stats at most about once a second,
      // so a read that finishes in milliseconds can report nothing yet. Small
      // counts here are a floor, not a measurement — the N+1 signal is the read
      // that reports tens of thousands.
      perRead[name] = { ms: ms(elapsed), queries: Math.max(0, after - before - 1) };
    }
    console.table(perRead);

    // ── How many statements does the series read actually issue? ────────────
    // The per-read column above cannot answer this. Postgres backends buffer
    // their statistics and flush at most about once a second, so a read that
    // finishes in milliseconds reports zero — and worse, its backlog is charged
    // to whatever is measured next, which is why a naive reading here comes out
    // several times too high.
    //
    // Two things make the number trustworthy, and BOTH are required — a probe
    // that skips either reports several times too high (undrained backlog) or
    // near zero (window closed before anything flushed):
    //   1. a discarded drain phase, so the per-read loop's backlog is charged
    //      where it belongs;
    //   2. a window sized in SECONDS rather than repetitions, so the measured
    //      calls' own statements have flushed by the time it closes. A fast
    //      range needs hundreds of reps to fill the same window a slow one
    //      fills with a dozen.
    //
    // What matters is that the figure is CONSTANT and the same for a one-month
    // window as for all of history — the whole point of the set-based rewrite is
    // that it no longer tracks days × accounts × holdings.
    console.log("\nStatements issued per netWorthSeries call");
    const statementProbes: ReadonlyArray<readonly [string, () => Promise<unknown>]> = [
      ["1M", () => netWorthSeries("USD", { from: wMonth.from, to: wMonth.to })],
      ["ALL", () => netWorthSeries("USD")],
    ];
    const statementCounts: Record<string, { perCall: string; reps: number }> = {};
    for (const [label, run] of statementProbes) {
      const drainUntil = Date.now() + 2_000;
      while (Date.now() < drainUntil) await run();

      const before = await xactCount(sql, dbName);
      const measureUntil = Date.now() + 6_000;
      let reps = 0;
      while (Date.now() < measureUntil) {
        await run();
        reps++;
      }
      const after = await xactCount(sql, dbName);
      // −1 for the `xactCount` SELECT that ran between the two samples.
      statementCounts[label] = { perCall: ((after - before - 1) / reps).toFixed(2), reps };
    }
    console.table(statementCounts);

    // ── End-to-end, by range ────────────────────────────────────────────────
    // 1M vs ALL is the interesting comparison: if a narrow range costs the same
    // as the full history, something upstream is ignoring the window.
    console.log("\nloadDashboard(range) — 2 runs each");
    const RANGES = ["1M", "1Y", "ALL"] as const;
    const table: Record<string, Record<string, string>> = {};
    const medians = new Map<string, number>();
    for (const range of RANGES) {
      const samples: number[] = [];
      for (let i = 0; i < 2; i++) {
        const t = performance.now();
        await loadDashboard(range);
        samples.push(performance.now() - t);
      }
      const s = stats(samples);
      medians.set(range, s.median);
      table[range] = { min: ms(s.min), max: ms(s.max) };
    }
    console.table(table);

    // ── Is the fan-out actually parallel? ───────────────────────────────────
    const parallel = medians.get("ALL") ?? 0;
    console.log(
      `\nsequential sum of the ten reads: ${ms(sequentialTotal)}  |  ` +
        `slowest single read: ${ms(slowestRead)}  |  loadDashboard("ALL"): ${ms(parallel)}`,
    );
    // Two acceptable shapes, because which one applies depends on the data:
    //   - one read dominates ⇒ wall time tracks the SLOWEST read, and a
    //     sum-based threshold would wrongly call a parallel fan-out serialized;
    //   - no read dominates ⇒ the ten reads contend for connections and CPU, so
    //     wall time lands between the slowest and the sum. Then the signal is
    //     that it is comfortably BELOW the sum.
    // Serialized execution can satisfy neither.
    const tracksSlowest = parallel <= slowestRead * 1.25;
    const beatsSum = parallel < sequentialTotal * 0.85;
    console.log(
      tracksSlowest || beatsSum
        ? `✓ fan-out is parallel (${tracksSlowest ? "tracks the slowest read" : "well under the sequential sum"})`
        : "✗ fan-out looks serialized — check for a stray sequential await",
    );

    // ── P17-25: /analysis/networth read cost ────────────────────────────────
    // ADR-039 accepted a read-time cost — roughly two `computeNetWorth` calls
    // plus a handful of aggregates per page load — and PLAN17 says to MEASURE
    // it before deciding whether it needs anything, per §Performance's "profile
    // before optimizing". Two numbers are reported rather than one: the whole
    // loader by range, and what the two endpoint computations cost on their
    // own. If the endpoints are NOT the majority, a set-based endpoint rewrite
    // — the fix ADR-039 pre-registered — would be work spent on the wrong half.
    const { loadAttribution } = await import("../src/lib/net-worth/attribution-loader.ts");
    console.log("\nloadAttribution(range) — /analysis/networth, 2 runs each");
    const attribution: Record<string, Record<string, string>> = {};
    const attributionMedians = new Map<string, number>();
    for (const range of RANGES) {
      const window = rangeWindow(range, now);
      const samples: number[] = [];
      for (let i = 0; i < 2; i++) {
        const t = performance.now();
        await loadAttribution({ from: window.from, to: window.to });
        samples.push(performance.now() - t);
      }
      const s = stats(samples);
      attributionMedians.set(range, s.median);
      attribution[range] = { from: window.from, to: window.to, min: ms(s.min), max: ms(s.max) };
    }
    console.table(attribution);

    // The two endpoints, timed in isolation and in parallel — exactly how the
    // loader issues them.
    const tEndpoints = performance.now();
    await Promise.all([
      computeNetWorth(new Date(`${w.from}T00:00:00Z`), "USD"),
      computeNetWorth(new Date(`${w.to}T00:00:00Z`), "USD"),
    ]);
    const endpointsMs = performance.now() - tEndpoints;
    const attributionAll = attributionMedians.get("ALL") ?? 0;
    console.log(
      `the two endpoint computeNetWorth calls alone: ${ms(endpointsMs)}  |  ` +
        `loadAttribution("ALL"): ${ms(attributionAll)}  |  ` +
        `endpoints are ${((endpointsMs / Math.max(attributionAll, 1)) * 100).toFixed(0)}% of it`,
    );

    // ── N+1 verdict ─────────────────────────────────────────────────────────
    const accountCount =
      INVESTMENT_ACCOUNTS + DEPOSITORY_ACCOUNTS + CREDIT_ACCOUNTS + PROPERTY_ACCOUNTS;
    const holdingCount = INVESTMENT_ACCOUNTS * HOLDINGS_PER_INVESTMENT;
    const totalQueries = Object.values(perRead).reduce((n, r) => n + r.queries, 0);
    console.log(
      `\nbook: ${accountCount} accounts, ${holdingCount} holdings, ~${DAYS} snapshot days` +
        `\ntotal queries for one full fan-out: ~${totalQueries}`,
    );
    console.log(
      totalQueries > accountCount * 10
        ? "✗ at least one read is N+1 — see the per-read table above for which"
        : "✓ query count is flat with respect to the book size",
    );
  } catch (err) {
    // Without this the `process.exit(0)` below would swallow the rejection and
    // the run would look like a silent success.
    console.error(err);
    await sql.end();
    process.exit(1);
  } finally {
    await sql.end();
    // The app's pooled client keeps the process alive otherwise.
    process.exit(0);
  }
}

await main();
