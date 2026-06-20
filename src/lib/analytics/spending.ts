import "server-only";

import { db } from "@/db/client.ts";
import { categories, categoryGroups, transactions } from "@/db/schema/index.ts";
import { Money } from "@/lib/money/money.ts";
import { and, eq, gte, inArray, isNull, lte, ne, sql } from "drizzle-orm";
import { enumerateMonths } from "./range.ts";

/**
 * Spending analytics aggregations (P8-12), per ADR-018.
 *
 * Sign & kind conventions (CLAUDE.md §Schema Invariants):
 *   - Stored amounts follow OFX: positive = inflow, negative = outflow.
 *   - `categories.kind` drives interpretation:
 *       * expense → spend magnitude = `-SUM(amount)` (outflows are negative)
 *       * income  → income magnitude = `SUM(amount)`
 *       * transfer → EXCLUDED from every total (card payments, WEB XFER, P2P).
 *   - Uncategorized rows (`category_id IS NULL`) are excluded from category/kind
 *     rollups and surfaced separately via {@link spendingSummary} so the owner
 *     can see — and clear — what's unclassified.
 *
 * Money discipline (CLAUDE.md §Money & Numeric Precision): sums happen in SQL
 * over `numeric`; results are carried as strings and combined with {@link Money}.
 * `Number()` never appears here — the chart islands do the single display-edge
 * conversion. USD is assumed (single-currency app); the column tags are USD.
 */

const CURRENCY = "USD";

export interface SpendQuery {
  /** Inclusive start date, `YYYY-MM-DD`. */
  readonly from: string;
  /** Inclusive end date, `YYYY-MM-DD`. */
  readonly to: string;
  /** Restrict to these account ids; omit/empty = all accounts. */
  readonly accountIds?: readonly string[];
  /** Roll up to leaf categories (default) or their parent groups. */
  readonly groupBy?: "category" | "group";
}

/** One aggregated spend/income bucket (a category or a group rollup). */
export interface SpendRow {
  /** Category id, or group id when `groupBy: 'group'`. `""` for the ungrouped bucket. */
  readonly id: string;
  readonly name: string;
  readonly groupId: string | null;
  readonly groupName: string | null;
  /** 'income' | 'expense' (transfers are excluded entirely). */
  readonly kind: string;
  /** Positive magnitude per kind, as a `NUMERIC(18,2)` string. */
  readonly total: string;
}

/** Normalize a signed SQL sum into a positive per-kind magnitude. */
function magnitude(kind: string, sum: string): Money {
  const m = Money.fromString(sum, CURRENCY);
  return kind === "income" ? m : m.negate();
}

/** Build the shared WHERE clause: date range + optional account filter. */
function rangeAndAccount(q: SpendQuery) {
  const clauses = [gte(transactions.postedAt, q.from), lte(transactions.postedAt, q.to)];
  if (q.accountIds && q.accountIds.length > 0) {
    clauses.push(inArray(transactions.accountId, [...q.accountIds]));
  }
  return clauses;
}

/**
 * Spend/income per category (or per group) over a date range.
 *
 * Transfers are excluded. Each row's `total` is a positive magnitude in its
 * kind's direction; refund-heavy categories can go negative (correct: net).
 * Rows are sorted by descending magnitude (largest first) for chart legibility.
 *
 * @param q - Range + optional account filter + rollup level.
 * @returns Aggregated rows (categories with no activity in range are absent).
 */
export async function spendByCategory(q: SpendQuery): Promise<SpendRow[]> {
  const rows = await db
    .select({
      id: categories.id,
      name: categories.name,
      groupId: categories.groupId,
      groupName: categoryGroups.name,
      kind: categories.kind,
      sum: sql<string>`sum(${transactions.amount})`,
    })
    .from(transactions)
    .innerJoin(categories, eq(transactions.categoryId, categories.id))
    .leftJoin(categoryGroups, eq(categories.groupId, categoryGroups.id))
    .where(and(...rangeAndAccount(q), ne(categories.kind, "transfer")))
    .groupBy(
      categories.id,
      categories.name,
      categories.groupId,
      categoryGroups.name,
      categories.kind,
    );

  const catRows: SpendRow[] = rows.map((r) => ({
    id: r.id,
    name: r.name,
    groupId: r.groupId,
    groupName: r.groupName,
    kind: r.kind,
    total: magnitude(r.kind, r.sum).toString(),
  }));

  if (q.groupBy !== "group") {
    return sortByMagnitudeDesc(catRows);
  }

  // Roll leaf rows up to their parent group. Ungrouped leaves collapse into a
  // single "" bucket labelled "Ungrouped". A group's kind is income iff every
  // contributing leaf is income (seed groups are kind-consistent).
  const byGroup = new Map<
    string,
    { name: string; total: Money; allIncome: boolean; any: boolean }
  >();
  for (const r of catRows) {
    const key = r.groupId ?? "";
    const entry = byGroup.get(key) ?? {
      name: r.groupName ?? "Ungrouped",
      total: Money.zero(CURRENCY),
      allIncome: true,
      any: false,
    };
    entry.total = entry.total.add(Money.fromString(r.total, CURRENCY));
    entry.allIncome = entry.allIncome && r.kind === "income";
    entry.any = true;
    byGroup.set(key, entry);
  }

  const groupRows: SpendRow[] = [...byGroup.entries()].map(([id, g]) => ({
    id,
    name: g.name,
    groupId: id === "" ? null : id,
    groupName: g.name,
    kind: g.any && g.allIncome ? "income" : "expense",
    total: g.total.toString(),
  }));
  return sortByMagnitudeDesc(groupRows);
}

