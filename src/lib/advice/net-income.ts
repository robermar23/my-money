import "server-only";

import { db } from "@/db/client.ts";
import { categories, transactions } from "@/db/schema/index.ts";
import { enumerateMonths } from "@/lib/analytics/range.ts";
import { Money } from "@/lib/money/money.ts";
import { and, eq, gte, lte, sql } from "drizzle-orm";
import { medianMoney } from "./statistics.ts";

/**
 * Observed net income — the take-home figure every household benchmark is
 * stated against (Phase 15, PLAN15 P15-08, ADR-034 §1).
 *
 * ── Why "observed" ─────────────────────────────────────────────────────────
 * ADR-030 stores income as **gross per period** and deliberately says nothing
 * about taxes. Nearly every household benchmark ("keep 3–6 months of expenses",
 * "50/30/20 of take-home") is stated against take-home, so Phase 15 needs a net
 * figure — and it gets one without a single line of tax math: **the deposits
 * that actually landed ARE take-home.** Sum `transactions` in `kind='income'`
 * categories. ADR-030's gross-only boundary is untouched, and CLAUDE.md's
 * §Domain Scope ban on a tax engine is never approached.
 *
 * Transfers can never pollute this: `categories.kind='transfer'` is a third,
 * separate value, so filtering to `kind='income'` excludes card payments, WEB
 * XFER and internal P2P by construction — the same guarantee
 * [spending.ts](../analytics/spending.ts) relies on. There is no heuristic here
 * to get wrong.
 *
 * ── Auditability over cleverness ───────────────────────────────────────────
 * A bonus, a tax refund, or a reimbursement inflates take-home and every
 * benchmark measured against it. We do **not** filter outliers heuristically.
 * Instead this returns `contributingCategories` — **including the ones already
 * excluded** — so the UI can list them and the user can flip
 * `excluded_from_baseline` on the ones that aren't really income (ADR-034 §1).
 * That is the same philosophy as rendering each recommendation's `inputsUsed[]`:
 * a wrong number must point at a correctable input.
 *
 * The trailing **median** (ADR-034 §3) is the second line of defence: a single
 * bonus month barely moves it, where a mean would carry the bonus into every
 * downstream target for a year.
 *
 * ── ADR-034 §2: this is NOT a second savings rate ──────────────────────────
 * Exactly one savings rate exists — the shipped gross-based figure from
 * [savings-rate.ts](../income/savings-rate.ts). Observed net is used only as the
 * 50/30/20 denominator (P15-26) and as a reserve input, **under a different
 * name**, precisely so two disagreeing rates never appear on one screen.
 *
 * Money discipline (CLAUDE.md §Money): sums happen in SQL over `numeric`,
 * results are carried as strings and combined only through {@link Money}.
 */

const CURRENCY = "USD";

/** One month's observed net income. */
export interface NetIncomeMonth {
  /** `YYYY-MM`. */
  readonly month: string;
  /**
   * Net magnitude for the month (positive = money in). Can go negative in a
   * month dominated by a clawback or a returned deposit — that is the correct
   * net, and clamping it would hide a real event.
   */
  readonly amount: string;
}

/** An income category that fed (or was withheld from) the baseline. */
export interface ContributingCategory {
  readonly categoryId: string;
  readonly name: string;
  /** Total over the whole window, as a money string. */
  readonly total: string;
  /**
   * True when `categories.excluded_from_baseline` is set — the row is listed so
   * the UI can show *what was left out* and offer to put it back, not just what
   * was counted.
   */
  readonly excluded: boolean;
}

export interface ObservedNetIncome {
  /** Gap-free ascending monthly series across the whole window. */
  readonly monthly: readonly NetIncomeMonth[];
  /**
   * Median of the months from first observed income onward, or `null` when no
   * income was observed at all. **Never `"0.00"` for "no data"** — a zero
   * take-home would make every downstream benchmark silently wrong.
   */
  readonly trailingMedian: string | null;
  /** Every `kind='income'` category with activity in the window, excluded ones included. */
  readonly contributingCategories: readonly ContributingCategory[];
  /** Months actually behind the median (leading empty months dropped). */
  readonly basisMonths: number;
  /** Sum over the whole window of the non-excluded categories. */
  readonly windowTotal: string;
  readonly window: { readonly from: string; readonly to: string };
}

/** One `(month, category)` bucket as the SQL below returns it. */
export interface NetIncomeRow {
  /** `YYYY-MM`. */
  readonly month: string;
  readonly categoryId: string;
  readonly categoryName: string;
  readonly excludedFromBaseline: boolean;
  /** Signed SQL `sum(amount)`. Income is stored positive (OFX inflow). */
  readonly sum: string;
}

