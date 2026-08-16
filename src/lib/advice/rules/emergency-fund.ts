import { ceilMonths, clampAtZero, gt, isPositive, m, zero } from "../amounts.ts";
import {
  DEFAULT_RESERVE_MONTHS,
  ELEVATED_RESERVE_MONTHS,
  INCOME_CONCENTRATION_THRESHOLD,
} from "../constants.ts";
import type { AdviceInput } from "../snapshot.ts";
import { shareOf } from "../statistics.ts";
import {
  type InputUsed,
  type Recommendation,
  type Rule,
  type Severity,
  recommendationId,
} from "../types.ts";
import { baselineConfidence, notRecorded, shown } from "./shared.ts";

/**
 * The emergency-fund rule (Phase 15, PLAN15 P15-15, ADR-034 §4 rung 4).
 *
 * The heuristic is the most conventional one in household finance: keep **3 to 6
 * months of essential expenses** in liquid savings. Everything interesting here
 * is in the two judgement calls it takes to apply that honestly.
 *
 * ── Choosing 3 or 6 ────────────────────────────────────────────────────────
 * The range exists because the risk is not the same for every household. Six
 * months is the answer when a single job loss takes the whole income with it, or
 * when other people depend on it:
 *
 *   1. **`reserve_months_override` wins outright.** The user has an opinion about
 *      their own job security that no heuristic can beat.
 *   2. **Dependents recorded → 6.**
 *   3. **Income concentrated in one source → 6.** Measured off
 *      `observedNetIncome.contributingCategories`: if one category is at least
 *      {@link INCOME_CONCENTRATION_THRESHOLD} of the window's income, this
 *      household has one paycheck. This is deliberately conservative — two
 *      earners whose paychecks land in a single shared "Paycheck" category read
 *      as concentrated and get the larger target. Erring toward more reserve is
 *      the safe direction, and the override exists for the household that
 *      disagrees.
 *   4. **Otherwise → 3.**
 *
 * ── Measuring against the RESERVE tier, not all cash ───────────────────────
 * The target is compared to `cash.reserve` (savings + money market), not to
 * total cash. Operating cash is already committed to this month's bills, and a
 * CD carries a penalty to break — counting either would report a fund the
 * household cannot actually spend in an emergency, which is the one circumstance
 * the number exists for.
 *
 * ── When it declines to answer ─────────────────────────────────────────────
 * With no essential baseline there is no target, and a target of $0 renders as
 * *funded*. The rule emits `unknown_input` naming the missing input rather than
 * a confident zero (ADR-032 consequence 1).
 *
 * Pure and I/O-free. Money discipline: every figure is a `numeric` string.
 */

/** Which input chose the multiplier, so the UI can explain the target. */
export type ReserveMonthsSource = "override" | "dependents" | "income_concentration" | "default";

export interface ReserveTarget {
  readonly months: number;
  readonly source: ReserveMonthsSource;
  /** One sentence naming why this household got this multiplier. */
  readonly reason: string;
}

/**
 * Choose the reserve multiplier for a household (3 or 6 months).
 *
 * Exported separately because the waterfall rung (P15-22) sizes its own target
 * from the same decision, and two implementations of "how many months" is two
 * numbers that can disagree on one screen.
 *
 * @param input - The assembled snapshot.
 * @returns The multiplier, what chose it, and a sentence explaining it.
 */
export function reserveMonthsFor(input: AdviceInput): ReserveTarget {
  const override = input.household.profile?.reserveMonthsOverride;
  if (override !== null && override !== undefined) {
    return {
      months: override,
      source: "override",
      reason: `You set a ${override}-month reserve target in your household settings.`,
    };
  }

  const dependents = input.household.members.filter((member) => member.isDependent).length;
  if (dependents > 0) {
    return {
      months: ELEVATED_RESERVE_MONTHS,
      source: "dependents",
      reason: `${dependents} ${dependents === 1 ? "person depends" : "people depend"} on this income, so the target is the top of the 3–6 month range.`,
    };
  }

  const concentration = incomeConcentration(input);
  if (concentration !== null && concentration >= INCOME_CONCENTRATION_THRESHOLD) {
    return {
      months: ELEVATED_RESERVE_MONTHS,
      source: "income_concentration",
      reason:
        "Almost all of your income comes from a single source, so a job change would take all of it at once.",
    };
  }

  return {
    months: DEFAULT_RESERVE_MONTHS,
    source: "default",
    reason: "Your income comes from more than one source and no dependents are recorded.",
  };
}

/**
 * The largest single income category's share of observed net income, in [0, 1].
 *
 * `null` when no income categories contributed — with nothing to measure, this
 * rule must not claim concentration OR diversification.
 */
function incomeConcentration(input: AdviceInput): number | null {
  const included = input.netIncome.contributingCategories.filter((c) => !c.excluded);
  if (included.length === 0) return null;

  const total = included.reduce((acc, c) => acc.add(m(c.total)), zero());
  if (!isPositive(total)) return null;

  let largest = zero();
  for (const category of included) {
    const amount = m(category.total);
    if (gt(amount, largest)) largest = amount;
  }
  return shareOf(largest.toString(), total.toString());
}

