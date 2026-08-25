import { Money } from "@/lib/money/money.ts";
import type { LowWaterMark, SafeToSpend } from "./types.ts";

/**
 * Safe-to-spend (P16-18, ADR-038 §5).
 *
 * `min(closing balance across the horizon) − cash_floor`, clamped at zero.
 *
 * ── Why the low point rather than the ending balance ───────────────────────
 * A horizon that ends at $4,000 but dips to $80 the week before payday has $80
 * of headroom, not $4,000. Spending against the ending balance is exactly how a
 * household overdrafts while its app tells it everything is fine. The binding
 * constraint is the worst moment in the window, so that is the moment the
 * figure is computed from — and its DATE travels with the number, because "you
 * can spend $312" is advice and "you can spend $312; the tight day is March 14"
 * is something a family can plan around.
 *
 * ── Why the clamp is not cosmetic ──────────────────────────────────────────
 * A negative result is not an allowance of minus two hundred dollars. It is a
 * SHORTFALL, a different kind of statement, and it is reported as one:
 * `clampedAtZero` says it happened, `shortfall` says how big it is, and
 * `bindingDate` says when. Clamping without carrying the size would destroy the
 * only part a household can act on — "you are short" and "you are short by
 * $1,400 on the 14th" ask for different responses.
 *
 * ── Landing exactly on the floor is not a shortfall ────────────────────────
 * `clampedAtZero` means the projection went BELOW the floor, not that the
 * answer happens to be zero. A household whose low point sits exactly on its
 * stated buffer has a plan that works with nothing to spare, and telling it
 * otherwise would be a false alarm. The distinction costs one comparison.
 *
 * ── The floor is echoed, always ────────────────────────────────────────────
 * ADR-038 §5 requires the floor beside the figure so the number is never
 * mistaken for a raw balance. It is returned rather than left to the caller to
 * remember, because a caller that forgets produces a screen that is wrong in a
 * way no test would catch.
 */

const CURRENCY = "USD";

/**
 * The part of a projection this function reads.
 *
 * Structural rather than the full {@link import("./types.ts").ProjectionResult},
 * so the day walk can call it mid-construction — before it has a result to pass
 * — without a circular type or a half-built object cast into shape.
 */
export interface SafeToSpendSource {
  readonly lowWaterMark: LowWaterMark | null;
}

/**
 * Compute what the household may spend without breaching its own floor.
 *
 * @param projection - Anything carrying a low-water mark; `null` for an empty
 *   horizon, which yields zero rather than a guess.
 * @param cashFloor - The user's stated buffer, a non-negative money string.
 * @returns The clamped amount, the date that bound it, the echoed floor, and —
 *   when the projection dips below the floor — the size of the shortfall.
 * @throws If `cashFloor` is negative. A negative floor would ADD to
 *   safe-to-spend, turning an overdraft allowance into budget; that is a data
 *   error upstream, not a preference to honour.
 */
export function safeToSpend(projection: SafeToSpendSource, cashFloor: string): SafeToSpend {
  const floor = Money.fromString(cashFloor, CURRENCY);
  if (floor.isNegative()) {
    throw new Error("safeToSpend: cash floor must be non-negative");
  }

  const lowWaterMark = projection.lowWaterMark;
  if (lowWaterMark === null) {
    return {
      amount: Money.zero(CURRENCY).toString(),
      bindingDate: null,
      floor: floor.toString(),
      clampedAtZero: false,
      shortfall: null,
    };
  }

  const headroom = Money.fromString(lowWaterMark.balance, CURRENCY).sub(floor);
  const short = headroom.isNegative();

  return {
    amount: short ? Money.zero(CURRENCY).toString() : headroom.toString(),
    bindingDate: lowWaterMark.date,
    floor: floor.toString(),
    clampedAtZero: short,
    shortfall: short ? headroom.abs().toString() : null,
  };
}
