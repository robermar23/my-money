import "server-only";

import { db } from "@/db/client.ts";
import { categories, transactions } from "@/db/schema/index.ts";
import { enumerateMonths } from "@/lib/analytics/range.ts";
import { Money } from "@/lib/money/money.ts";
import { and, eq, gte, isNull, lte, sql } from "drizzle-orm";
import { medianMoney, shareOf } from "./statistics.ts";

/**
 * The essential monthly expense baseline — what the household would still spend
 * if money got tight (Phase 15, PLAN15 P15-09, ADR-033 §2 + ADR-034 §3).
 *
 * This is the single most load-bearing number in the phase. The emergency fund
 * sizes against it, the cash tiers are expressed in months of it, and the
 * waterfall's reserve rung is 3–6 × it. Getting it wrong by including a vacation
 * hands the user a target they will never hit; getting it wrong by excluding
 * rent hands them a reserve that runs out.
 *
 * ── Two components ─────────────────────────────────────────────────────────
 *   1. The trailing **MEDIAN** of monthly `necessity='essential'` spend. Median
 *      not mean, per ADR-034 §3 — one $2,000 transmission repair should not
 *      permanently inflate the reserve target.
 *   2. **Plus minimum debt service**, passed in by the caller from
 *      {@link ../advice/debt-terms.ts unifyDebtTerms}. A mortgage payment is as
 *      essential as it gets, but it lives in `liabilities`/`credit_lines`, not
 *      in a spend category, so it would otherwise be invisible here.
 *
 * ── Honesty about what we could not see ────────────────────────────────────
 * `necessity` is nullable and starts empty (ADR-033 §2 — deliberately not
 * backfilled with a default). Until the user classifies, this baseline is LOW.
 * That is not a bug to be papered over with a guess, it is a fact to be
 * reported: `unclassifiedShare` exists so the UI can say *"18% of your spend is
 * unclassified; this estimate is low"* and link to the classifier (P15-31).
 *
 * "Unclassified" here means **both** of the app's two blind spots, because they
 * are equally invisible to a necessity-based sum:
 *   - `kind='expense'` transactions whose category has `necessity IS NULL`, and
 *   - transactions with **no category at all** (`category_id IS NULL`), which
 *     [spendingSummary](../analytics/spending.ts) already surfaces as the
 *     review-queue nudge.
 *
 * Money discipline (CLAUDE.md §Money): SQL sums over `numeric`, carried as
 * strings, combined only through {@link Money}. The one `Number()` is
 * `unclassifiedShare`, which is a display ratio and not a money value.
 */

const CURRENCY = "USD";

/** The necessity buckets, plus the "we could not tell" bucket. */
export type NecessityBucket = "essential" | "discretionary" | "savings" | "unclassified";

/** One month, split across the necessity buckets. All positive magnitudes. */
export interface EssentialMonth {
  /** `YYYY-MM`. */
  readonly month: string;
  readonly essential: string;
  readonly discretionary: string;
  readonly savings: string;
  /** Categorized-but-unclassified spend PLUS uncategorized outflow. */
  readonly unclassified: string;
  /** Sum of the four buckets. */
  readonly total: string;
}

export interface EssentialBaseline {
  /** Gap-free ascending monthly series across the whole window. */
  readonly monthly: readonly EssentialMonth[];
  /**
   * Median monthly `essential` spend, or `null` when there is no expense history
   * at all. `"0.00"` and `null` are different answers: zero means "we looked and
   * found no essential spend" (usually: nothing is classified yet), `null` means
   * "there were no months to look at."
   */
  readonly trailingMedian: string | null;
  /** Minimum debt service folded in by the caller (default `"0.00"`). */
  readonly minimumDebtService: string;
  /**
   * `trailingMedian + minimumDebtService` — THE essential monthly figure every
   * downstream rule consumes. `null` whenever `trailingMedian` is `null`: a
   * reserve target built on zero months of history is precisely the confident
   * wrong number ADR-032 exists to prevent, so we decline to emit one.
   */
  readonly baseline: string | null;
  /** Unclassified expense over the window, as a money string. */
  readonly unclassifiedExpense: string;
  /** All expense over the window, as a money string. */
  readonly totalExpense: string;
  /** `unclassifiedExpense / totalExpense` in [0, 1]. `0` when there is no spend. */
  readonly unclassifiedShare: number;
  /** Months actually behind the median (leading empty months dropped). */
  readonly basisMonths: number;
  readonly window: { readonly from: string; readonly to: string };
}

/** One `(month, bucket)` sum as the SQL below returns it. */
export interface EssentialExpenseRow {
  /** `YYYY-MM`. */
  readonly month: string;
  readonly bucket: NecessityBucket;
  /**
   * Signed SQL `sum(amount)`. Outflows are stored negative (OFX), so this is
   * normally negative and is negated into a magnitude here — the same
   * convention as `magnitude()` in [spending.ts](../analytics/spending.ts).
   */
  readonly sum: string;
}

export interface EssentialBaselineOptions {
  /**
   * Total minimum monthly debt service, from
   * {@link ../advice/debt-terms.ts totalMinimumDebtService}. Defaults to `"0"` —
   * a household with no recorded debt terms, not an assertion that they have no
   * debt. The caller that *knows* terms are missing surfaces that separately.
   */
  readonly minimumDebtService?: string;
}

