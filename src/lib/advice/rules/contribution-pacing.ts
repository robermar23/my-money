import Decimal from "decimal.js";
import { clampAtZero, gt, isPositive, m, zero } from "../amounts.ts";
import { type StatutoryLimits, limitsForYear } from "../constants.ts";
import type { AdviceInput } from "../snapshot.ts";
import { type Recommendation, type Rule, recommendationId } from "../types.ts";
import { notRecorded, shown, yearElapsedFraction } from "./shared.ts";

/**
 * The contribution-pacing rule (Phase 15, PLAN15 P15-21, ADR-034 §4 rung 6, §5).
 *
 * "Am I on track to use this year's 401(k) room?" — answered from the
 * materialized contribution ledger PLAN14 already writes (`income_contributions`,
 * keyed by `pay_date`), against the year's statutory elective-deferral limit.
 *
 * ── This rule goes SILENT when the year is not configured ──────────────────
 * ADR-034 §5, and the reason {@link limitsForYear} returns `null` at all. On
 * 1 January the previous year's ceiling is simply wrong, and pacing someone
 * against it produces a confident percentage that is wrong for twelve months.
 * So when the year has no configured limits this rule emits **nothing at all**,
 * and the waterfall's workplace rung reports `unknown_input` with "limit not
 * configured for YYYY" — one clear sentence in one place, rather than a wrong
 * number in two.
 *
 * ── What counts toward the limit ───────────────────────────────────────────
 * The **employee's own** dollars, across every workplace container. Employer
 * match sits under a separate and much larger ceiling this app does not model;
 * folding it in would understate the user's remaining room, which is the wrong
 * direction to be wrong in. HSA payroll contributions are excluded — they have
 * their own limit entirely.
 *
 * ── Catch-up is reported, never silently applied ───────────────────────────
 * When a household member is old enough for the catch-up, the extra room is
 * **mentioned** rather than added to the ceiling. The app does not know which
 * person owns which plan (`retirement_contributions` links to an income source,
 * not to a `household_members` row), so raising the limit would be a guess that
 * makes a real over-contribution look fine.
 *
 * No tax math anywhere (ADR-032 §4): a statutory limit is a ceiling to pace
 * against, not a deduction to compute.
 *
 * Pure and I/O-free.
 */

/** Whether the household is on track to use the year's room. */
export type PacingState = "under" | "on_track" | "over_limit";

export interface DeferralPacing {
  readonly year: number;
  readonly limits: StatutoryLimits;
  /** The base elective-deferral ceiling, before any catch-up. */
  readonly limit: string;
  /** A member is old enough for the catch-up — reported, not applied. */
  readonly catchUpAvailable: boolean;
  readonly catchUpAmount: string | null;
  /** Employee dollars contributed to workplace plans year-to-date. */
  readonly employeeYtd: string;
  /** Room left under the base ceiling, floored at zero. */
  readonly remaining: string;
  /** `employeeYtd` extrapolated to a full year at the current pace. */
  readonly projectedAnnual: string;
  readonly pace: PacingState;
  /** Materialized pay periods behind the figures. Few periods ⇒ noisy projection. */
  readonly periods: number;
}

/**
 * Pace year-to-date employee deferrals against the year's statutory ceiling.
 *
 * @param input - The assembled snapshot.
 * @returns The pacing figures, or **`null` when the year has no configured
 *   limits** — every caller must suppress its output rather than substitute an
 *   adjacent year (ADR-034 §5).
 */
export function deferralPacing(input: AdviceInput): DeferralPacing | null {
  const limits = limitsForYear(input.contributionYear);
  if (limits === null) return null;

  // Workplace containers only. An HSA has its own ceiling entirely.
  const workplace = input.contributionsYtd.filter((y) => y.taxTreatment !== "hsa");
  const employeeYtd = workplace.reduce((acc, y) => acc.add(m(y.employee)), zero());
  const periods = workplace.reduce((acc, y) => Math.max(acc, y.periods), 0);

  const limit = m(limits.electiveDeferral);
  const remaining = clampAtZero(limit.sub(employeeYtd));

  const elapsed = yearElapsedFraction(input.today);
  const projectedAnnual = m(new Decimal(employeeYtd.toString()).dividedBy(elapsed).toFixed(2));

  const pace: PacingState = gt(employeeYtd, limit)
    ? "over_limit"
    : gt(limit, projectedAnnual)
      ? "under"
      : "on_track";

  const catchUpAge = limits.catchUpAge;
  const catchUpAvailable = input.household.members.some(
    (member) =>
      !member.isDependent &&
      member.birthYear !== null &&
      input.contributionYear - member.birthYear >= catchUpAge,
  );

  return {
    year: input.contributionYear,
    limits,
    limit: limit.toString(),
    catchUpAvailable,
    catchUpAmount: catchUpAvailable ? limits.electiveDeferralCatchUp : null,
    employeeYtd: employeeYtd.toString(),
    remaining: remaining.toString(),
    projectedAnnual: projectedAnnual.toString(),
    pace,
    periods,
  };
}

