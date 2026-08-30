import "server-only";

import { db } from "@/db/client.ts";
import { accountSnapshots, accounts, holdings, liabilities, prices } from "@/db/schema/index.ts";
import { valueAccountHoldings } from "@/lib/holdings/value.ts";
import { Money, toCurrency } from "@/lib/money/money.ts";
import { balanceAtMonth } from "@/lib/mortgage/amortization.ts";
import { monthsBetween } from "@/lib/schedule/occurrences.ts";
import { and, desc, eq, gt, isNull, lte, or, sql } from "drizzle-orm";
import { halfEvenCents } from "./round.ts";

interface NetWorthLineItem {
  readonly accountId: string;
  readonly accountName: string;
  readonly accountType: string;
  readonly currency: string;
  readonly balance: Money;
}

export interface NetWorthBreakdown {
  readonly asOf: Date;
  readonly total: Money;
  readonly items: readonly NetWorthLineItem[];
}

/**
 * Compute net worth as of a given date.
 *
 * Strategy:
 *   1. For non-loan accounts: take the most-recent account_snapshots row with
 *      date <= asOf. (Empty = $0 contribution.)
 *   2. For loan accounts: compute live balance via amortization, then negate
 *      (liabilities reduce net worth).
 *
 * All values are summed in the user's base currency (defaulted to USD for
 * Phase 1 — multi-currency aggregation will pull fx_rates when needed).
 *
 * @param asOf - Snapshot timestamp. Defaults to "now".
 * @param baseCurrency - Currency to sum in. Defaults to "USD".
 */
export async function computeNetWorth(
  asOf: Date = new Date(),
  baseCurrency = "USD",
): Promise<NetWorthBreakdown> {
  const asOfIso = asOf.toISOString().slice(0, 10);
  // Exclude accounts closed on or before `asOf` (P7-04). A closed account
  // contributes $0 going forward, but historical points (asOf earlier than the
  // close) still include it — its past value stays in old chart points.
  const all = await db
    .select()
    .from(accounts)
    .where(or(isNull(accounts.closedAt), gt(accounts.closedAt, asOf)));

  const items: NetWorthLineItem[] = [];

  for (const account of all) {
    if (account.type === "loan") {
      const [liab] = await db
        .select()
        .from(liabilities)
        .where(eq(liabilities.accountId, account.id))
        .limit(1);
      if (!liab) continue;
      const remaining = balanceAtMonth(
        Money.fromString(liab.principalAtOrigination, account.currency),
        liab.annualRate,
        liab.termMonths,
        monthsBetween(liab.startDate, asOfIso),
      );
      items.push({
        accountId: account.id,
        accountName: account.name,
        accountType: account.type,
        currency: account.currency,
        balance: remaining.negate(),
      });
      continue;
    }

    // For holdings-based accounts, prefer live valuation from cached prices
    // over the last-written snapshot — gives the user the freshest possible
    // dashboard value without waiting for the nightly snapshot job.
    if (account.type === "investment" || account.type === "crypto_ira") {
      const live = await valueAccountHoldings(account.id, account.currency, asOfIso);
      if (!live.isZero()) {
        items.push({
          accountId: account.id,
          accountName: account.name,
          accountType: account.type,
          currency: account.currency,
          balance: live,
        });
        continue;
      }
      // No prices yet: fall through to the snapshot lookup so manual entries still show.
    }

    const [latest] = await db
      .select({ balance: accountSnapshots.balance, date: accountSnapshots.date })
      .from(accountSnapshots)
      .where(and(eq(accountSnapshots.accountId, account.id), lte(accountSnapshots.date, asOfIso)))
      .orderBy(desc(accountSnapshots.date))
      .limit(1);

    // Plaid-linked accounts get a zero-balance line immediately after mapping,
    // so the user can see what they just created while the initial sync runs.
    // Pure-manual accounts continue to be hidden until a balance is entered —
    // they shouldn't clutter the dashboard with empty rows.
    if (!latest) {
      if (account.plaidItemId) {
        items.push({
          accountId: account.id,
          accountName: account.name,
          accountType: account.type,
          currency: account.currency,
          balance: Money.zero(account.currency),
        });
      }
      continue;
    }

    items.push({
      accountId: account.id,
      accountName: account.name,
      accountType: account.type,
      currency: account.currency,
      balance: Money.fromString(latest.balance, account.currency),
    });
  }

  // Phase 1: all accounts assumed to be in the same baseCurrency. The Money.sum
  // throw on mismatch will fire if a multi-currency account creeps in — useful
  // as an early-warning until fx_rates plumbing arrives.
  const values = items.map((i) => i.balance);
  const total = Money.sum(
    values.filter((v) => v.currency === baseCurrency),
    baseCurrency,
  );

  return { asOf, total, items };
}

/** A dated net-worth value. `value` is a 2dp money string, never a number. */
export interface NetWorthPoint {
  readonly date: string;
  readonly value: string;
}

