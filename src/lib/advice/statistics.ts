import { Money } from "@/lib/money/money.ts";
import Decimal from "decimal.js";

/**
 * Order statistics over money strings (Phase 15, PLAN15 Batch 2).
 *
 * ADR-034 §3 is the reason this module exists at all: **baselines use the
 * MEDIAN (or p75 where a buffer is wanted), not the mean.** That is a deliberate
 * divergence from [forecast.ts](../analytics/forecast.ts), whose trailing mean is
 * correct for *forecasting* and wrong for *target-setting* — one $2,000
 * transmission repair permanently inflates an Auto target built on a mean, and
 * the user then misses that target every month for a year.
 *
 * Both baseline computations in this batch (observed net income, essential
 * expenses) need the same statistic, and the budget suggester (P15-24) needs the
 * p75 variant, so the arithmetic lives in one tested place rather than three.
 *
 * Money discipline (CLAUDE.md §Money): every value in and out is a `numeric`
 * string; interpolation between two ranks goes through {@link Money}/Decimal.
 * `Number()` never appears here.
 *
 * ── Empty input returns `null`, never "0.00" ───────────────────────────────
 * "The median of no months" and "the median is zero dollars" are different
 * answers, and the whole phase rests on telling them apart (ADR-032 consequence
 * 1). A zero here would flow into a reserve target of $0 and read as *funded*.
 */

const CURRENCY = "USD";

/**
 * Percentile of a set of money strings using the R-7 method — the linear
 * interpolation between closest ranks that Excel's `PERCENTILE` and numpy's
 * default use. At `p = 0.5` this collapses to the conventional median: the
 * middle value for an odd count, the mean of the two middle values for an even
 * one.
 *
 * @param values - Unordered money strings. Order does not matter; a copy is sorted.
 * @param p - Percentile in [0, 1]. Clamped into range.
 * @returns The percentile as a money string, or `null` when `values` is empty.
 */
export function percentileMoney(values: readonly string[], p: number): string | null {
  if (values.length === 0) return null;

  const sorted = values
    .map((v) => new Decimal(v))
    .sort((a, b) => (a.lessThan(b) ? -1 : a.greaterThan(b) ? 1 : 0));
  if (sorted.length === 1)
    return Money.fromString(sorted[0]?.toString() ?? "0", CURRENCY).toString();

  const clamped = Math.min(1, Math.max(0, p));
  // R-7 rank: h = (n − 1) · p, then interpolate between floor(h) and ceil(h).
  const h = new Decimal(sorted.length - 1).times(clamped);
  const lowIndex = h.floor().toNumber();
  const highIndex = h.ceil().toNumber();
  const low = sorted[lowIndex];
  const high = sorted[highIndex];
  if (!low || !high) return null;

  if (lowIndex === highIndex) {
    return Money.fromString(low.toString(), CURRENCY).toString();
  }

  // low + (high − low) × frac, all through Money so the cents are exact.
  const frac = h.minus(lowIndex);
  const lowMoney = Money.fromString(low.toString(), CURRENCY);
  const highMoney = Money.fromString(high.toString(), CURRENCY);
  return lowMoney.add(highMoney.sub(lowMoney).mul(frac.toString())).toString();
}

/**
 * Median of a set of money strings — {@link percentileMoney} at p = 0.5.
 *
 * This is the statistic behind every baseline in Phase 15 (ADR-034 §3).
 *
 * @param values - Unordered money strings.
 * @returns The median as a money string, or `null` when `values` is empty.
 */
export function medianMoney(values: readonly string[]): string | null {
  return percentileMoney(values, 0.5);
}

/**
 * A ratio of two money amounts, as a plain number in [0, ∞).
 *
 * Ratios are NOT money — they carry no currency and are never summed — so
 * returning a `number` here is correct rather than a shortcut, and matches the
 * existing `percent()` display ratio in [budgets/queries.ts](../budgets/queries.ts).
 * The division itself still runs through Decimal so a long repeating quotient
 * doesn't pick up float noise before it is rounded.
 *
 * @param numerator - Money string.
 * @param denominator - Money string. Zero (or negative) yields `0` — a share of
 *   nothing is nothing, never `NaN`/`Infinity` leaking into a rendered figure.
 * @param decimals - Places to round to. Default 4 (enough for "18.35%").
 * @returns The ratio, e.g. `0.1835` for 18.35%.
 */
export function shareOf(numerator: string, denominator: string, decimals = 4): number {
  const den = new Decimal(denominator);
  if (den.lessThanOrEqualTo(0)) return 0;
  return new Decimal(numerator).dividedBy(den).toDecimalPlaces(decimals).toNumber();
}

/**
 * How many multiples of `unit` fit into `amount` — "months of expenses covered".
 *
 * Like {@link shareOf} this is a ratio, not money. It returns `null` rather than
 * `0` or `Infinity` when `unit` is zero or unknown, because "we cannot say how
 * many months this covers" must not render as "0 months of runway" (which reads
 * as an emergency) or as "∞" (which reads as solved).
 *
 * @param amount - Money string (a tier total, a balance).
 * @param unit - Money string (the monthly essential baseline). `null`/zero → `null`.
 * @param decimals - Places to round to. Default 2.
 * @returns The coverage multiple as a string, or `null` when it is unknowable.
 */
export function coverageMultiple(amount: string, unit: string | null, decimals = 2): string | null {
  if (unit === null) return null;
  const u = new Decimal(unit);
  if (u.lessThanOrEqualTo(0)) return null;
  return new Decimal(amount).dividedBy(u).toDecimalPlaces(decimals).toString();
}