/**
 * The pure core: fold `(month, category)` buckets into the monthly series, the
 * trailing median and the contributing-category list.
 *
 * Separated from the query so the whole of ADR-034 §1 is unit-testable without a
 * database (ADR-032 §1). {@link observedNetIncome} is the thin DB wrapper.
 *
 * @param rows - `(month, category)` sums, already filtered to `kind='income'`.
 * @param window - The inclusive `{from, to}` the rows were selected over.
 * @returns The monthly series, median, and contributing categories.
 */
export function computeObservedNetIncome(
  rows: readonly NetIncomeRow[],
  window: { readonly from: string; readonly to: string },
): ObservedNetIncome {
  // Seed every month in range so the series is continuous — a month with no
  // paycheck is a real, meaningful zero, not a gap to be skipped.
  const byMonth = new Map<string, Money>();
  for (const month of enumerateMonths(window.from, window.to)) {
    byMonth.set(month, Money.zero(CURRENCY));
  }

  const byCategory = new Map<string, { name: string; total: Money; excluded: boolean }>();

  for (const row of rows) {
    const amount = Money.fromString(row.sum, CURRENCY);

    const category = byCategory.get(row.categoryId) ?? {
      name: row.categoryName,
      total: Money.zero(CURRENCY),
      excluded: row.excludedFromBaseline,
    };
    category.total = category.total.add(amount);
    byCategory.set(row.categoryId, category);

    // Excluded categories are reported but never counted (ADR-034 §1).
    if (row.excludedFromBaseline) continue;
    byMonth.set(row.month, (byMonth.get(row.month) ?? Money.zero(CURRENCY)).add(amount));
  }

  const monthly: NetIncomeMonth[] = [...byMonth.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([month, amount]) => ({ month, amount: amount.toString() }));

  // Drop the LEADING run of zero months only. A freshly-imported history that
  // starts mid-window must not drag the median toward zero; a zero month *after*
  // income began is a real gap (a job change) and stays in the window. Same rule
  // as forecast.ts, for the same reason.
  const firstActive = monthly.findIndex((m) => !Money.fromString(m.amount, CURRENCY).isZero());
  const basis = firstActive === -1 ? [] : monthly.slice(firstActive);

  const contributingCategories: ContributingCategory[] = [...byCategory.entries()]
    .map(([categoryId, c]) => ({
      categoryId,
      name: c.name,
      total: c.total.toString(),
      excluded: c.excluded,
    }))
    .sort((a, b) => (a.name < b.name ? -1 : 1));

  const windowTotal = Money.sum(
    basis.map((m) => Money.fromString(m.amount, CURRENCY)),
    CURRENCY,
  );

  return {
    monthly,
    trailingMedian: medianMoney(basis.map((m) => m.amount)),
    contributingCategories,
    basisMonths: basis.length,
    windowTotal: windowTotal.toString(),
    window,
  };
}

/**
 * Observed net income over a window (P15-08).
 *
 * Reads `transactions` joined to `categories` where `kind='income'`, buckets by
 * calendar month, and hands the rows to {@link computeObservedNetIncome}.
 *
 * Excluded categories are fetched (so they can be *listed*) and then dropped
 * from the totals — filtering them in SQL would make them invisible, which is
 * exactly the opposite of what ADR-034 §1 asks for.
 *
 * @param window - Inclusive `{from, to}` ISO dates.
 * @returns The monthly series, trailing median, and contributing categories.
 */
export async function observedNetIncome(window: {
  readonly from: string;
  readonly to: string;
}): Promise<ObservedNetIncome> {
  const monthExpr = sql<string>`to_char(date_trunc('month', ${transactions.postedAt}), 'YYYY-MM')`;

  const rows = await db
    .select({
      month: monthExpr,
      categoryId: categories.id,
      categoryName: categories.name,
      excludedFromBaseline: categories.excludedFromBaseline,
      sum: sql<string>`sum(${transactions.amount})`,
    })
    .from(transactions)
    .innerJoin(categories, eq(transactions.categoryId, categories.id))
    .where(
      and(
        gte(transactions.postedAt, window.from),
        lte(transactions.postedAt, window.to),
        eq(categories.kind, "income"),
      ),
    )
    .groupBy(monthExpr, categories.id, categories.name, categories.excludedFromBaseline);

  return computeObservedNetIncome(rows, window);
}
