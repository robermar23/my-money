import { isPositive, m, zero } from "../amounts.ts";
import { UTILIZATION_CRITICAL, UTILIZATION_TARGET } from "../constants.ts";
import type { AdviceInput } from "../snapshot.ts";
import { shareOf } from "../statistics.ts";
import { type Recommendation, type Rule, type Severity, recommendationId } from "../types.ts";
import { notRecorded, shown } from "./shared.ts";

/**
 * The credit-utilization rule (Phase 15, PLAN15 P15-19).
 *
 * Utilization — balance divided by credit limit — is the one household metric
 * here that is not about money at all. Carrying $3,000 on a $4,000 limit and
 * $3,000 on a $30,000 limit cost the same interest and read completely
 * differently to a credit model. Keeping the ratio under
 * {@link UTILIZATION_TARGET} is the conventional line.
 *
 * ── This rule needs a limit, and the limit is hand-entered ─────────────────
 * `credit_lines.credit_limit` is nullable and ships empty (ADR-033 §6: debt
 * terms are manual-first, and Plaid `/liabilities/get` is deliberately not
 * enabled). Utilization against an unknown limit is not a number — it is a
 * division by nothing. A card with no limit recorded therefore produces an
 * `unknown_input` recommendation naming exactly what to enter, and is **excluded
 * from the overall figure** so one blank card cannot quietly make a household's
 * aggregate utilization look better than it is.
 *
 * That last point is the sharp edge: including a $4,000 balance in the numerator
 * while its limit is missing from the denominator would *overstate* utilization;
 * excluding both understates coverage but never lies about the ratio. We exclude,
 * and report how much balance was left out.
 *
 * Utilization is a ratio, not money, so it is a `number` — the same posture as
 * `shareOf` in [statistics.ts](../statistics.ts).
 *
 * Pure and I/O-free.
 */

export interface CardUtilization {
  readonly accountId: string;
  readonly accountName: string;
  readonly balance: string;
  readonly creditLimit: string | null;
  /** `balance / creditLimit` in [0, ∞), or `null` when no limit is recorded. */
  readonly utilization: number | null;
  /** Balance that could be paid down to reach the target ratio. */
  readonly amountToTarget: string | null;
}

export interface OverallUtilization {
  readonly balance: string;
  readonly creditLimit: string;
  readonly utilization: number;
  /** Balance on cards with no recorded limit — excluded from the ratio above. */
  readonly excludedBalance: string;
  readonly excludedCards: number;
}

/** Per-card utilization for every revolving account, highest ratio first. */
export function cardUtilizations(input: AdviceInput): CardUtilization[] {
  return input.debts
    .filter((debt) => debt.kind === "revolving")
    .map((debt) => {
      const balance = m(debt.balance);
      if (debt.creditLimit === null || !isPositive(m(debt.creditLimit))) {
        return {
          accountId: debt.accountId,
          accountName: debt.accountName,
          balance: debt.balance,
          creditLimit: debt.creditLimit,
          utilization: null,
          amountToTarget: null,
        };
      }

      const limit = m(debt.creditLimit);
      const utilization = shareOf(debt.balance, debt.creditLimit);
      const targetBalance = limit.mul(UTILIZATION_TARGET);
      const excess = balance.sub(targetBalance);

      return {
        accountId: debt.accountId,
        accountName: debt.accountName,
        balance: debt.balance,
        creditLimit: debt.creditLimit,
        utilization,
        amountToTarget: excess.isNegative() ? "0.00" : excess.toString(),
      };
    })
    .sort((a, b) => {
      // Unknown-limit cards sort last: they are a data problem, not a ratio.
      if (a.utilization === null && b.utilization === null) {
        return a.accountName < b.accountName ? -1 : 1;
      }
      if (a.utilization === null) return 1;
      if (b.utilization === null) return -1;
      if (a.utilization !== b.utilization) return b.utilization - a.utilization;
      return a.accountName < b.accountName ? -1 : a.accountName > b.accountName ? 1 : 0;
    });
}

/**
 * Aggregate utilization across every card with a recorded limit.
 *
 * @param input - The assembled snapshot.
 * @returns The overall ratio plus what was excluded, or `null` when no card has
 *   a limit on file — in which case there is no denominator and no number.
 */
export function overallUtilization(input: AdviceInput): OverallUtilization | null {
  let balance = zero();
  let limit = zero();
  let excludedBalance = zero();
  let excludedCards = 0;
  let counted = 0;

  for (const card of cardUtilizations(input)) {
    if (card.utilization === null) {
      excludedBalance = excludedBalance.add(m(card.balance));
      excludedCards += 1;
      continue;
    }
    balance = balance.add(m(card.balance));
    limit = limit.add(m(card.creditLimit ?? "0"));
    counted += 1;
  }

  if (counted === 0) return null;

  return {
    balance: balance.toString(),
    creditLimit: limit.toString(),
    utilization: shareOf(balance.toString(), limit.toString()),
    excludedBalance: excludedBalance.toString(),
    excludedCards,
  };
}

