import "server-only";

import { db } from "@/db/client.ts";
import type { CategoryKind } from "@/db/schema/categories.ts";
import {
  accountSnapshots,
  accounts,
  categories,
  holdingSnapshots,
  holdings,
  investmentTransactions,
  liabilities,
  transactions,
} from "@/db/schema/index.ts";
import { and, desc, eq, gte, inArray, lte, min } from "drizzle-orm";
import { computeNetWorth } from "./compute.ts";
import type { AmortizingLiability } from "./debt-principal.ts";
import { type DecomposeInput, decomposeNetWorth } from "./decompose.ts";
import type { DiagnosticAccount, DiagnosticInvestmentTxn, HoldingQuantity } from "./diagnostics.ts";
import type { EndpointBreakdown } from "./endpoints.ts";
import { endpointsFor } from "./endpoints.ts";
import type { FlowTxn } from "./flow-types.ts";
import type { PairingOptions } from "./pairing.ts";
import type { AttributionResult } from "./types.ts";

/**
 * The attribution layer's one and only DB-reading function (P17-19, ADR-032 §1).
 *
 * Mirrors `loadFinancialSnapshot` and `loadCashFlow`: this reads, everything
 * downstream is pure. The engine modules — [endpoints](./endpoints.ts),
 * [pairing](./pairing.ts), [saved](./saved.ts), [retirement](./retirement.ts),
 * [debt-principal](./debt-principal.ts),
 * [investment-return](./investment-return.ts),
 * [asset-revaluation](./asset-revaluation.ts), [diagnostics](./diagnostics.ts),
 * [status](./status.ts), [summary](./summary.ts) — take rows and give numbers
 * back, and this is the only place in the phase that knows Postgres exists.
 *
 * ── Every query, and what it feeds ─────────────────────────────────────────
 * Listed so a future performance pass knows what it is allowed to drop, and
 * — more importantly — what dropping it would silently cost. A read removed
 * from here does not fail: it moves money into `unexplained`, which is the one
 * failure mode this phase is built to make visible rather than to commit.
 *
 *   1. `computeNetWorth(from)`  → the opening endpoint. **Not droppable.** It is
 *      the ADR-039 §1 anchor; without it there is no delta to explain.
 *   2. `computeNetWorth(to)`    → the closing endpoint. Same.
 *   3. accounts + a liability-existence flag → `DiagnosticAccount[]`, feeding
 *      the `untracked_loan` and `manual_balance_accounts` diagnostics. Dropping
 *      it loses the *names* of the residual's causes, not the residual.
 *   4. per-account latest snapshot on or before `from`  ─┐ both feed the
 *   5. per-account latest snapshot on or before `to`    ─┘ `snapshot_gap`
 *      diagnostic. Two reads rather than one so a stale account is detected at
 *      the end it is stale at.
 *   6. `min(account_snapshots.date)` → the degradation ladder (P17-14). One
 *      scalar; the cheapest read here and the one that decides whether the page
 *      may state a figure at all.
 *   7. transactions in the window, LEFT JOIN categories for `kind` → the
 *      pairer, the boundary classifier, the `saved` rung, and the
 *      `uncategorized`/`unpaired_transfers` diagnostics. The largest read on
 *      the page and the one a performance pass will reach for first: note that
 *      narrowing it moves real money out of `saved` and into the residual.
 *   8. investment transactions in the window → the retirement rung (ADR-041 §3),
 *      the market rung's flow subtraction (ADR-041 §4), and the
 *      `unmatched_investment_deposits` diagnostic.
 *   9. liabilities joined to their loan accounts → the debt-principal rung.
 *  10. holdings + their snapshot rows on the opening date → the ADR-039 §2
 *      quantity-drift diagnostic. The only read here that exists purely to
 *      confess a known limitation, and therefore the only one whose removal
 *      makes the app *less honest* without making any figure wrong.
 *
 * ── The window is the caller's, and it is passed through unchanged ─────────
 * `resolveRange` already owns what "last 12 months" means across `/analysis`
 * (P8-13). Re-deriving a window here would give the attribution page a range
 * that could disagree with the range selector sitting above it — the same class
 * of second-source-of-truth bug ADR-039 §1 rejects for the endpoints themselves.
 *
 * ── Sequencing: the two endpoints run in parallel, the rest in one batch ────
 * `computeNetWorth` issues a query per loan account, so the two endpoint calls
 * are the expensive half. They are independent of each other and of every row
 * read below, so everything runs concurrently. Nothing here writes.
 *
 * ── Privacy ────────────────────────────────────────────────────────────────
 * Zero egress. No network call, no `console` — every row this touches is the
 * household's real money and real vendor names (CLAUDE.md §Privacy).
 */

