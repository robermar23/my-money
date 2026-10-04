import { Money } from "@/lib/money/money.ts";
import { monthsBetween } from "@/lib/schedule/occurrences.ts";
import type { AccruedCost, KnownFutureCost } from "./types.ts";

/**
 * The accrual identity (P18-06, ADR-044) — straight-line over whole months from
 * a stated funding start.
 *
 * One pure function, no I/O (ADR-044 §8): every database read in this phase
 * lives in the one loader, so the figure the advice rule states and the figure
 * `/plan/sinking` prints come out of the same arithmetic and cannot disagree.
 *
 * ── The one-division rule, and why `perMonth × elapsed` is NOT it ──────────
 * [IDEAS3.md](../../../plans/features/IDEAS3.md) Round 12.2 states the math as
 * *"required monthly set-aside = amount ÷ months to due; required balance today
 * = elapsed months × that rate."* Right model, wrong implementation: taken
 * literally it **rounds twice** — once computing the rate to cents, again
 * multiplying the rate back up. Worked, with Round 12's own example:
 *
 *     $1,340 of car insurance over 7 months
 *       perMonth        = 1340 ÷ 7      = $191.43   (rounded to cents)
 *       191.43 × 7                      = $1,340.01 ← a cent nobody ever owed
 *       1340 × 7 ÷ 7                    = $1,340.00 ← what this module computes
 *
 * So `requiredToday = amount × elapsedMonths ÷ totalMonths`, as
 * `Money.mul(elapsed).div(total)` — **one** rounding, monotone non-decreasing in
 * `elapsed`, and **exactly `amount` when `elapsed === total`**. On the day the
 * bill is due the requirement IS the bill, as a string. A cent of drift sounds
 * like nothing, but it is systematic across every cost and every month, and it
 * lands on a figure whose entire credibility is that it reconciles against an
 * itemized table. ADR-044 deliberately refines the round's literal formula and
 * says so, so a reader comparing the two finds a reason rather than a
 * discrepancy.
 *
 * **`requiredToday` is authoritative; `perMonth` is a display figure.** They may
 * differ by a cent or two. That is stated here rather than left for a future
 * reader to discover from a failing test, and [accrual.test.ts](./accrual.test.ts)
 * pins the difference so nobody "simplifies" one into the other.
 *
 * ── Why `perMonth` uses `div` and not `divFloor` ───────────────────────────
 * [money.ts](../money/money.ts)'s own header draws the line: `div` to SPLIT a
 * known total (half-even, the fair rounding), `divFloor` for a RATE that will be
 * multiplied back by the same divisor. A monthly set-aside is a fair split of a
 * cost that is already known exactly, so `div` is the right half of that split —
 * and nothing here multiplies it back, because `requiredToday` does not go
 * through it.
 *
 * The direction of danger is **opposite** to ADR-038 §2's, which is why this is
 * not a contradiction of it. There, truncating a projected daily rate protects
 * against overstating outflow, which would understate safe-to-spend. Here the
 * dangerous direction is **under**-collecting: a rate rounded down tells a
 * household to set aside less than the bill, every month, and `divFloor` would
 * guarantee it. Twelve months of $191.42 instead of $191.43 arrives a cent short
 * — small, and still the wrong side of a bill that must be paid in full.
 *
 * ── Both clamps, stated rather than incidental (ADR-044 §5) ───────────────
 *   - `totalMonths = max(1, monthsBetween(fundingStart, dueDate))`. The floor is
 *     not defensive coding: without it a cost due inside the month divides by
 *     zero, and the honest answer for a cost due in ten days is *"you need all
 *     of it now"* — exactly what `totalMonths = 1` produces.
 *   - `elapsedMonths` is clamped to `[0, totalMonths]`. The lower bound comes
 *     free from `monthsBetween`, which floors at zero, so a funding start in the
 *     future yields `"0.00"`. The upper bound is this module's: without it a
 *     cost four months past due would require $8,000 against a $6,000 bill. The
 *     upper bound is reached **on the due date**, not merely when the month
 *     count says so — see the comment at the clamp for why the distinction is
 *     load-bearing once the floor above exists.
 *
 * ── Whole months, not days (ADR-044 §6) ───────────────────────────────────
 * `monthsBetween` counts month boundaries crossed, so the requirement steps up
 * on the monthly anniversary rather than creeping every morning. Households set
 * money aside per paycheck or per month, and a figure that moves daily trains
 * the user to check whether it moved rather than whether they are on track.
 * **This is a design choice, not a rounding artefact** — do not "fix" it to
 * daily proration.
 *
 * ── No date math of its own ───────────────────────────────────────────────
 * Every month count goes through the **one** shipped `monthsBetween` (P17-07's
 * consolidation), which also inherits its strict `YYYY-MM-DD` validation. This
 * module writes no date arithmetic; if it ever appears to need some, that is the
 * signal an existing helper is being reimplemented (ADR-036 §5).
 */

/**
 * Resolve one known future cost into its accrual.
 *
 * @param cost - The cost, with its amount as a `numeric(18,2)` string and its
 *   `fundingStart` stated rather than inferred.
 * @param today - Inclusive `YYYY-MM-DD` evaluation date, passed in rather than
 *   read from the clock so the function is pure and the invariant suite can walk
 *   it day by day.
 * @returns The cost with `totalMonths`, `elapsedMonths`, `perMonth`,
 *   `requiredToday` and `pastDue` resolved. Money fields are non-negative
 *   `numeric(18,2)` strings.
 * @throws If any of the three dates is not a real calendar date, or if `amount`
 *   is not a parsable decimal — both surfaced by the shipped helpers rather than
 *   re-checked here.
 */
export function accrue(cost: KnownFutureCost, today: string): AccruedCost {
  const totalMonths = Math.max(1, monthsBetween(cost.fundingStart, cost.dueDate));
  // Counted here rather than inside the branch so a bad `today` fails the same
  // way for every status.
  const monthsElapsed = monthsBetween(cost.fundingStart, today);
  const zero = Money.zero(cost.currency).toString();

  // ADR-044 §7. A paid bill is not overdue and a cancelled cost is not a cost,
  // so neither accrues and neither is past due — but both keep their real term,
  // because the row stays listed with its own history (deactivate, never
  // delete).
  if (cost.status !== "planned") {
    return {
      cost,
      totalMonths,
      elapsedMonths: 0,
      perMonth: zero,
      requiredToday: zero,
      pastDue: false,
    };
  }

  // The upper clamp, and it is the DUE DATE that drives it rather than the month
  // count alone. Once §3's floor exists the two can disagree: a cost due in ten
  // days has `totalMonths = 1` but crosses no month boundary before it lands, so
  // a pure `min(total, monthsBetween(start, today))` would require "0.00" on the
  // due date and for weeks after it — understating, which is the dangerous
  // direction for a set-aside, and flatly contrary to ADR-044 §5's "a due date
  // in the past yields `amount`". The identity the phase actually promises is
  // "on or after the due date, you need all of it", so that is what is written.
  const elapsedMonths = cost.dueDate <= today ? totalMonths : Math.min(totalMonths, monthsElapsed);
  const amount = Money.fromString(cost.amount, cost.currency);

  return {
    cost,
    totalMonths,
    elapsedMonths,
    // A fair split of a known total — see the header on `div` vs `divFloor`.
    perMonth: amount.div(totalMonths).toString(),
    // ONE division. Never `perMonth × elapsedMonths`.
    requiredToday: amount.mul(elapsedMonths).div(totalMonths).toString(),
    pastDue: cost.dueDate < today,
  };
}
