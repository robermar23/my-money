import { Money } from "@/lib/money/money.ts";
import Decimal from "decimal.js";

/**
 * The residual discretionary rate — the double-count fix (P16-15, ADR-038 §2).
 *
 * **This is the most important function in the phase**, and the defect it exists
 * to prevent is not a crash. It is a plausible number that is quietly too low.
 *
 * ── The trap, stated plainly ───────────────────────────────────────────────
 * Recurring obligations are ALREADY INSIDE observed spend. The mortgage that
 * left the account on the 1st is a transaction like any other, and it is in the
 * trailing-spend total. So a projection that takes a total-spend run-rate AND
 * ALSO puts the mortgage on the calendar on the 1st has charged the household
 * for its mortgage twice — every month, forever. On a household spending $4,500
 * a month of which $2,700 is confirmed obligations, the naive version projects
 * $7,200 of outflow against $4,500 of reality: safe-to-spend collapses, the
 * low-water mark invents a shortfall, and the family learns the feature lies.
 *
 * The fix is arithmetic, not machinery. Everything the calendar states exactly
 * is REMOVED from the rate, and only what is left is spread flat:
 *
 *     rate = (observed expense − expense attributable to obligations) ÷ days
 *
 * ── Why the clamp is not defensive programming ─────────────────────────────
 * The subtraction is clamped at zero because a negative residual is not a
 * finding, it is a contradiction: it would say the household earns money by
 * existing. When attribution exceeds observation, what is wrong is the
 * ATTRIBUTION — a mis-matched occurrence, a duplicate import, an obligation
 * whose expected amount is stale. The projection stays honest (rate zero) and
 * `clampedAtZero` carries the fact upward, so the condition is reportable rather
 * than invisible.
 *
 * ── Why coverage comes back with the rate ──────────────────────────────────
 * The residual subtraction is only as exact as occurrence matching (P16-22).
 * ADR-038's stated limitation is that coverage is DISPLAYED rather than buried,
 * so a household reading "$20/day of everyday spending, 60% of your spend
 * accounted for by known bills" can judge the number instead of trusting it.
 * Coverage rises visibly as obligations are confirmed, which is what makes the
 * feature improve rather than merely exist.
 *
 * ── Parameter naming ───────────────────────────────────────────────────────
 * PLAN16 calls the first parameter `observedMonthly`. It is named
 * `observedExpenseInWindow` here because the formula divides it by `windowDays`:
 * passing a MONTHLY total alongside a 90-day window would divide a month of
 * spend across a quarter and produce a rate a third of the truth. The two
 * figures must describe the same window, and the name is the cheapest place to
 * say so.
 *
 * ── Money discipline ───────────────────────────────────────────────────────
 * Every money value moves through {@link Money}/decimal.js (CLAUDE.md §Money).
 * `coverage` is a RATIO rather than money — money divided by money is unitless
 * and carries no currency — so it is computed with `Decimal` directly at four
 * decimal places, the same posture [advice/amounts.ts](../advice/amounts.ts)
 * takes for `ceilMonths`. Four places rather than `Money.div`'s two, because
 * two would pre-round a percentage to whole points before the UI ever sees it.
 */

const CURRENCY = "USD";

/** Decimal places `coverage` is reported to. Four = 0.01% of resolution. */
const COVERAGE_DP = 4;

/** The flat daily rate for everything the calendar does not state exactly. */
export interface ResidualRate {
  /**
   * Per-day discretionary outflow, a non-negative money string in cents,
   * truncated DOWN via `Money.divFloor`. `rate x windowDays` is therefore never
   * more than the residual it came from — the guarantee the no-double-count
   * invariant rests on. Erring low by a fraction of a cent a day is the safe
   * direction for a figure subtracted from a projected balance.
   */
  readonly dailyRate: string;
  /**
   * Share of observed expense attributable to confirmed obligations, as a
   * decimal fraction in [0, 1] to four places — or `null` when there was no
   * observed expense to attribute. `null` and `"0.0000"` are different
   * statements: one says "nothing to measure", the other "we measured, and none
   * of it is accounted for".
   */
  readonly coverage: string | null;
  /**
   * True when attribution exceeded observation and the rate was clamped. Not an
   * error to swallow — it means matching is over-claiming, and the number the
   * user is reading rests on it.
   */
  readonly clampedAtZero: boolean;
}

/**
 * Compute the residual discretionary daily rate and its coverage share.
 *
 * @param observedExpenseInWindow - Total observed expense over the window, as a
 *   positive magnitude. Must describe the SAME window as `windowDays`.
 * @param obligationOutflowInWindow - Expense over that window attributable to
 *   confirmed obligations: matched occurrences at their actual amounts, plus
 *   unmatched-but-confirmed occurrences at their snapshotted `expected_amount`
 *   (ADR-038 §2). A positive magnitude.
 * @param windowDays - Days the window spans. Must be positive.
 * @returns The clamped daily rate, its coverage share, and whether it clamped.
 * @throws If `windowDays` is not positive, or either amount is negative — both
 *   are magnitudes, and a negative one is an upstream bug that must not be
 *   absorbed into a number a household makes a spending decision on.
 */
export function residualDailyRate(
  observedExpenseInWindow: string,
  obligationOutflowInWindow: string,
  windowDays: number,
): ResidualRate {
  if (!Number.isFinite(windowDays) || windowDays <= 0) {
    throw new Error(`residualDailyRate: window must span at least one day, got ${windowDays}`);
  }

  const observed = Money.fromString(observedExpenseInWindow, CURRENCY);
  const attributed = Money.fromString(obligationOutflowInWindow, CURRENCY);
  if (observed.isNegative() || attributed.isNegative()) {
    throw new Error("residualDailyRate: expense and attribution are magnitudes, never negative");
  }

  const residual = observed.sub(attributed);
  const clampedAtZero = residual.isNegative();
  // divFloor, NOT div: this quotient is a RATE that the projection multiplies
  // back by its own day count. Half-even rounding would let $1,200 over 31 days
  // become $38.71/day and spend $1,200.01 — a cent the household never spent,
  // in the direction that understates safe-to-spend. The no-double-count
  // invariant (P16-16) catches this exactly, and did.
  const dailyRate = clampedAtZero ? Money.zero(CURRENCY) : residual.divFloor(windowDays);

  return {
    dailyRate: dailyRate.toString(),
    coverage: coverageShare(observed, attributed),
    clampedAtZero,
  };
}

/**
 * Attributed ÷ observed, capped at 1 — or `null` when there is no denominator.
 *
 * Capped rather than allowed past 1 for the same reason the rate is clamped:
 * "127% of your spending is known bills" is not a fact about a household, it is
 * a fact about the matcher, and it belongs in `clampedAtZero`.
 */
function coverageShare(observed: Money, attributed: Money): string | null {
  if (observed.isZero()) return null;

  const share = new Decimal(attributed.toString()).dividedBy(new Decimal(observed.toString()));
  const capped = share.greaterThan(1) ? new Decimal(1) : share;
  return capped.toFixed(COVERAGE_DP);
}
