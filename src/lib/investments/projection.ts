import Decimal from "decimal.js";

/**
 * Value-projection + goal-marker math (PLAN9 Batch 5, ADR-022). Pure,
 * deterministic, `Decimal`-based (CLAUDE.md §Money).
 *
 * **These are illustrative estimates, not financial advice** (CLAUDE.md §Domain
 * Scope). The projection compounds a single user-chosen assumption; it does not
 * model markets, sequence-of-returns, withdrawals, or probability. The UI fences
 * every output behind an explicit estimate-not-advice banner (P9-21).
 */

export interface ProjectionPoint {
  /** Whole years from today (0 = current value). */
  readonly year: number;
  /** Projected portfolio value (money string, 2dp). */
  readonly value: string;
}

/**
 * Deterministic compound projection: `value(t) = current × (1 + rate)^t` for
 * each whole year `0..years`. No contributions — a clean "if it grows at X%"
 * series. Year 0 is the current value exactly.
 *
 * @param currentValue - Starting value (money string or number).
 * @param annualRatePct - Annual growth assumption as a percent (e.g. 7 = 7%).
 * @param years - Number of years to project (floored, clamped to ≥ 0).
 * @returns Ascending yearly points including year 0.
 */
export function projectValue(
  currentValue: string | number,
  annualRatePct: string | number,
  years: number,
): ProjectionPoint[] {
  const start = new Decimal(currentValue);
  const growth = new Decimal(annualRatePct).dividedBy(100).plus(1);
  const n = Math.max(0, Math.floor(years));
  const out: ProjectionPoint[] = [];
  for (let y = 0; y <= n; y++) {
    out.push({ year: y, value: start.times(growth.pow(y)).toDecimalPlaces(2).toFixed(2) });
  }
  return out;
}

export interface GoalProjection {
  /** Months from `fromDate` until the target is first reached. */
  readonly months: number;
  /** Projected calendar date the target is reached ('YYYY-MM-DD'). */
  readonly date: string;
}

/** Hard cap on the month-by-month search (100 years). */
const MAX_MONTHS = 1200;

/** ISO date `months` after `iso` (UTC; date arithmetic, never money). */
function addMonths(iso: string, months: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
}

/**
 * Project the date a single target value is reached, given the current value, a
 * fixed monthly contribution, and an annual growth assumption. Steps month by
 * month: `value = value × (1 + rate/12) + contribution`.
 *
 * - Target already met ⇒ `{ months: 0, date: fromDate }`.
 * - Zero rate ⇒ grows linearly from contributions alone.
 * - Never reached within 100 years ⇒ null (e.g. zero rate + zero contribution
 *   below target).
 *
 * @param currentValue - Starting value (money string or number).
 * @param monthlyContribution - Fixed monthly contribution (money string or number).
 * @param annualRatePct - Annual growth assumption as a percent.
 * @param target - Target value to reach.
 * @param fromDate - Anchor date ('YYYY-MM-DD'); defaults to today (UTC).
 * @returns The months + projected date, or null if unreachable under the cap.
 */
export function goalDate(
  currentValue: string | number,
  monthlyContribution: string | number,
  annualRatePct: string | number,
  target: string | number,
  fromDate?: string,
): GoalProjection | null {
  const start = fromDate ?? new Date().toISOString().slice(0, 10);
  const goal = new Decimal(target);
  let value = new Decimal(currentValue);
  if (value.greaterThanOrEqualTo(goal)) return { months: 0, date: start };

  const growth = new Decimal(annualRatePct).dividedBy(100).dividedBy(12).plus(1);
  const contribution = new Decimal(monthlyContribution);
  for (let m = 1; m <= MAX_MONTHS; m++) {
    value = value.times(growth).plus(contribution);
    if (value.greaterThanOrEqualTo(goal)) {
      return { months: m, date: addMonths(start, m) };
    }
  }
  return null;
}
