import Decimal from "decimal.js";
import { fractionOf, isPositive, m, zero } from "../amounts.ts";
import { DEFAULT_HIGH_INTEREST_THRESHOLD_APR } from "../constants.ts";
import type { DebtTerm } from "../debt-terms.ts";
import type { AdviceInput } from "../snapshot.ts";
import { type Recommendation, type Rule, recommendationId } from "../types.ts";
import { notRecorded, shown } from "./shared.ts";

/**
 * The high-interest-debt rule (Phase 15, PLAN15 P15-17, ADR-034 §4 rung 3).
 *
 * The heuristic: **debt above a threshold APR is paid down before money goes into
 * investments**, because retiring a 22% balance is a guaranteed 22% return and
 * nothing in a brokerage account is guaranteed anything.
 *
 * ── The threshold is visible and tunable, not a magic number ───────────────
 * ADR-034 §6 is explicit about this. The figure encodes a judgement — roughly,
 * "above this rate, paying debt beats the long-run expected return of investing
 * the same dollar" — and reasonable households disagree about where the line
 * sits. So it reads from `household_profile.high_interest_threshold_apr` and
 * falls back to {@link DEFAULT_HIGH_INTEREST_THRESHOLD_APR}, with the value and
 * its source shown in `inputsUsed[]` on every recommendation this rule makes. A
 * user who thinks 7% is too low can move it instead of arguing with a constant
 * they cannot see.
 *
 * ── A missing APR is its own finding ───────────────────────────────────────
 * A debt with no recorded APR is emitted as `unknown_input` against that account
 * — not silently sorted to the bottom as if it were 0%, and not dropped. The
 * whole payoff ordering downstream depends on that rate, so "we do not know what
 * this costs you" is a real thing to tell someone (ADR-033 §6: terms are
 * manual-first, so an empty APR is the *normal* state on install day).
 *
 * Ordering is by APR descending, which is exactly avalanche order — the same
 * ordering [payoff.ts](../payoff.ts) simulates, so the list the user reads and
 * the plan the simulator runs never disagree.
 *
 * Pure and I/O-free.
 */

/** Where the threshold came from, so the UI can say. */
export interface Threshold {
  /** Decimal FRACTION ("0.070000"). */
  readonly apr: string;
  readonly source: "household" | "default";
}

/**
 * The APR above which debt counts as high-interest (ADR-034 §6).
 *
 * @param input - The assembled snapshot.
 * @returns The threshold as a decimal fraction, and whether the user set it.
 */
export function highInterestThreshold(input: AdviceInput): Threshold {
  const override = input.household.profile?.highInterestThresholdApr;
  return override === null || override === undefined
    ? { apr: DEFAULT_HIGH_INTEREST_THRESHOLD_APR, source: "default" }
    : { apr: override, source: "household" };
}

/** Debts carrying a balance and an APR above the threshold, worst rate first. */
export function highInterestDebts(input: AdviceInput): DebtTerm[] {
  const threshold = new Decimal(highInterestThreshold(input).apr);

  return input.debts
    .filter((debt) => {
      if (debt.apr === null) return false;
      if (!isPositive(m(debt.balance))) return false;
      return new Decimal(debt.apr).greaterThan(threshold);
    })
    .sort((a, b) => {
      const diff = new Decimal(b.apr ?? "0").comparedTo(new Decimal(a.apr ?? "0"));
      if (diff !== 0) return diff;
      // Ties break on balance then name so the list never reshuffles.
      const balances = new Decimal(b.balance).comparedTo(new Decimal(a.balance));
      if (balances !== 0) return balances;
      return a.accountName < b.accountName ? -1 : a.accountName > b.accountName ? 1 : 0;
    });
}

/** APR as a display percentage: "0.249900" → "24.99". */
function aprPercent(apr: string): string {
  return new Decimal(apr).times(100).toDecimalPlaces(2).toString();
}