/** A ratio as a display percentage: 0.4235 → "42.4". */
function ratioPercent(ratio: number): string {
  return (ratio * 100).toFixed(1);
}

export const utilizationRule: Rule = {
  id: "credit_utilization",
  title: "Credit utilization",
  minMonthsHistory: 0,

  evaluate(input: AdviceInput): Recommendation[] {
    const cards = cardUtilizations(input);
    if (cards.length === 0) return [];

    const targetPercent = ratioPercent(UTILIZATION_TARGET);
    const heuristic = `Keep each card, and your overall balance, under ${targetPercent}% of the limit`;
    const recommendations: Recommendation[] = [];

    for (const card of cards) {
      if (card.utilization === null) {
        recommendations.push({
          id: recommendationId("credit_utilization", card.accountId),
          ruleId: "credit_utilization",
          subjectKey: card.accountId,
          severity: "info",
          status: "unknown_input",
          title: `No credit limit recorded for ${card.accountName}`,
          rationale: `${m(card.balance).format()} is outstanding, but without the card's limit there is no ratio to compute. This card is left out of your overall utilization rather than counted at a guessed limit.`,
          heuristic,
          benchmark: targetPercent,
          currentValue: null,
          suggestedValue: null,
          impact: null,
          inputsUsed: [
            shown("Balance", card.balance, "money", "Latest snapshot"),
            notRecorded("Credit limit", "money", "Entered on the card's terms", "/accounts"),
          ],
          confidence: "low",
        });
        continue;
      }

      if (card.utilization <= UTILIZATION_TARGET) continue;

      const severity: Severity = card.utilization >= UTILIZATION_CRITICAL ? "critical" : "warning";
      recommendations.push({
        id: recommendationId("credit_utilization", card.accountId),
        ruleId: "credit_utilization",
        subjectKey: card.accountId,
        severity,
        status: "action",
        title: `${card.accountName} is at ${ratioPercent(card.utilization)}% of its limit`,
        rationale: `${m(card.balance).format()} against a ${m(card.creditLimit ?? "0").format()} limit. Paying ${m(card.amountToTarget ?? "0").format()} would bring it under ${targetPercent}%.`,
        heuristic,
        benchmark: targetPercent,
        currentValue: ratioPercent(card.utilization),
        suggestedValue: targetPercent,
        impact: card.amountToTarget,
        inputsUsed: [
          shown("Balance", card.balance, "money", "Latest snapshot"),
          shown("Credit limit", card.creditLimit ?? "0.00", "money", "Recorded terms", "/accounts"),
        ],
        confidence: "high",
      });
    }

    const overall = overallUtilization(input);
    if (overall !== null && overall.utilization > UTILIZATION_TARGET) {
      const targetBalance = m(overall.creditLimit).mul(UTILIZATION_TARGET);
      const excess = m(overall.balance).sub(targetBalance);

      recommendations.push({
        id: recommendationId("credit_utilization", "overall"),
        ruleId: "credit_utilization",
        subjectKey: "overall",
        severity: overall.utilization >= UTILIZATION_CRITICAL ? "critical" : "warning",
        status: "action",
        title: `Your overall card utilization is ${ratioPercent(overall.utilization)}%`,
        rationale: `${m(overall.balance).format()} across ${m(overall.creditLimit).format()} of limits.${
          overall.excludedCards > 0
            ? ` ${overall.excludedCards} ${overall.excludedCards === 1 ? "card is" : "cards are"} left out of this figure for want of a recorded limit, carrying ${m(overall.excludedBalance).format()} — so the real number may be higher.`
            : ""
        }`,
        heuristic,
        benchmark: targetPercent,
        currentValue: ratioPercent(overall.utilization),
        suggestedValue: targetPercent,
        impact: excess.isNegative() ? "0.00" : excess.toString(),
        inputsUsed: [
          shown("Total card balances", overall.balance, "money", "Cards with a recorded limit"),
          shown("Total credit limits", overall.creditLimit, "money", "Recorded terms", "/accounts"),
        ],
        confidence: overall.excludedCards > 0 ? "medium" : "high",
      });
    }

    if (recommendations.length === 0) {
      return [
        {
          id: recommendationId("credit_utilization", ""),
          ruleId: "credit_utilization",
          subjectKey: "",
          severity: "info",
          status: "ok",
          title: `Every card is under ${targetPercent}% of its limit`,
          rationale:
            overall === null
              ? "No card is over the conventional utilization line."
              : `${m(overall.balance).format()} across ${m(overall.creditLimit).format()} of limits — ${ratioPercent(overall.utilization)}% overall.`,
          heuristic,
          benchmark: targetPercent,
          currentValue: overall === null ? null : ratioPercent(overall.utilization),
          suggestedValue: targetPercent,
          impact: "0.00",
          inputsUsed:
            overall === null
              ? []
              : [
                  shown(
                    "Total card balances",
                    overall.balance,
                    "money",
                    "Cards with a recorded limit",
                  ),
                  shown("Total credit limits", overall.creditLimit, "money", "Recorded terms"),
                ],
          confidence: "high",
        },
      ];
    }

    return recommendations;
  },
};