const CURRENCY = "USD";

/** The window to explain. Inclusive at both ends, `YYYY-MM-DD`. */
export interface AttributionRange {
  readonly from: string;
  readonly to: string;
}

/** Knobs a caller may set; every one has a shipped default. */
export interface LoadAttributionOptions {
  /** Transfer-pairing tolerances. Defaults to `DEFAULT_PAIRING` (ADR-040 §2). */
  readonly pairing?: PairingOptions;
  /** Currency to compute in. Single-currency app; USD. */
  readonly currency?: string;
}

/**
 * Load every input the decomposition needs and run it.
 *
 * @param range - Inclusive window, normally straight from `resolveRange`.
 * @param options - Pairing tolerances and currency. Both default.
 * @returns The full six-rung decomposition, its diagnostics, and its status.
 * @throws If the window runs backwards — the engine's shared `assertWindow`
 *   guard, reached before any figure is rendered.
 */
export async function loadAttribution(
  range: AttributionRange,
  options: LoadAttributionOptions = {},
): Promise<AttributionResult> {
  const currency = options.currency ?? CURRENCY;

  const [
    openingBreakdown,
    closingBreakdown,
    accountRows,
    openingSnapshots,
    closingSnapshots,
    firstSnapshotDate,
    txns,
    investmentTxns,
    liabilityRows,
    holdingRows,
  ] = await Promise.all([
    endpointBreakdown(range.from, currency),
    endpointBreakdown(range.to, currency),
    listAccounts(),
    latestSnapshotOnOrBefore(range.from),
    latestSnapshotOnOrBefore(range.to),
    earliestSnapshotDate(),
    listWindowTransactions(range),
    listWindowInvestmentTransactions(range),
    listAmortizingLiabilities(),
    listHoldingQuantities(range.from),
  ]);

  const openingByAccount = new Map(openingSnapshots.map((s) => [s.accountId, s.date]));
  const closingByAccount = new Map(closingSnapshots.map((s) => [s.accountId, s.date]));

  const diagnosticAccounts: DiagnosticAccount[] = accountRows.map((a) => ({
    accountId: a.id,
    accountName: a.name,
    accountType: a.type,
    hasLiabilityRow: a.hasLiabilityRow,
    openingSnapshotDate: openingByAccount.get(a.id) ?? null,
    closingSnapshotDate: closingByAccount.get(a.id) ?? null,
  }));

  const input: DecomposeInput = {
    endpoints: endpointsFor(openingBreakdown, closingBreakdown, currency),
    accounts: diagnosticAccounts,
    txns,
    liabilities: liabilityRows,
    investmentTxns,
    holdings: holdingRows,
    firstSnapshotDate,
    ...(options.pairing !== undefined ? { pairing: options.pairing } : {}),
    currency,
  };

  return decomposeNetWorth(input);
}

/**
 * One endpoint, flattened from `computeNetWorth` to the engine's string shape.
 *
 * `total` is copied verbatim and `items` are never re-summed (ADR-039 §1): the
 * whole point of anchoring is that this page and the dashboard chart cannot
 * disagree, and a second summation here is exactly how they would.
 *
 * The `Date` is built as `T00:00:00Z` to match `series-parity.test.ts` — the
 * test that proves `computeNetWorth` and `netWorthSeries` agree. A different
 * construction here would be a third convention, and the parity proof would no
 * longer cover the number this page draws.
 */
