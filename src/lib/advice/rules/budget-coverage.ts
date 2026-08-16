import { clampAtZero, gt, gte, isPositive, m, zero } from "../amounts.ts";
import { type BudgetSuggestion, suggestBudgets, suggestionFor } from "../budget-suggest.ts";
import {
  BUDGET_DIVERGENCE_MONTHS,
  BUDGET_DIVERGENCE_TOLERANCE,
  BUDGET_MATERIAL_MONTHLY,
} from "../constants.ts";
import type { AdviceInput } from "../snapshot.ts";
import { medianMoney } from "../statistics.ts";
import { type Recommendation, type Rule, recommendationId } from "../types.ts";
import { completeMonths, shown } from "./shared.ts";

/**
 * The budget-coverage rule (Phase 15, PLAN15 P15-25).
 *
 * Two findings, and they are opposites:
 *
 *   1. **Uncovered** — a category with material, regular spend and no budget at
 *      all. The household is spending here every month and has never said what
 *      they intend to.
 *   2. **Diverged** — a category whose actual has exceeded its target for
 *      {@link BUDGET_DIVERGENCE_MONTHS} consecutive months. The budget exists and
 *      has stopped describing reality.
 *
 * ── The second finding is not a scolding ───────────────────────────────────
 * Three consecutive months over target usually means the *target* is wrong, not
 * that the household lacks discipline, and the recommendation says so: it offers
 * the observed median as a replacement target. A budgeting feature whose only
 * response to being missed is "try harder" gets closed and never reopened. This
 * is also why the divergence recommendation carries a `warning` and not a
 * `critical` — a budget that needs adjusting is not an emergency.
 *
 * ── Why a tolerance ────────────────────────────────────────────────────────
 * Being $3 over a $400 target is hitting it. Without
 * {@link BUDGET_DIVERGENCE_TOLERANCE} every category with a round-number budget
 * would diverge permanently, and the finding would carry no information.
 *
 * `minMonthsHistory` is {@link BUDGET_DIVERGENCE_MONTHS}: the divergence streak
 * is undefined below it, and a budget suggested from two months of history is a
 * guess (ADR-034 §7).
 *
 * Pure and I/O-free (ADR-032 §1).
 */

const HEURISTIC =
  "Give every category you spend in regularly a target, and change the target when it stops matching what you actually spend";

/** One category's coverage state. */
export interface BudgetCoverage {
  readonly categoryId: string;
  readonly name: string;
  /** The stored monthly target, or `null` when no budget row exists. */
  readonly target: string | null;
  /**
   * A typical month for this category.
   *
   * Read off the suggestion so the figure in the rationale and the target the
   * recommendation offers are the same statistic over the same months — a
   * rationale that says "a typical month is $310" next to a suggested target of
   * $280 invites exactly the distrust ADR-032 §2 is trying to avoid.
   */
  readonly typicalMonthly: string;
  /** Consecutive most-recent months over target by more than the tolerance. */
  readonly monthsOver: number;
  /** Median monthly overage across those months. `"0.00"` when not diverged. */
  readonly typicalOverage: string;
  readonly suggestion: BudgetSuggestion | null;
}

/**
 * How many of the most recent months ran over target beyond the tolerance.
 *
 * Counts backwards from the latest month and stops at the first month that was
 * within tolerance — a streak that was broken two months ago is not a streak.
 *
 * @param months - Ascending per-month actuals for one category.
 * @param target - The stored monthly target.
 * @returns Length of the trailing over-target run.
 */
function consecutiveMonthsOver(months: readonly string[], target: string): number {
  const ceiling = m(target).add(m(target).mul(BUDGET_DIVERGENCE_TOLERANCE));
  let streak = 0;
  for (let i = months.length - 1; i >= 0; i -= 1) {
    if (!gt(m(months[i] ?? "0"), ceiling)) break;
    streak += 1;
  }
  return streak;
}

/**
 * Coverage state for every active expense category (P15-25).
 *
 * @param input - The assembled snapshot.
 * @returns One entry per expense category that had spend in the window, ordered
 *   by typical monthly spend, largest first.
 */
