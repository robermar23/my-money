import "server-only";

import { db } from "@/db/client.ts";
import {
  type CategoryBudget,
  categories,
  categoryBudgets,
  categoryGroups,
} from "@/db/schema/index.ts";
import { runRateToMonthEnd } from "@/lib/analytics/forecast.ts";
import { spendByCategory } from "@/lib/analytics/spending.ts";
import { Money } from "@/lib/money/money.ts";
import { and, asc, eq, isNull } from "drizzle-orm";

/**
 * Monthly per-category budget queries (ADR-018, P8-18).
 *
 * Budgets store only a recurring monthly *target*; actual-vs-target is computed
 * per calendar month from transactions, reusing the spend aggregation (P8-12).
 *
 * Money discipline (CLAUDE.md §Money): targets and actuals are strings summed
 * via {@link Money}; the single `Number()` is the display-ratio `pct`, which is
 * not a money value. Budgets cover **expense** categories only — income and
 * transfer kinds are never budgeted here (transfers are excluded from spend
 * entirely; income targets are out of scope for this phase).
 */

const CURRENCY = "USD";

/** Resolve a `YYYY-MM` key into an inclusive `{from, to}` calendar-month range. */
export function monthRange(month: string): { from: string; to: string } {
  const year = Number(month.slice(0, 4));
  const mon = Number(month.slice(5, 7)); // 1-12
  // Day 0 of the *next* month is the last day of this month (UTC, no TZ drift).
  const lastDay = new Date(Date.UTC(year, mon, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(lastDay).padStart(2, "0")}` };
}

/**
 * Upsert a monthly target for a category. Idempotent on `category_id`: setting a
 * budget twice leaves exactly one row with the latest amount.
 *
 * @param categoryId - Category to target.
 * @param amount - Canonical money string (validated upstream via Money).
 * @returns The stored budget row.
 */
export async function setBudget(categoryId: string, amount: string): Promise<CategoryBudget> {
  const [row] = await db
    .insert(categoryBudgets)
    .values({ categoryId, amount, currency: CURRENCY })
    .onConflictDoUpdate({
      target: categoryBudgets.categoryId,
      set: { amount, currency: CURRENCY, updatedAt: new Date() },
    })
    .returning();
  if (!row) throw new Error("setBudget: upsert returned no row");
  return row;
}

/**
 * Remove a category's budget (a no-op if none exists).
 *
 * @param categoryId - Category whose target to clear.
 */
export async function deleteBudget(categoryId: string): Promise<void> {
  await db.delete(categoryBudgets).where(eq(categoryBudgets.categoryId, categoryId));
}

/**
 * List every stored budget.
 *
 * @returns The budget rows (unordered; callers join to category metadata).
 */
export async function listBudgets(): Promise<readonly CategoryBudget[]> {
  return db.select().from(categoryBudgets);
}

/** One category's target-vs-actual for a month. */
export interface BudgetLine {
  readonly categoryId: string;
  readonly name: string;
  readonly kind: string;
  readonly groupId: string | null;
  readonly groupName: string | null;
  /** Monthly target as a money string ("0.00" when none set). */
  readonly target: string;
  /** True when an explicit budget exists (distinguishes "no budget" from a 0 target). */
  readonly hasBudget: boolean;
  /** Spend magnitude this month as a money string (positive = spent). */
  readonly actual: string;
  /** target − actual (negative = over budget). */
  readonly remaining: string;
  /** actual / target × 100, rounded to an integer; 0 when target is 0. Display ratio. */
  readonly pct: number;
  /**
   * Projected end-of-month spend at the current run-rate (P8-22), as a money
   * string — only for the *in-progress* month; `null` for past/future months.
   */
  readonly projected: string | null;
}

/** A group's rollup = sum of its child category targets/actuals. */
export interface BudgetGroupRollup {
  readonly groupId: string | null;
  readonly groupName: string;
  readonly target: string;
  readonly actual: string;
  readonly remaining: string;
  readonly pct: number;
}

export interface BudgetVsActual {
  readonly month: string;
  readonly lines: readonly BudgetLine[];
  readonly groups: readonly BudgetGroupRollup[];
  readonly totals: {
    readonly target: string;
    readonly actual: string;
    readonly remaining: string;
    readonly pct: number;
    /** Sum of per-line projections; `null` unless the month is in-progress. */
    readonly projected: string | null;
  };
}

/** Integer percentage actual/target, guarded against divide-by-zero. */
function percent(actual: Money, target: Money): number {
  if (target.isZero()) return 0;
  // Ratio is a display value, not money — the single Number() bridge is fine here.
  return Math.round((Number(actual.toString()) / Number(target.toString())) * 100);
}

/**
 * Budget vs. actual for a calendar month across all non-archived **expense**
 * categories (P8-18). Each line carries the category's target (0 when unset) and
 * its actual spend for the month; group rollups and grand totals are sums of the
 * children via {@link Money} (penny-exact). Transfers/income are excluded.
 *
 * Lines are returned for every active expense category — including unbudgeted
 * ones — so the budgets page can offer an inline target input for each. Sorted
 * by group order then category order to match the pickers.
 *
 * @param month - `YYYY-MM` calendar month.
 * @param now - Reference "today" (injected for tests). Drives the in-progress
 *   month's run-rate projection. Defaults to `new Date()`.
 * @returns Per-category lines, group rollups, and grand totals.
 */
export async function budgetVsActual(
  month: string,
  now: Date = new Date(),
): Promise<BudgetVsActual> {
  const range = monthRange(month);

  const [cats, budgets, actuals] = await Promise.all([
    db
      .select({
        id: categories.id,
        name: categories.name,
        kind: categories.kind,
        groupId: categories.groupId,
        groupName: categoryGroups.name,
        groupSortOrder: categoryGroups.sortOrder,
        sortOrder: categories.sortOrder,
      })
      .from(categories)
      .leftJoin(categoryGroups, eq(categories.groupId, categoryGroups.id))
      .where(and(isNull(categories.archivedAt), eq(categories.kind, "expense")))
      .orderBy(
        asc(categoryGroups.sortOrder),
        asc(categoryGroups.name),
        asc(categories.sortOrder),
        asc(categories.name),
      ),
    listBudgets(),
    spendByCategory({ from: range.from, to: range.to }),
  ]);

  const targetById = new Map(budgets.map((b) => [b.categoryId, b.amount]));
  const actualById = new Map(actuals.map((a) => [a.id, a.total]));

  const lines: BudgetLine[] = cats.map((c) => {
    const hasBudget = targetById.has(c.id);
    const target = Money.fromString(targetById.get(c.id) ?? "0", CURRENCY);
    const actual = Money.fromString(actualById.get(c.id) ?? "0", CURRENCY);
    return {
      categoryId: c.id,
      name: c.name,
      kind: c.kind,
      groupId: c.groupId,
      groupName: c.groupName,
      target: target.toString(),
      hasBudget,
      actual: actual.toString(),
      remaining: target.sub(actual).toString(),
      pct: percent(actual, target),
      projected: runRateToMonthEnd(actual.toString(), month, now),
    };
  });

  // Group rollups: sum children's target + actual. Ungrouped collapse into "".
  const groupAcc = new Map<string, { name: string; target: Money; actual: Money }>();
  for (const l of lines) {
    const key = l.groupId ?? "";
    const entry = groupAcc.get(key) ?? {
      name: l.groupName ?? "Ungrouped",
      target: Money.zero(CURRENCY),
      actual: Money.zero(CURRENCY),
    };
    entry.target = entry.target.add(Money.fromString(l.target, CURRENCY));
    entry.actual = entry.actual.add(Money.fromString(l.actual, CURRENCY));
    groupAcc.set(key, entry);
  }

  const groups: BudgetGroupRollup[] = [...groupAcc.entries()].map(([id, g]) => ({
    groupId: id === "" ? null : id,
    groupName: g.name,
    target: g.target.toString(),
    actual: g.actual.toString(),
    remaining: g.target.sub(g.actual).toString(),
    pct: percent(g.actual, g.target),
  }));

  const totalTarget = Money.sum(
    lines.map((l) => Money.fromString(l.target, CURRENCY)),
    CURRENCY,
  );
  const totalActual = Money.sum(
    lines.map((l) => Money.fromString(l.actual, CURRENCY)),
    CURRENCY,
  );

  // Projection only exists for the in-progress month — all lines agree, so the
  // total is non-null iff any line is. Sum the per-line run-rate projections.
  const anyProjected = lines.some((l) => l.projected !== null);
  const totalProjected = anyProjected
    ? Money.sum(
        lines.map((l) => Money.fromString(l.projected ?? "0", CURRENCY)),
        CURRENCY,
      ).toString()
    : null;

  return {
    month,
    lines,
    groups,
    totals: {
      target: totalTarget.toString(),
      actual: totalActual.toString(),
      remaining: totalTarget.sub(totalActual).toString(),
      pct: percent(totalActual, totalTarget),
      projected: totalProjected,
    },
  };
}