/** Optional inclusive date window for {@link netWorthSeries}. */
export interface NetWorthSeriesWindow {
  /** Inclusive lower bound, `YYYY-MM-DD`. Omit for "from the beginning". */
  readonly from?: string;
  /** Inclusive upper bound, `YYYY-MM-DD`. Omit for "through the end". */
  readonly to?: string;
}

/**
 * One row of the series query: an ISO date and an **unrounded** subtotal.
 *
 * A `type` rather than an `interface` because `db.execute<T>` constrains `T` to
 * `Record<string, unknown>`, which only type aliases satisfy implicitly.
 */
type SeriesRow = {
  readonly date: string;
  /** Every non-loan account's contribution, summed as exact `numeric`, as text. */
  readonly subtotal: string;
};

/** A loan account's amortization parameters, joined to the bits R1/R11 need. */
interface LoanRow {
  readonly currency: string;
  readonly closedAt: Date | null;
  readonly principalAtOrigination: string;
  readonly annualRate: string;
  readonly termMonths: number;
  readonly startDate: string;
}

/**
 * Net-worth value at each date present in `account_snapshots`, ascending.
 *
 * Backs the dashboard's history chart and its range delta. One point per
 * distinct snapshot date, so the chart works without the nightly job having
 * pre-populated every calendar day.
 *
 * ## The contract this reproduces
 *
 * This is a set-based rewrite of what used to be a `computeNetWorth`-per-date
 * loop (98k queries / 85 s on a three-year book — see
 * [PLAN_NETWORTH_SERIES.md](../../../plans/features/PLAN_NETWORTH_SERIES.md)).
 * The numbers are unchanged by design, which means the query has to honor every
 * rule {@link computeNetWorth} applies. For each date **D**:
 *
 *  1. Only accounts **open at D** count: `closed_at IS NULL OR closed_at > D`,
 *     where D is midnight **UTC** (not the server's timezone — hence the
 *     explicit `AT TIME ZONE 'UTC'`).
 *  2. A `loan` contributes `-balanceAtMonth(...)` from its `liabilities` row.
 *     A loan **without** one contributes nothing at all — it is skipped, not
 *     zeroed — and a loan **never** reads `account_snapshots`, even though the
 *     nightly job writes rows for it.
 *  3. `investment` / `crypto_ira` prefer a **live** valuation: the sum over the
 *     account's holdings, where a `cash`/`property` holding is its `quantity` at
 *     face (**unrounded**) and any other holding is `round₂(quantity × close)`
 *     using the latest `prices` row on or before D — **rounded per holding
 *     before summing**, half-even (see {@link halfEvenCents}). An unpriced
 *     holding contributes exactly 0.
 *  4. If that live total is **exactly zero**, the account falls through to the
 *     snapshot path (covers "no holdings yet" and "no prices yet").
 *  5. Every other type takes the most recent `account_snapshots.balance` with
 *     `date <= D`; no snapshot at all contributes nothing.
 *  6. Accounts whose currency is not `baseCurrency` are excluded from the total.
 *  7. The total is rounded to cents **once, at the end**.
 *
 * Two rules from `computeNetWorth` are deliberately absent because they cannot
 * change a total: the explicit `0.00` line a Plaid-linked account gets when it
 * has no snapshot, and the `items[]` breakdown itself.
 *
 * **Known wart, preserved on purpose**: historical points value holdings at
 * **today's** quantity against that day's price. `holding_snapshots` records the
 * true historical quantity, so this is fixable — but it changes displayed
 * history, so it needs its own ADR rather than a silent ride-along in a
 * performance change.
 *
 * @param baseCurrency - Currency to sum in. Accounts in any other currency are
 *   excluded from the total. Defaults to `"USD"`.
 * @param window - Optional inclusive `{from, to}` date bounds. Clips **which
 *   dates are returned**, never how a point is computed: the lookbacks still
 *   reach back before `from` for the latest snapshot and price.
 * @returns Ascending points, one per distinct in-window snapshot date.
 */
