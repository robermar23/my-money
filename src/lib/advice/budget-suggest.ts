import type { MonthlyTotals } from "@/lib/analytics/spending.ts";
import { Money } from "@/lib/money/money.ts";
import { USD, m } from "./amounts.ts";
import { percentileMoney } from "./statistics.ts";
import type { Confidence } from "./types.ts";

/**
 * Per-category budget suggestion (Phase 15, PLAN15 P15-24, ADR-034 §3).
 *
 * ── Why this is not `forecastMonthlySpend` ─────────────────────────────────
 * [forecast.ts](../analytics/forecast.ts) already projects next month's spend as
 * the trailing **mean**, and that is the right statistic for what it does: a
 * forecast should answer "what will I actually spend", and a $2,000 transmission
 * repair genuinely is part of what this household spent.
 *
 * A budget is a different question — "what should I aim at" — and the mean is
 * the wrong statistic for it. One outlier month permanently lifts the target,
 * the household then misses it every ordinary month, and a budget that is missed
 * every month stops being read. The **median** is the target-setting statistic
 * (ADR-034 §3): it is where a typical month actually lands, and it is unmoved by
 * the repair.
 *
 * That divergence is deliberate and is asserted directly in
 * [budget-suggest.test.ts](./budget-suggest.test.ts) — the two functions are run
 * over the same fixture and the test states in numbers why they disagree, so
 * nobody later "fixes" one to match the other.
 *
 * {@link SuggestionBasis} `'p75'` exists for the household that wants headroom
 * rather than a coin-flip: three months in four land under it. It is offered, not
 * defaulted — an aspirational budget the user chose is useful, an aspirational
 * budget the app chose for them is just a mean by another name.
 *
 * ── What this deliberately does not do ─────────────────────────────────────
 * No recurring-merchant detection, no seasonality model, no ML. Order statistics
 * over the months the user already has. Nothing here is fetched and nothing is
 * logged (CLAUDE.md §Privacy).
 *
 * Pure and I/O-free (ADR-032 §1). `MonthlyTotals` is imported **type-only** from
 * a `server-only` module, so the erasure keeps that true at the module-graph
 * level rather than by convention.
 */

/** Which order statistic sets the target. */
export type SuggestionBasis = "median" | "p75";

/** Percentile behind each {@link SuggestionBasis}. */
const BASIS_PERCENTILE: Readonly<Record<SuggestionBasis, number>> = {
  median: 0.5,
  p75: 0.75,
};

/** Minimum months of history before any suggestion is offered. */
const DEFAULT_MIN_MONTHS = 3;

/** Trailing months the statistic is computed over. */
const DEFAULT_WINDOW_MONTHS = 6;

export interface BudgetSuggestion {
  readonly categoryId: string;
  /**
   * The suggested monthly target, as a money string.
   *
   * Can legitimately be `"0.00"` for a category the household spends in only
   * occasionally — the median of `[0, 0, 0, 0, 120, 140]` really is zero. That is
   * a true statement about a sporadic category, not a defect, and the caller
   * decides what to do with it: {@link ../budgets/suggestions.ts} drops zero
   * targets from the preview rather than offering the user a $0 budget, and
   * {@link monthsWithSpend} is here so that decision can be made on evidence.
   */
  readonly suggested: string;
  /** Lowest and highest month observed in the basis window. */
  readonly observedRange: { readonly min: string; readonly max: string };
  /** Months behind the statistic, after the leading inactive run is dropped. */
  readonly basisMonths: number;
  /** How many of those months had any spend in this category. */
  readonly monthsWithSpend: number;
  readonly basis: SuggestionBasis;
  readonly confidence: Confidence;
}

export interface SuggestBudgetsOptions {
  /** Order statistic to use. Default `'median'` (ADR-034 §3). */
  readonly basis?: SuggestionBasis;
  /** Trailing months to compute over. Default 6; floored to ≥ 1. */
  readonly months?: number;
  /**
   * Months of history below which no suggestion is offered at all. Default 3.
   *
   * Two months of history cannot distinguish a habit from a coincidence, and a
   * budget suggested from it would be a guess wearing a number's clothes
   * (ADR-032 consequence 1).
   */
  readonly minMonths?: number;
}