/** Sort rows by absolute total, descending (largest contributor first). */
function sortByMagnitudeDesc(rows: SpendRow[]): SpendRow[] {
  return rows.sort((a, b) => {
    const av = Money.fromString(a.total, CURRENCY);
    const bv = Money.fromString(b.total, CURRENCY);
    const aAbs = av.isNegative() ? av.negate() : av;
    const bAbs = bv.isNegative() ? bv.negate() : bv;
    // Money has no compare(); subtract and read the sign.
    return bAbs.sub(aAbs).isNegative() ? -1 : 1;
  });
}

/** Per-month income/expense totals plus an expense breakdown by category. */
export interface MonthlyTotals {
  /** `YYYY-MM`. */
  readonly month: string;
  /** Expense magnitude per category id (positive strings) — feeds the stacked bar. */
  readonly byCategory: Record<string, string>;
  /** Total income magnitude (positive string). */
  readonly income: string;
  /** Total expense magnitude (positive string). */
  readonly expense: string;
  /** income − expense (positive = saved). */
  readonly net: string;
}

export interface MonthlyQuery extends SpendQuery {
  /** Restrict the breakdown to these category ids; omit = all (non-transfer). */
  readonly categoryIds?: readonly string[];
}

/**
 * Income/expense per month plus an expense-by-category breakdown, for the
 * stacked-bar + net-line chart. Months with no activity are emitted as zeros so
 * the series is continuous (no gaps); empty ranges yield an all-zero series
 * (never NaN).
 *
 * @param q - Range, optional account filter, optional category filter.
 * @returns Ascending monthly buckets across the whole range.
 */
export async function spendByMonth(q: MonthlyQuery): Promise<MonthlyTotals[]> {
  const monthExpr = sql<string>`to_char(date_trunc('month', ${transactions.postedAt}), 'YYYY-MM')`;

  const clauses = [...rangeAndAccount(q), ne(categories.kind, "transfer")];
  if (q.categoryIds && q.categoryIds.length > 0) {
    clauses.push(inArray(transactions.categoryId, [...q.categoryIds]));
  }

  const rows = await db
    .select({
      month: monthExpr,
      id: categories.id,
      kind: categories.kind,
      sum: sql<string>`sum(${transactions.amount})`,
    })
    .from(transactions)
    .innerJoin(categories, eq(transactions.categoryId, categories.id))
    .where(and(...clauses))
    .groupBy(monthExpr, categories.id, categories.kind);

  // Seed every month in range with zeros so the series is gap-free.
  const months = enumerateMonths(q.from, q.to);
  const acc = new Map<string, { byCategory: Map<string, Money>; income: Money; expense: Money }>();
  for (const m of months) {
    acc.set(m, {
      byCategory: new Map(),
      income: Money.zero(CURRENCY),
      expense: Money.zero(CURRENCY),
    });
  }

  for (const r of rows) {
    // A row's month should always be in the seeded set, but guard anyway.
    const bucket =
      acc.get(r.month) ??
      (() => {
        const fresh = {
          byCategory: new Map<string, Money>(),
          income: Money.zero(CURRENCY),
          expense: Money.zero(CURRENCY),
        };
        acc.set(r.month, fresh);
        return fresh;
      })();

    const mag = magnitude(r.kind, r.sum);
    if (r.kind === "income") {
      bucket.income = bucket.income.add(mag);
    } else {
      bucket.expense = bucket.expense.add(mag);
      const prev = bucket.byCategory.get(r.id) ?? Money.zero(CURRENCY);
      bucket.byCategory.set(r.id, prev.add(mag));
    }
  }

  return [...acc.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([month, b]) => {
      const byCategory: Record<string, string> = {};
      for (const [id, v] of b.byCategory) byCategory[id] = v.toString();
      return {
        month,
        byCategory,
        income: b.income.toString(),
        expense: b.expense.toString(),
        net: b.income.sub(b.expense).toString(),
      };
    });
}

