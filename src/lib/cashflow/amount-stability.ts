import type { ObligationAmountMode } from "@/db/schema/scheduled-obligations.ts";
import { Money } from "@/lib/money/money.ts";

/**
 * amountStability: is this obligation a fixed amount or a moving one?
 * (P16-10, ADR-037 §1.)
 *
 * Pure and I/O-free. Given the amounts one payee was charged across a detected
 * series, produce the amount the projection should use and decide how it should
 * be priced going forward — `fixed` for rent and subscriptions, then
 * `trailing_median` for a utility bill that moves with the season.
 *
 * ── Median and MAD, never mean and standard deviation ──────────────────────
 * Both statistics here are the ROBUST ones, and the choice is the substance of
 * this module rather than a stylistic preference.
 *
 * A mean is dragged by one extreme value; a standard deviation is dragged by
 * its SQUARE. Eleven $2,000 rents and one $2,400 annual true-up have a standard
 * deviation over $100 — enough to label a perfectly fixed rent "variable" and
 * hand it to `trailing_median`, which would then re-price every future month
 * off a window that included the one-off. The median absolute deviation of the
 * same series is exactly zero, because a median does not care that one value is
 * far away. There is a test named for precisely this case; it is the one to
 * keep if this file is ever rewritten.
 *
 * The same asymmetry runs the other way: a genuinely seasonal bill has
 * dispersion in its SHAPE, not in one point, so the MAD stays large and the
 * mode correctly comes back `trailing_median`.
 *
 * ── The threshold ──────────────────────────────────────────────────────────
 * `fixed` when the MAD is at most `FIXED_SPREAD_RATIO` of the median, i.e. 2%,
 * inclusive. Stated as an exported constant and asserted in the tests rather
 * than buried, so the number is reviewable — the same posture ADR-034 §6 took
 * for the high-interest threshold.
 *
 * ── Money ──────────────────────────────────────────────────────────────────
 * Every value here is a `NUMERIC(18,2)` string carried through `Money`, and the
 * comparison used to sort is `Money.compare`, which orders through Decimal.
 * Nothing rounds through `Number` — a median computed on floats would put
 * fractions of a cent into the projection at its very first step (CLAUDE.md
 * §Money). The threshold test multiplies rather than dividing, so no ratio is
 * ever materialized and no precision is lost to `Money.div`'s cent rounding.
 */

/**
 * The MAD-to-median ratio at or below which an obligation counts as fixed.
 *
 * A unitless decimal string, applied by multiplication so the comparison stays
 * exact. Two percent is deliberately generous: rounding, tax, and a fee that
 * changes by a dime are all still a fixed bill.
 */
export const FIXED_SPREAD_RATIO = "0.02";

/** What the amounts of a detected series say about how to price it. */
export interface AmountStability {
  /** The typical amount, as a positive magnitude. `NUMERIC(18,2)` string. */
  readonly median: string;
  /** Median absolute deviation, in currency units. Zero for a fixed series. */
  readonly spread: string;
  /** How the projection should price future occurrences. */
  readonly mode: ObligationAmountMode;
}

/**
 * Median of a non-empty list of Money, exact to the cent.
 *
 * The even case averages the middle pair through `Money.div`, which rounds
 * half-even to two places — the same rounding the storage column applies.
 */
function medianMoney(values: readonly Money[], currency: string): Money {
  const sorted = [...values].sort((a, b) => a.compare(b));
  const mid = sorted.length >> 1;
  if (sorted.length % 2 === 1) return sorted[mid] as Money;
  const lower = sorted[mid - 1] as Money;
  const upper = sorted[mid] as Money;
  return Money.sum([lower, upper], currency).div(2);
}

/**
 * Summarize the amounts of a detected series.
 *
 * @param amounts - Money strings for every occurrence of one payee in one
 *   account, in any order. Signed values are accepted and reported as
 *   magnitudes, but the signs must agree — see below.
 * @param currency - ISO code the amounts are denominated in. Defaults to USD,
 *   the household base currency.
 * @returns The median amount, its median absolute deviation, and the pricing
 *   mode the projection should use.
 * @throws If `amounts` is empty, if any entry is not a valid money string, or
 *   if the entries mix positive and negative values. Mixed signs mean charges
 *   and refunds have been grouped together, and a median across both describes
 *   a bill that does not exist; the caller splits by direction first.
 */
export function amountStability(amounts: readonly string[], currency = "USD"): AmountStability {
  if (amounts.length === 0) {
    throw new Error("amountStability requires at least one amount");
  }

  const parsed = amounts.map((amount) => Money.fromString(amount, currency));
  const hasNegative = parsed.some((money) => money.isNegative());
  const hasPositive = parsed.some((money) => !money.isNegative() && !money.isZero());
  if (hasNegative && hasPositive) {
    throw new Error("amountStability requires a consistent sign; group by direction first");
  }

  const magnitudes = parsed.map((money) => money.abs());
  const median = medianMoney(magnitudes, currency);
  const deviations = magnitudes.map((money) => money.sub(median).abs());
  const spread = medianMoney(deviations, currency);

  // Multiply rather than divide: `spread <= median * ratio` is the same test as
  // `spread / median <= ratio` without materializing a ratio Money.div would
  // round to cents. A zero median has no meaningful ratio, and a zero spread
  // beside it is as fixed as an amount can be.
  const tolerance = median.mul(FIXED_SPREAD_RATIO);
  const mode: ObligationAmountMode = spread.compare(tolerance) <= 0 ? "fixed" : "trailing_median";

  return {
    median: median.toString(),
    spread: spread.toString(),
    mode,
  };
}