async function endpointBreakdown(date: string, currency: string): Promise<EndpointBreakdown> {
  const breakdown = await computeNetWorth(new Date(`${date}T00:00:00Z`), currency);
  return {
    asOf: date,
    total: breakdown.total.toString(),
    items: breakdown.items.map((i) => ({
      accountId: i.accountId,
      accountName: i.accountName,
      accountType: i.accountType,
      currency: i.currency,
      balance: i.balance.toString(),
    })),
  };
}

/**
 * Every account on the book, with whether a `liabilities` row exists.
 *
 * Closed accounts are included deliberately. `computeNetWorth` drops an account
 * closed before the as-of date, so a mid-window closure shows as a `'closed'`
 * presence in the endpoints — and the diagnostics need the row to be able to
 * name it. Filtering here would leave the residual with a cause it cannot say
 * out loud.
 */
async function listAccounts(): Promise<
  { id: string; name: string; type: string; hasLiabilityRow: boolean }[]
> {
  const rows = await db
    .select({
      id: accounts.id,
      name: accounts.name,
      type: accounts.type,
      liabilityId: liabilities.id,
    })
    .from(accounts)
    .leftJoin(liabilities, eq(liabilities.accountId, accounts.id));

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    type: r.type,
    hasLiabilityRow: r.liabilityId !== null,
  }));
}

/**
 * Per account, the newest snapshot date on or before `date`.
 *
 * `DISTINCT ON` rather than a per-account query, and "on or before" rather than
 * "on", because that is precisely the rule `computeNetWorth` values an account
 * by (compute.ts rule 1). A stricter read here would report a gap the net-worth
 * figure does not actually have.
 */
async function latestSnapshotOnOrBefore(
  date: string,
): Promise<{ accountId: string; date: string }[]> {
  return db
    .selectDistinctOn([accountSnapshots.accountId], {
      accountId: accountSnapshots.accountId,
      date: accountSnapshots.date,
    })
    .from(accountSnapshots)
    .where(lte(accountSnapshots.date, date))
    .orderBy(accountSnapshots.accountId, desc(accountSnapshots.date));
}

/** The book's earliest snapshot, or `null` on a fresh install. Drives P17-14. */
async function earliestSnapshotDate(): Promise<string | null> {
  const [row] = await db.select({ earliest: min(accountSnapshots.date) }).from(accountSnapshots);
  return row?.earliest ?? null;
}

/**
 * Posted transactions in the window, with `categories.kind` joined.
 *
 * The join is the loader's job by design (ADR-040 §6): the classifiers must not
 * know that `categories` is a table, and a `LEFT JOIN` is what makes
 * "uncategorized" arrive as an honest `null` rather than as a lookup that
 * quietly failed.
 */
async function listWindowTransactions(range: AttributionRange): Promise<FlowTxn[]> {
  const rows = await db
    .select({
      id: transactions.id,
      accountId: transactions.accountId,
      postedAt: transactions.postedAt,
      amount: transactions.amount,
      name: transactions.name,
      categoryId: transactions.categoryId,
      categoryKind: categories.kind,
    })
    .from(transactions)
    .leftJoin(categories, eq(categories.id, transactions.categoryId))
    .where(and(gte(transactions.postedAt, range.from), lte(transactions.postedAt, range.to)))
    .orderBy(transactions.postedAt, transactions.id);

  return rows.map((r) => ({
    id: r.id,
    accountId: r.accountId,
    postedAt: r.postedAt,
    amount: r.amount,
    name: r.name,
    categoryId: r.categoryId,
    // `kind` is a plain text column with a CHECK; the enum lives in TS. The cast
    // is the one place that boundary is crossed, and it is crossed here rather
    // than inside a rule so no classifier ever has to know the column's shape.
    categoryKind: (r.categoryKind as CategoryKind | null) ?? null,
  }));
}