export interface SpendingSummary {
  readonly income: string;
  readonly expense: string;
  /** income − expense. */
  readonly net: string;
  /** Count of uncategorized transactions in range (link to the review queue). */
  readonly uncategorizedCount: number;
  /** Magnitude of uncategorized *outflow* in range (positive string). */
  readonly uncategorizedOutflow: string;
}

/**
 * Top-line totals for the analysis page tiles: income, expense, net, plus how
 * much remains uncategorized (a nudge toward the review queue). Transfers are
 * excluded from income/expense.
 *
 * @param q - Range + optional account filter.
 * @returns The summary totals as money strings + uncategorized counts.
 */
export async function spendingSummary(q: SpendQuery): Promise<SpendingSummary> {
  const [byKind, uncategorized] = await Promise.all([
    db
      .select({ kind: categories.kind, sum: sql<string>`sum(${transactions.amount})` })
      .from(transactions)
      .innerJoin(categories, eq(transactions.categoryId, categories.id))
      .where(and(...rangeAndAccount(q), ne(categories.kind, "transfer")))
      .groupBy(categories.kind),
    db
      .select({
        count: sql<number>`count(*)::int`,
        outflow: sql<string>`coalesce(-sum(case when ${transactions.amount} < 0 then ${transactions.amount} else 0 end), 0)`,
      })
      .from(transactions)
      .where(and(...rangeAndAccount(q), isNull(transactions.categoryId))),
  ]);

  let income = Money.zero(CURRENCY);
  let expense = Money.zero(CURRENCY);
  for (const r of byKind) {
    if (r.kind === "income") income = income.add(magnitude("income", r.sum));
    else if (r.kind === "expense") expense = expense.add(magnitude("expense", r.sum));
  }

  return {
    income: income.toString(),
    expense: expense.toString(),
    net: income.sub(expense).toString(),
    uncategorizedCount: uncategorized[0]?.count ?? 0,
    uncategorizedOutflow: Money.fromString(uncategorized[0]?.outflow ?? "0", CURRENCY).toString(),
  };
}

export interface CategoryDetail {
  readonly category: {
    readonly id: string;
    readonly name: string;
    readonly kind: string;
    readonly groupName: string | null;
  } | null;
  /** Continuous monthly magnitude series for this category. */
  readonly monthly: readonly { month: string; total: string }[];
  /** Total over the whole range (positive magnitude). */
  readonly total: string;
}

/**
 * Monthly series + range total for a single category, for the drill-down view
 * (P8-15). The paginated transaction list is fetched separately by the page
 * (`listTransactionsForCategory`).
 *
 * @param categoryId - The leaf category to detail.
 * @param range - Inclusive `{from, to}` window.
 * @param accountIds - Optional account filter (carried through from the page).
 * @returns Category meta + a gap-free monthly series, or `category: null` if unknown.
 */
export async function categoryDetail(
  categoryId: string,
  range: { from: string; to: string },
  accountIds?: readonly string[],
): Promise<CategoryDetail> {
  const [meta] = await db
    .select({
      id: categories.id,
      name: categories.name,
      kind: categories.kind,
      groupName: categoryGroups.name,
    })
    .from(categories)
    .leftJoin(categoryGroups, eq(categories.groupId, categoryGroups.id))
    .where(eq(categories.id, categoryId))
    .limit(1);

  if (!meta) {
    return { category: null, monthly: [], total: "0.00" };
  }

  const monthExpr = sql<string>`to_char(date_trunc('month', ${transactions.postedAt}), 'YYYY-MM')`;
  const clauses = [
    gte(transactions.postedAt, range.from),
    lte(transactions.postedAt, range.to),
    eq(transactions.categoryId, categoryId),
  ];
  if (accountIds && accountIds.length > 0) {
    clauses.push(inArray(transactions.accountId, [...accountIds]));
  }

  const rows = await db
    .select({ month: monthExpr, sum: sql<string>`sum(${transactions.amount})` })
    .from(transactions)
    .where(and(...clauses))
    .groupBy(monthExpr);

  const byMonth = new Map(rows.map((r) => [r.month, magnitude(meta.kind, r.sum)]));
  let total = Money.zero(CURRENCY);
  const monthly = enumerateMonths(range.from, range.to).map((month) => {
    const v = byMonth.get(month) ?? Money.zero(CURRENCY);
    total = total.add(v);
    return { month, total: v.toString() };
  });

  return { category: meta, monthly, total: total.toString() };
}
