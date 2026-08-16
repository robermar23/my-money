import Decimal from "decimal.js";
import { clampAtZero, isPositive, m, percentOf, zero } from "../amounts.ts";
import type { AdviceContributionRule, AdviceInput, AdviceYtdContribution } from "../snapshot.ts";
import { type Recommendation, type Rule, recommendationId } from "../types.ts";
import { notRecorded, shown, yearElapsedFraction } from "./shared.ts";

/**
 * The employer-match rule (Phase 15, PLAN15 P15-16, ADR-034 §4 rung 2).
 *
 * An unclaimed employer match is the only line item in household finance with a
 * guaranteed, immediate, risk-free return — which is why ADR-034 §4 puts it
 * second in the waterfall, above even high-interest debt. It is also the rule
 * that needs **no new data**: PLAN14 already ships `retirement_contributions`
 * (the formula) and `income_contributions` (what was actually paid).
 *
 * ── Where a gap can actually exist ─────────────────────────────────────────
 * The match formula is single-tier plus a cap (ADR-030), and
 * [contribution.ts](../../income/contribution.ts) computes it exactly one way.
 * Reading that math backwards tells us which shapes can leave money on the table:
 *
 *   - `percent_of_contribution` **with a cap** — the classic "100% of the first
 *     4%". The employer pays `min(match% × employee, cap% × gross)`, so an
 *     employee contributing below `cap/match` of gross is forgoing the
 *     difference. **This is the only shape with a computable gap**, and it is by
 *     far the most common one.
 *   - `percent_of_contribution` with **no cap** — every additional dollar is
 *     matched and there is no ceiling to fall short of. The binding constraint is
 *     the statutory limit, which is the pacing rule's job (P15-21), not this one.
 *   - `percent_of_gross` and `amount` — the employer contributes the same
 *     regardless of what the employee does, so there is nothing to claim. (Real
 *     plans usually require *some* employee contribution to unlock these; this
 *     app's model does not encode that, and inventing the requirement would be a
 *     guess about the user's plan document.)
 *   - `none` — self-explanatory.
 *
 * ── YTD dollars, not projected dollars, are the headline ───────────────────
 * `impact` is the match forgone **so far this year** — money that is already
 * gone, computed from materialized pay dates rather than from a model of the
 * rest of the year. The annualized figure is offered alongside it as a rate, and
 * the rule says which is which. A projection makes a bigger number; the concrete
 * one is the one the user can verify against their own pay stubs.
 *
 * Pure and I/O-free. No tax math (ADR-032 §4) — `pretax` is a label here as
 * everywhere else.
 */

/** What the rule concluded about one contribution rule's match. */
export type MatchStatus =
  /** Employee is contributing below the cap; dollars are being forgone. */
  | "gap"
  /** The match is already being captured in full. */
  | "maximized"
  /** The formula has no employer match at all. */
  | "no_match"
  /** Matched without a ceiling — no gap exists to compute. */
  | "uncapped"
  /** No materialized pay periods this year, so there is nothing to measure. */
  | "unknown_input";

export interface MatchGap {
  readonly ruleId: string;
  readonly accountId: string;
  readonly accountName: string;
  readonly status: MatchStatus;
  readonly grossYtd: string;
  readonly employeeYtd: string;
  readonly employerYtd: string;
  /** The most the employer would have paid on this gross. `null` when uncapped. */
  readonly maxMatchYtd: string | null;
  /** `maxMatchYtd − employerYtd`, floored at zero. */
  readonly unclaimedYtd: string | null;
  /** Employee dollars that would have captured the full match year-to-date. */
  readonly requiredEmployeeYtd: string | null;
  /** The same, as a percentage of gross — what the user changes on their form. */
  readonly requiredEmployeePercent: string | null;
  readonly currentEmployeePercent: string | null;
  /** `unclaimedYtd` extrapolated to a full year at the current pace. */
  readonly projectedAnnualUnclaimed: string | null;
  readonly periods: number;
}

/** A percentage string for `numerator / denominator`, to 2 places. */
function percentString(numerator: Decimal, denominator: Decimal): string | null {
  if (denominator.lessThanOrEqualTo(0)) return null;
  return numerator.dividedBy(denominator).times(100).toDecimalPlaces(2).toString();
}

/**
 * Compute the match gap for one contribution rule (P15-16).
 *
 * Exported so the waterfall rung (P15-22) reads the same figure rather than
 * re-deriving it — two implementations of "are you getting your match" is two
 * answers that can disagree on one screen.
 *
 * @param rule - The contribution rule's formula.
 * @param ytd - Year-to-date materialized totals for that rule, or `undefined`
 *   when nothing has been paid yet this year.
 * @param today - Reference date, `YYYY-MM-DD`, for the annualization only.
 * @returns The gap, the employee percentage that would close it, and the YTD
 *   figures it was computed from.
 */