export const contributionPacingRule: Rule = {
  id: "contribution_pacing",
  title: "Retirement contribution pacing",
  // Reads a year-to-date ledger, not a spending baseline.
  minMonthsHistory: 0,

  evaluate(input: AdviceInput): Recommendation[] {
    const pacing = deferralPacing(input);
    // The year is not configured. Silence here, one sentence in the waterfall.
    if (pacing === null) return [];

    const id = recommendationId("contribution_pacing", "");
    const heuristic = `Use as much of the ${pacing.year} elective-deferral room as your cash flow allows, after the employer match and high-interest debt`;

    // No payroll rules at all: nothing to pace, and nothing worth saying.
    if (input.contributionRules.length === 0) return [];

    if (pacing.periods === 0) {
      return [
        {
          id,
          ruleId: "contribution_pacing",
          subjectKey: "",
          severity: "info",
          status: "unknown_input",
          title: `No ${pacing.year} contributions recorded yet`,
          rationale: `Your ${pacing.year} elective-deferral room is ${m(pacing.limit).format()}, but no pay periods have been materialized for this year, so there is nothing to pace against.`,
          heuristic,
          benchmark: pacing.limit,
          currentValue: null,
          suggestedValue: null,
          impact: null,
          inputsUsed: [
            shown(
              `${pacing.year} elective-deferral limit`,
              pacing.limit,
              "money",
              "Statutory limit, checked into the app",
            ),
            notRecorded(
              "Contributions this year",
              "money",
              "No materialized pay periods for this year",
              "/settings/income",
            ),
          ],
          confidence: "low",
        },
      ];
    }

    const inputsUsed = [
      shown(
        `${pacing.year} elective-deferral limit`,
        pacing.limit,
        "money",
        "Statutory limit, checked into the app",
      ),
      shown(
        "Your contributions this year",
        pacing.employeeYtd,
        "money",
        `${pacing.periods} materialized pay ${pacing.periods === 1 ? "period" : "periods"} — employer match excluded, it has its own limit`,
        "/settings/income",
      ),
      shown(
        "Projected for the full year",
        pacing.projectedAnnual,
        "money",
        "Year-to-date contributions extrapolated at the current pace",
      ),
    ];

    if (pacing.catchUpAvailable && pacing.catchUpAmount !== null) {
      inputsUsed.push(
        shown(
          "Catch-up room available",
          pacing.catchUpAmount,
          "money",
          `A household member reaches ${pacing.limits.catchUpAge} this year — this is additional room, not included in the limit above`,
          "/settings/household",
        ),
      );
    }

    if (pacing.pace === "over_limit") {
      const over = m(pacing.employeeYtd).sub(m(pacing.limit));
      return [
        {
          id,
          ruleId: "contribution_pacing",
          subjectKey: "",
          severity: "warning",
          status: "action",
          title: `You are ${over.format()} past the ${pacing.year} contribution limit`,
          rationale: `Your recorded employee contributions total ${m(pacing.employeeYtd).format()} against a ${m(pacing.limit).format()} limit.${
            pacing.catchUpAvailable
              ? ` A catch-up contribution of up to ${m(pacing.catchUpAmount ?? "0").format()} may apply, which would cover some or all of this — the app does not know which household member owns this plan, so it does not assume it.`
              : " Excess deferrals generally have to be corrected with your plan administrator, so it is worth checking whether your payroll system has a cap set."
          }`,
          heuristic,
          benchmark: pacing.limit,
          currentValue: pacing.employeeYtd,
          suggestedValue: pacing.limit,
          impact: over.toString(),
          inputsUsed,
          confidence: pacing.catchUpAvailable ? "low" : "medium",
        },
      ];
    }

    if (pacing.pace === "on_track") {
      return [
        {
          id,
          ruleId: "contribution_pacing",
          subjectKey: "",
          severity: "info",
          status: "ok",
          title: `You are on pace to use your ${pacing.year} contribution room`,
          rationale: `${m(pacing.employeeYtd).format()} contributed so far, projecting to ${m(pacing.projectedAnnual).format()} against a ${m(pacing.limit).format()} limit.`,
          heuristic,
          benchmark: pacing.limit,
          currentValue: pacing.employeeYtd,
          suggestedValue: pacing.limit,
          impact: "0.00",
          inputsUsed,
          confidence: "high",
        },
      ];
    }

    const shortfall = clampAtZero(m(pacing.limit).sub(m(pacing.projectedAnnual)));
    return [
      {
        id,
        ruleId: "contribution_pacing",
        subjectKey: "",
        severity: "info",
        status: "action",
        title: `You are on pace to leave ${shortfall.format()} of ${pacing.year} contribution room unused`,
        rationale: `${m(pacing.employeeYtd).format()} contributed over ${pacing.periods} pay ${pacing.periods === 1 ? "period" : "periods"}, which projects to ${m(pacing.projectedAnnual).format()} for the year against a ${m(pacing.limit).format()} limit. Whether to close that gap depends on your cash flow — this is a diagnostic, not a target you have to hit.`,
        heuristic,
        benchmark: pacing.limit,
        currentValue: pacing.employeeYtd,
        suggestedValue: pacing.limit,
        impact: shortfall.toString(),
        inputsUsed,
        // Few pay periods behind a full-year projection makes it noisy — say so
        // rather than presenting January's extrapolation as a forecast.
        confidence: pacing.periods >= 6 ? "high" : "low",
      },
    ];
  },
};

/** Room left under the year's ceiling, or `null` when the year is unconfigured. */
export function remainingDeferralRoom(input: AdviceInput): string | null {
  const pacing = deferralPacing(input);
  if (pacing === null) return null;
  return isPositive(m(pacing.remaining)) ? pacing.remaining : "0.00";
}