/** The monthly surplus available to close the gap: observed net minus essentials. */
function monthlySurplus(input: AdviceInput) {
  const net = input.netIncome.trailingMedian;
  const essentials = input.essentials.baseline;
  if (net === null || essentials === null) return null;
  return m(net).sub(m(essentials));
}

export const emergencyFundRule: Rule = {
  id: "emergency_fund",
  title: "Emergency fund",
  // Three months of history is the floor at which a median essential figure
  // means anything at all (ADR-034 §7).
  minMonthsHistory: 3,

  evaluate(input: AdviceInput): Recommendation[] {
    const target = reserveMonthsFor(input);
    const id = recommendationId("emergency_fund", "");
    const heuristic = "3–6 months of essential expenses held in liquid savings";

    if (input.essentials.baseline === null) {
      return [
        {
          id,
          ruleId: "emergency_fund",
          subjectKey: "",
          severity: "info",
          status: "unknown_input",
          title: "We cannot size your emergency fund yet",
          rationale:
            "An emergency fund is sized against essential monthly expenses, and there is not enough classified spending history to compute one. Classify a few categories as essential and this fills in.",
          heuristic,
          benchmark: null,
          currentValue: input.cash.reserve.total,
          suggestedValue: null,
          impact: null,
          inputsUsed: [
            notRecorded(
              "Essential monthly expenses",
              "money",
              "Median monthly spend in categories marked essential, plus minimum debt service",
              "/settings/categories",
            ),
            shown(
              "Reserve savings",
              input.cash.reserve.total,
              "money",
              "Balances in accounts with a savings or money-market subtype",
              "/accounts",
            ),
          ],
          confidence: "low",
        },
      ];
    }

    const essential = m(input.essentials.baseline);
    const targetAmount = essential.mul(target.months);
    const current = m(input.cash.reserve.total);
    const gap = clampAtZero(targetAmount.sub(current));
    const surplus = monthlySurplus(input);
    const monthsToClose = surplus === null ? null : ceilMonths(gap, surplus);

    const inputsUsed: InputUsed[] = [
      shown(
        "Essential monthly expenses",
        input.essentials.baseline,
        "money",
        `Median of ${input.essentials.basisMonths} months of essential spend, plus ${input.essentials.minimumDebtService} of minimum debt service`,
        "/settings/categories",
      ),
      shown("Reserve target", `${target.months}`, "months", target.reason, "/settings/household"),
      shown(
        "Reserve savings",
        input.cash.reserve.total,
        "money",
        "Balances in accounts with a savings or money-market subtype",
        "/accounts",
      ),
      input.netIncome.trailingMedian === null
        ? notRecorded(
            "Monthly surplus",
            "money",
            "Observed net income minus essential expenses",
            "/settings/categories",
          )
        : shown(
            "Monthly surplus",
            (surplus ?? zero()).toString(),
            "money",
            "Median observed net income minus essential expenses",
          ),
    ];

    if (input.cash.unclassifiedShare > 0) {
      inputsUsed.push(
        shown(
          "Cash not yet classified",
          input.cash.unclassified.total,
          "money",
          "Cash accounts with no subtype set — not counted toward the reserve either way",
          "/accounts",
        ),
      );
    }

    const confidence = baselineConfidence(input);

    if (gap.isZero()) {
      return [
        {
          id,
          ruleId: "emergency_fund",
          subjectKey: "",
          severity: "info",
          status: "ok",
          title: `Your emergency fund covers ${target.months} months of essentials`,
          rationale: `${current.format()} in reserve savings against a ${targetAmount.format()} target. ${target.reason}`,
          heuristic,
          benchmark: targetAmount.toString(),
          currentValue: current.toString(),
          suggestedValue: targetAmount.toString(),
          impact: "0.00",
          inputsUsed,
          confidence,
        },
      ];
    }

    // Under one month of essentials in reserve is a different situation from
    // "a bit short of six" — a single unexpected bill becomes debt.
    const severity: Severity = gt(essential, current) ? "critical" : "warning";

    return [
      {
        id,
        ruleId: "emergency_fund",
        subjectKey: "",
        severity,
        status: "action",
        title: `Build your emergency fund to ${targetAmount.format()}`,
        rationale: `You have ${current.format()} in reserve savings, which covers ${input.cash.reserve.monthsCovered ?? "0"} months of your ${essential.format()} essential monthly expenses. The conventional target for your household is ${target.months} months. ${target.reason}${
          monthsToClose === null
            ? " Your essential expenses currently match or exceed your observed income, so there is no surplus to close the gap with."
            : ` At your current surplus you would close the ${gap.format()} gap in about ${monthsToClose} ${monthsToClose === 1 ? "month" : "months"}.`
        }`,
        heuristic,
        benchmark: targetAmount.toString(),
        currentValue: current.toString(),
        suggestedValue: targetAmount.toString(),
        impact: gap.toString(),
        inputsUsed,
        confidence,
      },
    ];
  },
};