export function matchGapFor(
  rule: AdviceContributionRule,
  ytd: AdviceYtdContribution | undefined,
  today: string,
): MatchGap {
  const gross = m(ytd?.gross ?? "0");
  const employee = m(ytd?.employee ?? "0");
  const employer = m(ytd?.employer ?? "0");

  const base: Omit<MatchGap, "status"> = {
    ruleId: rule.ruleId,
    accountId: rule.accountId,
    accountName: rule.accountName,
    grossYtd: gross.toString(),
    employeeYtd: employee.toString(),
    employerYtd: employer.toString(),
    maxMatchYtd: null,
    unclaimedYtd: null,
    requiredEmployeeYtd: null,
    requiredEmployeePercent: null,
    currentEmployeePercent: percentString(
      new Decimal(employee.toString()),
      new Decimal(gross.toString()),
    ),
    projectedAnnualUnclaimed: null,
    periods: ytd?.periods ?? 0,
  };

  const matchValue = new Decimal(rule.matchValue);
  if (rule.matchBasis === "none" || matchValue.lessThanOrEqualTo(0)) {
    return { ...base, status: "no_match", maxMatchYtd: "0.00", unclaimedYtd: "0.00" };
  }

  // Nothing has been paid this year: gross is zero, so every ratio below is
  // meaningless. Say so rather than reporting a 100% shortfall against $0.
  if (!isPositive(gross)) {
    return { ...base, status: "unknown_input" };
  }

  if (rule.matchBasis === "percent_of_gross" || rule.matchBasis === "amount") {
    // Independent of the employee's contribution — nothing to claim.
    return { ...base, status: "maximized", maxMatchYtd: employer.toString(), unclaimedYtd: "0.00" };
  }

  if (rule.matchCapPercent === null) {
    return { ...base, status: "uncapped", maxMatchYtd: null, unclaimedYtd: null };
  }

  const cap = new Decimal(rule.matchCapPercent);
  const maxMatch = percentOf(gross, cap.toString());
  const unclaimed = clampAtZero(maxMatch.sub(employer));

  // match% × employee ≥ cap% × gross  ⟺  employee ≥ (cap / match) × gross.
  const requiredPercent = cap.dividedBy(matchValue).times(100);
  const requiredEmployee = percentOf(gross, requiredPercent.toString());

  const projected = m(
    new Decimal(unclaimed.toString()).dividedBy(yearElapsedFraction(today)).toFixed(2),
  );

  return {
    ...base,
    status: unclaimed.isZero() ? "maximized" : "gap",
    maxMatchYtd: maxMatch.toString(),
    unclaimedYtd: unclaimed.toString(),
    requiredEmployeeYtd: requiredEmployee.toString(),
    requiredEmployeePercent: requiredPercent.toDecimalPlaces(2).toString(),
    projectedAnnualUnclaimed: unclaimed.isZero() ? "0.00" : projected.toString(),
  };
}

/** Every active rule's match gap, largest unclaimed first. */
export function matchGaps(input: AdviceInput): MatchGap[] {
  const ytdByRule = new Map(input.contributionsYtd.map((y) => [y.ruleId, y]));
  return input.contributionRules
    .filter((rule) => rule.active)
    .map((rule) => matchGapFor(rule, ytdByRule.get(rule.ruleId), input.today))
    .sort((a, b) => {
      const left = new Decimal(a.unclaimedYtd ?? "0");
      const right = new Decimal(b.unclaimedYtd ?? "0");
      if (!left.equals(right)) return right.comparedTo(left);
      return a.accountName < b.accountName ? -1 : a.accountName > b.accountName ? 1 : 0;
    });
}