/**
 * Investment transactions in the window, `source` included.
 *
 * `source` matters twice over: ADR-041 §3 scopes the retirement rung to
 * `'income'` rows so payroll-direct contributions cancel the market rung's flow
 * subtraction by construction, and the unmatched-deposit diagnostic exempts the
 * same rows so a correctly-recorded 401(k) contribution is never reported as a
 * data problem.
 */
async function listWindowInvestmentTransactions(
  range: AttributionRange,
): Promise<DiagnosticInvestmentTxn[]> {
  const rows = await db
    .select({
      accountId: investmentTransactions.accountId,
      type: investmentTransactions.type,
      subtype: investmentTransactions.subtype,
      amount: investmentTransactions.amount,
      date: investmentTransactions.tradeDate,
      source: investmentTransactions.source,
    })
    .from(investmentTransactions)
    .where(
      and(
        gte(investmentTransactions.tradeDate, range.from),
        lte(investmentTransactions.tradeDate, range.to),
      ),
    )
    .orderBy(investmentTransactions.tradeDate);

  return rows.map((r) => ({
    accountId: r.accountId,
    type: r.type,
    subtype: r.subtype,
    amount: r.amount,
    date: r.date,
    source: r.source,
  }));
}

/**
 * Every loan with recorded terms.
 *
 * A loan *without* a `liabilities` row is deliberately absent rather than
 * zeroed: `computeNetWorth` skips it at both endpoints, so it is missing from
 * the anchor too, and the pair stays consistent. The `untracked_loan`
 * diagnostic is what names it, from query 3.
 */
async function listAmortizingLiabilities(): Promise<AmortizingLiability[]> {
  const rows = await db
    .select({
      accountId: liabilities.accountId,
      name: liabilities.name,
      principalAtOrigination: liabilities.principalAtOrigination,
      annualRate: liabilities.annualRate,
      termMonths: liabilities.termMonths,
      startDate: liabilities.startDate,
    })
    .from(liabilities)
    .orderBy(liabilities.accountId);

  return rows.map((r) => ({
    accountId: r.accountId,
    name: r.name,
    principalAtOrigination: r.principalAtOrigination,
    annualRate: r.annualRate,
    termMonths: r.termMonths,
    startDate: r.startDate,
  }));
}

/**
 * Every position's current share count beside its count at the window's start.
 *
 * Opening figures use the newest `holding_snapshots` row on or before `from`,
 * the same "on or before" rule as the account snapshots — the nightly job
 * writes daily, so on a running install this *is* the opening date, and on a
 * box that was switched off for a week it is the closest recorded truth rather
 * than a `null` that would read as "never recorded".
 *
 * `null` survives as `null` where nothing was ever recorded, because ADR-039 §2
 * is confessed rather than papered over: a position with no opening count means
 * the app cannot tell whether the shares moved, which is a different statement
 * from knowing they did not.
 */
async function listHoldingQuantities(from: string): Promise<HoldingQuantity[]> {
  const current = await db
    .select({
      holdingId: holdings.id,
      symbol: holdings.symbol,
      accountId: holdings.accountId,
      quantity: holdings.quantity,
    })
    .from(holdings)
    .orderBy(holdings.id);

  if (current.length === 0) return [];

  const opening = await db
    .selectDistinctOn([holdingSnapshots.holdingId], {
      holdingId: holdingSnapshots.holdingId,
      quantity: holdingSnapshots.quantity,
      value: holdingSnapshots.value,
    })
    .from(holdingSnapshots)
    .where(
      and(
        inArray(
          holdingSnapshots.holdingId,
          current.map((h) => h.holdingId),
        ),
        lte(holdingSnapshots.date, from),
      ),
    )
    .orderBy(holdingSnapshots.holdingId, desc(holdingSnapshots.date));

  const openingById = new Map(opening.map((o) => [o.holdingId, o]));

  return current.map((h) => {
    const before = openingById.get(h.holdingId);
    return {
      holdingId: h.holdingId,
      symbol: h.symbol,
      accountId: h.accountId,
      openingQuantity: before?.quantity ?? null,
      openingValue: before?.value ?? null,
      currentQuantity: h.quantity,
    };
  });
}