/**
 * The pure core: fold `(month, bucket)` sums into the monthly series, the
 * essential median, and the unclassified share.
 *
 * Separated from the query so the whole of ADR-034 §3 is unit-testable without a
 * database (ADR-032 §1). {@link essentialMonthlyBaseline} is the DB wrapper.
 *
 * @param rows - `(month, bucket)` signed sums over expense transactions.
 * @param window - The inclusive `{from, to}` the rows were selected over.
 * @param options - Minimum debt service to fold into the baseline.
 * @returns The monthly split, the median, the baseline, and the unclassified share.
 */
export function computeEssentialBaseline(
  rows: readonly EssentialExpenseRow[],
  window: { readonly from: string; readonly to: string },
  options: EssentialBaselineOptions = {},
): EssentialBaseline {
  const empty = () => ({
    essential: Money.zero(CURRENCY),
    discretionary: Money.zero(CURRENCY),
    savings: Money.zero(CURRENCY),
    unclassified: Money.zero(CURRENCY),
  });

  const byMonth = new Map<string, ReturnType<typeof empty>>();
  for (const month of enumerateMonths(window.from, window.to)) {
    byMonth.set(month, empty());
  }

  for (const row of rows) {
    const bucket = byMonth.get(row.month) ?? empty();
    // Outflows are negative; negate into a positive magnitude. A refund-heavy
    // month can still net negative, which is correct and left alone.
    const amount = Money.fromString(row.sum, CURRENCY).negate();
    bucket[row.bucket] = bucket[row.bucket].add(amount);
    byMonth.set(row.month, bucket);
  }

  const monthly: EssentialMonth[] = [...byMonth.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([month, b]) => ({
      month,
      essential: b.essential.toString(),
      discretionary: b.discretionary.toString(),
      savings: b.savings.toString(),
      unclassified: b.unclassified.toString(),
      total: b.essential.add(b.discretionary).add(b.savings).add(b.unclassified).toString(),
    }));

  // Drop the LEADING run of months with no expense activity at all — a history
  // that starts mid-window must not drag the median down. A zero month after
  // spending began is real and stays. Note the trim is driven by TOTAL activity,
  // not by essential activity: a month of pure discretionary spend is a real
  // month in which essential spend was zero, and dropping it would bias the
  // median upward. Same rule as forecast.ts.
  const firstActive = monthly.findIndex((m) => !Money.fromString(m.total, CURRENCY).isZero());
  const basis = firstActive === -1 ? [] : monthly.slice(firstActive);

  const trailingMedian = medianMoney(basis.map((m) => m.essential));
  const minimumDebtService = Money.fromString(
    options.minimumDebtService ?? "0",
    CURRENCY,
  ).toString();

  const unclassifiedExpense = Money.sum(
    monthly.map((m) => Money.fromString(m.unclassified, CURRENCY)),
    CURRENCY,
  ).toString();
  const totalExpense = Money.sum(
    monthly.map((m) => Money.fromString(m.total, CURRENCY)),
    CURRENCY,
  ).toString();

  return {
    monthly,
    trailingMedian,
    minimumDebtService,
    baseline:
      trailingMedian === null
        ? null
        : Money.fromString(trailingMedian, CURRENCY)
            .add(Money.fromString(minimumDebtService, CURRENCY))
            .toString(),
    unclassifiedExpense,
    totalExpense,
    unclassifiedShare: shareOf(unclassifiedExpense, totalExpense),
    basisMonths: basis.length,
    window,
  };
}

/**
 * The essential monthly expense baseline over a window (P15-09).
 *
 * Runs two queries and unions their rows:
 *   1. `kind='expense'` transactions bucketed by `categories.necessity`
 *      (`NULL` → `unclassified`). `kind='transfer'` is excluded by construction,
 *      and `kind='income'` is not an expense.
 *   2. Transactions with **no category at all**, counted as `unclassified` — the
 *      app's other blind spot, and just as invisible to a necessity sum.
 *
 * Only *outflows* count in (2): an uncategorized deposit is not spend, and
 * netting it against uncategorized outflow would understate the blind spot.
 *
 * @param window - Inclusive `{from, to}` ISO dates.
 * @param options - Minimum debt service to fold into the baseline.
 * @returns The monthly split, median, baseline, and unclassified share.
 */
export async function essentialMonthlyBaseline(
  window: { readonly from: string; readonly to: string },
  options: EssentialBaselineOptions = {},
): Promise<EssentialBaseline> {
  const monthExpr = sql<string>`to_char(date_trunc('month', ${transactions.postedAt}), 'YYYY-MM')`;
  const inWindow = [gte(transactions.postedAt, window.from), lte(transactions.postedAt, window.to)];

  const [categorized, uncategorized] = await Promise.all([
    db
      .select({
        month: monthExpr,
        bucket: sql<NecessityBucket>`coalesce(${categories.necessity}, 'unclassified')`,
        sum: sql<string>`sum(${transactions.amount})`,
      })
      .from(transactions)
      .innerJoin(categories, eq(transactions.categoryId, categories.id))
      .where(and(...inWindow, eq(categories.kind, "expense")))
      .groupBy(monthExpr, sql`coalesce(${categories.necessity}, 'unclassified')`),
    db
      .select({
        month: monthExpr,
        sum: sql<string>`sum(${transactions.amount})`,
      })
      .from(transactions)
      .where(and(...inWindow, isNull(transactions.categoryId), sql`${transactions.amount} < 0`))
      .groupBy(monthExpr),
  ]);

  const rows: EssentialExpenseRow[] = [
    ...categorized,
    ...uncategorized.map((r) => ({ month: r.month, bucket: "unclassified" as const, sum: r.sum })),
  ];

  return computeEssentialBaseline(rows, window, options);
}