export const employerMatchRule: Rule = {
  id: "employer_match",
  title: "Employer match",
  // Reads recorded formulas and materialized pay dates, not a spending baseline.
  // A match gap is just as real in week two as it is in month twelve.
  minMonthsHistory: 0,

  evaluate(input: AdviceInput): Recommendation[] {
    const gaps = matchGaps(input);
    const heuristic = "Contribute at least enough to capture the full employer match";

    if (gaps.length === 0) {
      // No payroll rule recorded. Only worth saying when there is somewhere for a
      // match to land; a household with no workplace plan needs no notice.
      const hasWorkplaceAccount = input.accounts.some(
        (a) => a.taxTreatment === "tax_deferred" || a.taxTreatment === "roth",
      );
      if (!hasWorkplaceAccount) return [];

      return [
        {
          id: recommendationId("employer_match", ""),
          ruleId: "employer_match",
          subjectKey: "",
          severity: "info",
          status: "unknown_input",
          title: "We cannot tell whether you are capturing your employer match",
          rationale:
            "You have a workplace retirement account but no paycheck contribution rule recorded, so there is no match formula to check against. Adding your contribution percentage and your employer's match formula makes this answerable.",
          heuristic,
          benchmark: null,
          currentValue: null,
          suggestedValue: null,
          impact: null,
          inputsUsed: [
            notRecorded(
              "Employer match formula",
              "text",
              "Set on the paycheck that funds your retirement account",
              "/settings/income",
            ),
          ],
          confidence: "low",
        },
      ];
    }

    const recommendations: Recommendation[] = [];

    for (const gap of gaps) {
      // Nothing actionable and nothing interesting: no match on offer.
      if (gap.status === "no_match") continue;

      const inputsUsed = [
        shown(
          "Gross pay this year",
          gap.grossYtd,
          "money",
          `${gap.periods} materialized pay ${gap.periods === 1 ? "period" : "periods"}`,
          "/settings/income",
        ),
        shown(
          "Your contributions this year",
          gap.employeeYtd,
          "money",
          gap.currentEmployeePercent === null
            ? "From the materialized contribution ledger"
            : `${gap.currentEmployeePercent}% of gross`,
          "/settings/income",
        ),
        shown(
          "Employer contributions this year",
          gap.employerYtd,
          "money",
          "From the materialized contribution ledger",
          "/settings/income",
        ),
      ];

      if (gap.status === "unknown_input") {
        recommendations.push({
          id: recommendationId("employer_match", gap.ruleId),
          ruleId: "employer_match",
          subjectKey: gap.ruleId,
          severity: "info",
          status: "unknown_input",
          title: `No ${input.contributionYear} contributions recorded for ${gap.accountName}`,
          rationale:
            "The match formula is recorded, but no pay periods have been materialized for this year yet, so there is no gross pay to measure the match against.",
          heuristic,
          benchmark: null,
          currentValue: null,
          suggestedValue: null,
          impact: null,
          inputsUsed: [
            notRecorded(
              "Gross pay this year",
              "money",
              "No materialized pay periods for this year",
              "/settings/income",
            ),
          ],
          confidence: "low",
        });
        continue;
      }

      if (gap.status === "uncapped") {
        recommendations.push({
          id: recommendationId("employer_match", gap.ruleId),
          ruleId: "employer_match",
          subjectKey: gap.ruleId,
          severity: "info",
          status: "ok",
          title: `${gap.accountName}: your employer match has no ceiling`,
          rationale:
            "Every additional dollar you contribute is matched, so there is no match gap to close. What limits you here is the annual statutory contribution limit, not your employer's formula.",
          heuristic,
          benchmark: null,
          currentValue: gap.employerYtd,
          suggestedValue: null,
          impact: "0.00",
          inputsUsed,
          confidence: "high",
        });
        continue;
      }

      if (gap.status === "maximized") {
        recommendations.push({
          id: recommendationId("employer_match", gap.ruleId),
          ruleId: "employer_match",
          subjectKey: gap.ruleId,
          severity: "info",
          status: "ok",
          title: `You are capturing the full employer match on ${gap.accountName}`,
          rationale: `Your employer has contributed ${m(gap.employerYtd).format()} this year, which is the most this formula pays on your gross pay so far.`,
          heuristic,
          benchmark: gap.maxMatchYtd,
          currentValue: gap.employerYtd,
          suggestedValue: gap.maxMatchYtd,
          impact: "0.00",
          inputsUsed,
          confidence: "high",
        });
        continue;
      }

      const unclaimed = m(gap.unclaimedYtd ?? "0");
      recommendations.push({
        id: recommendationId("employer_match", gap.ruleId),
        ruleId: "employer_match",
        subjectKey: gap.ruleId,
        severity: "warning",
        status: "action",
        title: `Raise your ${gap.accountName} contribution to ${gap.requiredEmployeePercent}% to claim the full match`,
        rationale: `You are contributing ${gap.currentEmployeePercent ?? "0"}% of gross, and your employer matches up to ${gap.requiredEmployeePercent}%. That has left ${unclaimed.format()} of employer money unclaimed so far this year — about ${m(gap.projectedAnnualUnclaimed ?? "0").format()} at this pace over a full year. This is the highest-certainty return available to you.`,
        heuristic,
        benchmark: gap.maxMatchYtd,
        currentValue: gap.employerYtd,
        suggestedValue: gap.maxMatchYtd,
        impact: unclaimed.toString(),
        inputsUsed: [
          ...inputsUsed,
          shown(
            "Match cap",
            `${gap.requiredEmployeePercent}`,
            "percent",
            "The employee contribution that captures the full employer match",
            "/settings/income",
          ),
        ],
        confidence: "high",
      });
    }

    return recommendations;
  },
};

/** Total employer dollars forgone across every active rule, year-to-date. */
export function totalUnclaimedMatch(gaps: readonly MatchGap[]): string {
  return gaps.reduce((acc, gap) => acc.add(m(gap.unclaimedYtd ?? "0")), zero()).toString();
}