/** A month with neither income nor expense — i.e. before the history begins. */
function isEmptyMonth(month: MonthlyTotals): boolean {
  return m(month.income).isZero() && m(month.expense).isZero();
}

/**
 * How much to trust a suggestion built on this many months.
 *
 * The irregularity test is separate from the depth test on purpose: twelve
 * months of history behind a category that saw spend in three of them is a deep
 * history of a sporadic category, and the suggestion deserves the same `low`
 * badge as one built on a short history.
 */
function suggestionConfidence(basisMonths: number, monthsWithSpend: number): Confidence {
  if (basisMonths < 6 || monthsWithSpend * 2 < basisMonths) return "low";
  if (basisMonths < 12) return "medium";
  return "high";
}

/**
 * Suggest a monthly target for every category with spend in the window (P15-24).
 *
 * The leading run of months with no activity at all is dropped, so a history that
 * was imported mid-window does not drag every target toward zero. Interior zero
 * months are **kept**: a month in which the household genuinely spent nothing on
 * Auto is evidence about Auto, and dropping it would bias the target upward. Same
 * convention as [forecast.ts](../analytics/forecast.ts) and
 * [essential-expenses.ts](./essential-expenses.ts).
 *
 * @param history - Ascending monthly totals, e.g. `input.monthlySpend`.
 * @param options - Basis statistic, window depth, and the minimum history.
 * @returns One suggestion per category seen in the window, largest target first.
 *   Empty when the history is shorter than `minMonths`.
 */
export function suggestBudgets(
  history: readonly MonthlyTotals[],
  options: SuggestBudgetsOptions = {},
): BudgetSuggestion[] {
  const basis = options.basis ?? "median";
  const windowMonths = Math.max(1, Math.floor(options.months ?? DEFAULT_WINDOW_MONTHS));
  const minMonths = Math.max(1, Math.floor(options.minMonths ?? DEFAULT_MIN_MONTHS));

  const firstActive = history.findIndex((month) => !isEmptyMonth(month));
  if (firstActive === -1) return [];

  const active = history.slice(firstActive);
  const window = active.slice(Math.max(0, active.length - windowMonths));
  if (window.length < minMonths) return [];

  const categoryIds = new Set<string>();
  for (const month of window) {
    for (const id of Object.keys(month.byCategory)) categoryIds.add(id);
  }

  const suggestions: BudgetSuggestion[] = [];
  for (const categoryId of categoryIds) {
    // Months where the category is absent are real zeros, not gaps.
    const values = window.map((month) => month.byCategory[categoryId] ?? "0.00");
    const suggested = percentileMoney(values, BASIS_PERCENTILE[basis]);
    if (suggested === null) continue;

    const monthsWithSpend = values.filter((v) => !m(v).isZero()).length;
    const sorted = [...values].sort((a, b) => (m(a).sub(m(b)).isNegative() ? -1 : 1));

    suggestions.push({
      categoryId,
      suggested: Money.fromString(suggested, USD).toString(),
      observedRange: {
        min: m(sorted[0] ?? "0").toString(),
        max: m(sorted[sorted.length - 1] ?? "0").toString(),
      },
      basisMonths: window.length,
      monthsWithSpend,
      basis,
      confidence: suggestionConfidence(window.length, monthsWithSpend),
    });
  }

  // Largest target first; category id breaks ties so the order is deterministic
  // across runs (a `Set` preserves insertion order, which is query order).
  return suggestions.sort((a, b) => {
    const diff = m(b.suggested).sub(m(a.suggested));
    if (!diff.isZero()) return diff.isNegative() ? -1 : 1;
    return a.categoryId < b.categoryId ? -1 : a.categoryId > b.categoryId ? 1 : 0;
  });
}

/**
 * Look one suggestion up by category id.
 *
 * @param suggestions - Output of {@link suggestBudgets}.
 * @param categoryId - Category to find.
 * @returns The suggestion, or `null` when the category had no spend in the window.
 */
export function suggestionFor(
  suggestions: readonly BudgetSuggestion[],
  categoryId: string,
): BudgetSuggestion | null {
  return suggestions.find((s) => s.categoryId === categoryId) ?? null;
}