export const highInterestDebtRule: Rule = {
  id: "high_interest_debt",
  title: "High-interest debt",
  // Reads recorded terms and the latest balance snapshot, neither of which
  // improves with more spending history.
  minMonthsHistory: 0,

  evaluate(input: AdviceInput): Recommendation[] {
    const threshold = highInterestThreshold(input);
    const thresholdPercent = aprPercent(threshold.apr);
    const heuristic = `Retire debt above ${thresholdPercent}% APR before investing beyond the employer match`;
    const withBalance = input.debts.filter((debt) => isPositive(m(debt.balance)));

    if (withBalance.length === 0) return [];

    const thresholdInput = shown(
      "High-interest threshold",
      thresholdPercent,
      "percent",
      threshold.source === "household"
        ? "Your household setting"
        : "The app default — adjust it in household settings",
      "/settings/household",
    );

    const recommendations: Recommendation[] = [];
    const flagged = highInterestDebts(input);

    flagged.forEach((debt, index) => {
      const apr = debt.apr ?? "0";
      const balance = m(debt.balance);
      // A year of interest at the current balance: the concrete cost of carrying
      // this debt for twelve more months, and the figure that ranks the list.
      const annualInterest = fractionOf(balance, apr);
      // Twice the threshold is a materially different situation from "a little
      // over it" — derived from the user's own line rather than a second magic
      // number.
      const severe = new Decimal(apr).greaterThanOrEqualTo(new Decimal(threshold.apr).times(2));

      recommendations.push({
        id: recommendationId("high_interest_debt", debt.accountId),
        ruleId: "high_interest_debt",
        subjectKey: debt.accountId,
        severity: severe ? "critical" : "warning",
        status: "action",
        title: `Pay down ${debt.accountName} — ${aprPercent(apr)}% APR`,
        rationale: `${balance.format()} at ${aprPercent(apr)}% costs about ${annualInterest.format()} a year in interest, which is a guaranteed loss no investment reliably beats.${
          index === 0
            ? " This is the highest rate you carry, so it is the first debt to attack once your employer match is covered."
            : ` It is number ${index + 1} in rate order, so it comes after ${flagged[index - 1]?.accountName}.`
        }`,
        heuristic,
        benchmark: thresholdPercent,
        currentValue: aprPercent(apr),
        suggestedValue: null,
        impact: annualInterest.toString(),
        inputsUsed: [
          shown(
            "Balance",
            debt.balance,
            "money",
            `Latest snapshot ${debt.balanceAsOf ?? ""}`.trim(),
          ),
          shown(
            "APR",
            aprPercent(apr),
            "percent",
            debt.termsUpdatedAt === null
              ? "Recorded terms"
              : `Recorded ${debt.termsUpdatedAt.toISOString().slice(0, 10)} — re-check if your rate has changed`,
            "/accounts",
          ),
          thresholdInput,
        ],
        confidence: "high",
      });
    });

    // Debts we cannot rate at all. Reported per account so the fix is one click
    // from the finding.
    for (const debt of withBalance) {
      if (debt.apr !== null) continue;
      recommendations.push({
        id: recommendationId("high_interest_debt", debt.accountId),
        ruleId: "high_interest_debt",
        subjectKey: debt.accountId,
        severity: "warning",
        status: "unknown_input",
        title: `No interest rate recorded for ${debt.accountName}`,
        rationale: `${m(debt.balance).format()} is outstanding but there is no APR on file, so this debt cannot be placed in a payoff order. It is not being treated as 0% — it is simply unranked.`,
        heuristic,
        benchmark: thresholdPercent,
        currentValue: null,
        suggestedValue: null,
        impact: null,
        inputsUsed: [
          shown(
            "Balance",
            debt.balance,
            "money",
            `Latest snapshot ${debt.balanceAsOf ?? ""}`.trim(),
          ),
          notRecorded("APR", "percent", "Entered on the account's terms", "/accounts"),
          thresholdInput,
        ],
        confidence: "low",
      });
    }

    if (recommendations.length === 0) {
      const total = withBalance.reduce((acc, debt) => acc.add(m(debt.balance)), zero());
      return [
        {
          id: recommendationId("high_interest_debt", ""),
          ruleId: "high_interest_debt",
          subjectKey: "",
          severity: "info",
          status: "ok",
          title: `None of your debt is above ${thresholdPercent}% APR`,
          rationale: `You carry ${total.format()} of debt, all of it below your high-interest threshold. Paying it down early is a reasonable choice, but it does not have to come before investing.`,
          heuristic,
          benchmark: thresholdPercent,
          currentValue: total.toString(),
          suggestedValue: null,
          impact: "0.00",
          inputsUsed: [thresholdInput],
          confidence: "high",
        },
      ];
    }

    return recommendations;
  },
};