export async function netWorthSeries(
  baseCurrency = "USD",
  window?: NetWorthSeriesWindow,
): Promise<NetWorthPoint[]> {
  const from = window?.from ?? null;
  const to = window?.to ?? null;

  // `upper(trim(...))` mirrors `toCurrency()`, which normalizes an account's
  // stored currency before it is compared with the (raw) base currency —
  // so "usd" in the DB still sums into a "USD" total, exactly as before.
  const currencyMatches = sql`upper(trim(${accounts.currency})) = ${baseCurrency}`;

  const rows = await db.execute<SeriesRow>(sql`
    WITH spine AS (
      -- The date axis: every distinct snapshot date inside the window.
      SELECT DISTINCT ${accountSnapshots.date} AS d
      FROM ${accountSnapshots}
      WHERE (${from}::date IS NULL OR ${accountSnapshots.date} >= ${from}::date)
        AND (${to}::date   IS NULL OR ${accountSnapshots.date} <= ${to}::date)
    ),
    open_acct AS (
      -- Rule 1 + rule 6. Loans are excluded here and handled in TypeScript,
      -- which is also what gives us rule 2's "never reads snapshots" for free.
      SELECT s.d, ${accounts.id} AS id, ${accounts.type} AS type
      FROM spine s
      JOIN ${accounts}
        ON ${currencyMatches}
       AND ${accounts.type} <> 'loan'
       AND (${accounts.closedAt} IS NULL
            OR ${accounts.closedAt} > (s.d::timestamp AT TIME ZONE 'UTC'))
    ),
    priced AS (
      -- Rule 3, before rounding. A missing price leaves the raw value NULL.
      SELECT o.d, o.id, ${holdings.assetClass} AS asset_class,
             CASE WHEN ${holdings.assetClass} IN ('cash', 'property')
                  THEN ${holdings.quantity}
                  ELSE ${holdings.quantity} * p.close
             END AS raw
      FROM open_acct o
      JOIN ${holdings} ON ${holdings.accountId} = o.id
      LEFT JOIN LATERAL (
        SELECT pr.close
        FROM ${prices} pr
        WHERE pr.symbol = ${holdings.symbol} AND pr.date <= o.d
        ORDER BY pr.date DESC
        LIMIT 1
      ) p ON TRUE
      WHERE o.type IN ('investment', 'crypto_ira')
    ),
    live AS (
      -- Rule 3's ordering: round each priced holding to cents, THEN sum.
      -- cash/property go in at full precision and are never rounded here.
      SELECT d, id,
             SUM(CASE WHEN asset_class IN ('cash', 'property') THEN raw
                      WHEN raw IS NULL THEN 0
                      ELSE ${halfEvenCents(sql`raw`)}
                 END) AS value
      FROM priced
      GROUP BY d, id
    ),
    snap AS (
      -- Rule 5: the latest balance on or before D, per account.
      SELECT o.d, o.id, s.balance
      FROM open_acct o
      LEFT JOIN LATERAL (
        SELECT sn.balance
        FROM ${accountSnapshots} sn
        WHERE sn.account_id = o.id AND sn.date <= o.d
        ORDER BY sn.date DESC
        LIMIT 1
      ) s ON TRUE
    ),
    contrib AS (
      SELECT o.d,
             CASE WHEN o.type IN ('investment', 'crypto_ira')
                  -- NULLIF is rule 4: a live total of exactly zero (or an
                  -- account with no holdings at all, where "live" has no row)
                  -- falls through to the snapshot.
                  THEN COALESCE(NULLIF(l.value, 0), sn.balance, 0)
                  ELSE COALESCE(sn.balance, 0)
             END AS amount
      FROM open_acct o
      LEFT JOIN live l ON l.d = o.d AND l.id = o.id
      LEFT JOIN snap sn ON sn.d = o.d AND sn.id = o.id
    )
    SELECT to_char(sp.d, 'YYYY-MM-DD') AS date,
           -- Unrounded on purpose: loans are still to be folded in, and rule 7
           -- rounds once, in TypeScript, where decimal.js owns the arithmetic.
           -- The outer COALESCE keeps a date on which nothing has value yet.
           COALESCE(SUM(c.amount), 0)::text AS subtotal
    FROM spine sp
    LEFT JOIN contrib c ON c.d = sp.d
    GROUP BY sp.d
    ORDER BY sp.d
  `);

  // Rule 2. Loans are a closed-form computation per date, not a lookup, so they
  // stay in TypeScript with `Money` — one read, then pure math per point.
  const loans: LoanRow[] = await db
    .select({
      currency: accounts.currency,
      closedAt: accounts.closedAt,
      principalAtOrigination: liabilities.principalAtOrigination,
      annualRate: liabilities.annualRate,
      termMonths: liabilities.termMonths,
      startDate: liabilities.startDate,
    })
    .from(liabilities)
    .innerJoin(accounts, eq(accounts.id, liabilities.accountId))
    .where(eq(accounts.type, "loan"));

  const inBase = loans.filter((l) => toCurrency(l.currency) === baseCurrency);

  const points: NetWorthPoint[] = [];
  for (const row of rows) {
    const asOf = new Date(`${row.date}T00:00:00Z`);
    let total = Money.fromString(row.subtotal, baseCurrency);
    for (const loan of inBase) {
      if (loan.closedAt !== null && loan.closedAt <= asOf) continue;
      const remaining = balanceAtMonth(
        Money.fromString(loan.principalAtOrigination, loan.currency),
        loan.annualRate,
        loan.termMonths,
        monthsBetween(loan.startDate, row.date),
      );
      total = total.add(remaining.negate());
    }
    points.push({ date: row.date, value: total.toString() });
  }
  return points;
}
