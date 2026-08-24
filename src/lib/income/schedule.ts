import { INCOME_CADENCES, type IncomeCadence } from "@/db/schema/income-sources.ts";
import { occurrenceDatesBetween } from "@/lib/schedule/occurrences.ts";

/**
 * Pay-schedule expansion (P14-05, ADR-031).
 *
 * The date math itself lives in [schedule/occurrences.ts](../schedule/occurrences.ts)
 * as of P16-02 — there is exactly ONE occurrence-expansion implementation in the
 * codebase (ADR-036 §5), shared by paychecks and scheduled obligations. This
 * module is the income-shaped door onto it: it narrows the cadence vocabulary to
 * the four an `income_sources` row may declare, and it owns `periodsPerYear`,
 * which is an income concept and stays here.
 *
 * The invariants the expansion guarantees — the anchor phases the schedule in
 * BOTH directions, all arithmetic is UTC-midnight on `YYYY-MM-DD` strings (a DST
 * transition cannot move a pay date), and day-of-month cadences clamp rather
 * than drift — are documented at length on `occurrenceDatesBetween`.
 */

/**
 * Conventional pay periods per year, by cadence — the savings-rate annualizer.
 *
 * Deliberately covers ONLY the four income cadences and must NOT be widened to
 * the obligation vocabulary (ADR-037 §3). "Periods per year" is a paycheck
 * concept used to annualize gross pay; a quarterly insurance premium has no pay
 * period, and giving it one here would put an obligation into the savings-rate
 * denominator. If a caller outside income needs an annualization factor, that
 * factor belongs to that caller's domain, not to this map.
 */
const PERIODS_PER_YEAR: Record<IncomeCadence, number> = {
  weekly: 52,
  biweekly: 26,
  semimonthly: 24,
  monthly: 12,
};

/**
 * Pay periods in a year for a cadence.
 *
 * @param cadence - The income source's cadence.
 * @returns 52 / 26 / 24 / 12.
 * @throws If the cadence is not one of the four known values.
 */
export function periodsPerYear(cadence: IncomeCadence): number {
  const periods = PERIODS_PER_YEAR[cadence];
  if (periods === undefined) {
    throw new Error(`Unknown income cadence: ${cadence}`);
  }
  return periods;
}

/**
 * Expand a pay schedule across an inclusive window.
 *
 * A thin delegation to `occurrenceDatesBetween`; see that function for the
 * cadence semantics and the clamping rules. The one thing this wrapper adds is
 * the vocabulary guard: `cadence` arrives from a text column, so a value outside
 * the income four is rejected here rather than being quietly expanded as an
 * obligation cadence the income model does not support.
 *
 * @param cadence - How often the source pays.
 * @param anchorDate - A known pay date, `YYYY-MM-DD`. Phases the schedule.
 * @param from - Inclusive window start, `YYYY-MM-DD`.
 * @param to - Inclusive window end, `YYYY-MM-DD`.
 * @returns Ascending, de-duplicated pay dates inside the window. Empty when the
 *   window is inverted or contains no pay date.
 * @throws If any date is not a real `YYYY-MM-DD` value, or the cadence is not
 *   one of the four income cadences.
 */
export function payDatesBetween(
  cadence: IncomeCadence,
  anchorDate: string,
  from: string,
  to: string,
): string[] {
  if (!INCOME_CADENCES.includes(cadence)) {
    throw new Error(`Unknown income cadence: ${cadence}`);
  }
  return occurrenceDatesBetween(cadence, anchorDate, from, to);
}