export function budgetCoverage(input: AdviceInput): BudgetCoverage[] {
  // Complete months only: the in-progress month is a fraction of a month, and
  // counting it would break every divergence streak on the 1st.
  const months = completeMonths(input.monthlySpend, input.today);
  const suggestions = suggestBudgets(months);
  const targetByCategory = new Map(input.budgets.map((b) => [b.categoryId, b.amount]));

  const coverage: BudgetCoverage[] = [];
  for (const category of input.categories) {
    // Income and transfer categories are not budgeted here — same boundary the
    // budgets page draws (ADR-018).
    if (category.kind !== "expense") continue;

    const actuals = months.map((month) => month.byCategory[category.categoryId] ?? "0");
    const suggestion = suggestionFor(suggestions, category.categoryId);
    const typicalMonthly = suggestion?.suggested ?? medianMoney(actuals);
    if (typicalMonthly === null) continue;

    const target = targetByCategory.get(category.categoryId) ?? null;
    const monthsOver = target === null ? 0 : consecutiveMonthsOver(actuals, target);
    const overages =
      target === null
        ? []
        : actuals
            .slice(actuals.length - monthsOver)
            .map((actual) => clampAtZero(m(actual).sub(m(target))).toString());

    coverage.push({
      categoryId: category.categoryId,
      name: category.name,
      target,
      typicalMonthly,
      monthsOver,
      typicalOverage: medianMoney(overages) ?? "0.00",
      suggestion,
    });
  }

  return coverage.sort((a, b) => {
    const diff = m(b.typicalMonthly).sub(m(a.typicalMonthly));
    if (!diff.isZero()) return diff.isNegative() ? -1 : 1;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
}

export const budgetCoverageRule: Rule = {
  id: "budget_coverage",
  title: "Budget coverage",
  minMonthsHistory: BUDGET_DIVERGENCE_MONTHS,

  evaluate(input: AdviceInput): Recommendation[] {
    const coverage = budgetCoverage(input);
    if (coverage.length === 0) return [];

    const material = m(BUDGET_MATERIAL_MONTHLY);
    const recommendations: Recommendation[] = [];

    for (const category of coverage) {
      if (category.target === null) {
        // A category below the attention threshold is left alone entirely — it
        // is not a finding, and reporting it as `ok` would be just as noisy.
        if (!gte(m(category.typicalMonthly), material)) continue;

        const suggested = category.suggestion?.suggested ?? category.typicalMonthly;
        recommendations.push({
          id: recommendationId("budget_coverage", category.categoryId),
          ruleId: "budget_coverage",
          subjectKey: category.categoryId,
          severity: "info",
          status: "action",
          title: `No budget set for ${category.name}`,
          rationale: `A typical month here is ${m(category.typicalMonthly).format()}. Setting a target of ${m(suggested).format()} would put this spend on the budgets page instead of leaving it uncounted.`,
          heuristic: HEURISTIC,
          benchmark: null,
          currentValue: null,
          suggestedValue: suggested,
          impact: category.typicalMonthly,
          inputsUsed: [
            shown(
              "Typical monthly spend",
              category.typicalMonthly,
              "money",
              `Median of ${category.suggestion?.basisMonths ?? 0} complete months`,
              "/analysis/budgets",
            ),
            shown(
              "Highest month observed",
              category.suggestion?.observedRange.max ?? category.typicalMonthly,
              "money",
              "Observed range over the window",
            ),
          ],
          confidence: category.suggestion?.confidence ?? "low",
        });
        continue;
      }

      if (category.monthsOver < BUDGET_DIVERGENCE_MONTHS) continue;

      const suggested = category.suggestion?.suggested ?? category.typicalMonthly;
      const raises = gt(m(suggested), m(category.target));
      recommendations.push({
        id: recommendationId("budget_coverage", category.categoryId),
        ruleId: "budget_coverage",
        subjectKey: category.categoryId,
        severity: "warning",
        status: "action",
        title: `${category.name} has run over budget ${category.monthsOver} months running`,
        rationale: `The target is ${m(category.target).format()} and a typical month is ${m(category.typicalMonthly).format()} — about ${m(category.typicalOverage).format()} over.${
          raises
            ? ` A target of ${m(suggested).format()} would match what you actually spend; a budget missed every month stops being read.`
            : " Either the spending or the target needs to move."
        }`,
        heuristic: HEURISTIC,
        benchmark: category.target,
        currentValue: category.typicalMonthly,
        suggestedValue: suggested,
        impact: category.typicalOverage,
        inputsUsed: [
          shown("Current target", category.target, "money", "Stored budget", "/analysis/budgets"),
          shown(
            "Typical monthly spend",
            category.typicalMonthly,
            "money",
            `Median of ${category.suggestion?.basisMonths ?? 0} complete months`,
          ),
          shown(
            "Months over target",
            String(category.monthsOver),
            "count",
            `Consecutive months more than ${BUDGET_DIVERGENCE_TOLERANCE * 100}% over`,
          ),
        ],
        confidence: category.suggestion?.confidence ?? "low",
      });
    }

    if (recommendations.length > 0) return recommendations;

    const budgeted = coverage.filter((c) => c.target !== null).length;
    const covered = coverage.filter(
      (c) => c.target !== null || !gte(m(c.typicalMonthly), material),
    ).length;

    return [
      {
        id: recommendationId("budget_coverage", ""),
        ruleId: "budget_coverage",
        subjectKey: "",
        severity: "info",
        status: "ok",
        title:
          budgeted === 0
            ? "Nothing you spend on regularly is large enough to need a budget yet"
            : "Your budgets cover what you spend on and are holding",
        rationale:
          budgeted === 0
            ? `No category has a typical month above ${material.format()}.`
            : `${budgeted} of ${covered} categories worth budgeting have a target, and none has run over for ${BUDGET_DIVERGENCE_MONTHS} months running.`,
        heuristic: HEURISTIC,
        benchmark: null,
        currentValue: String(budgeted),
        suggestedValue: null,
        impact: "0.00",
        inputsUsed: [
          shown(
            "Categories with a budget",
            String(budgeted),
            "count",
            "Stored budgets",
            "/analysis/budgets",
          ),
          shown(
            "Total monthly spend",
            totalTypicalMonthly(coverage),
            "money",
            "Median month, summed across categories",
          ),
        ],
        confidence: "high",
      },
    ];
  },
};

/** Sum of every category's typical month — a scale figure for the `ok` case. */
function totalTypicalMonthly(coverage: readonly BudgetCoverage[]): string {
  let total = zero();
  for (const category of coverage) {
    if (isPositive(m(category.typicalMonthly))) total = total.add(m(category.typicalMonthly));
  }
  return total.toString();
}
