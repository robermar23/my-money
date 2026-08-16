import { Money } from "@/lib/money/money.ts";
import Decimal from "decimal.js";

/**
 * Money comparison and clamping helpers for the advice layer (Phase 15, Batch 3).
 *
 * {@link Money} deliberately exposes only `isZero()` / `isNegative()` rather than
 * `gt`/`lt`, which is the right minimal surface for a money type — but it means
 * every comparison in a rule reads `a.sub(b).isNegative()`, and a rule that gets
 * that backwards tells a household their emergency fund is funded when it is not.
 * Eight rule modules need the same handful of comparisons, so they live here once,
 * named, and tested.
 *
 * There is no arithmetic here that isn't already in `Money` — this is naming, not
 * new math (CLAUDE.md §Money: every operation still goes through Decimal).
 */

/** Every figure in this app is USD unless it came off a `families` row. */
export const USD = "USD";

/** Parse a money string as USD. Shorthand for the most repeated line in Batch 3. */
export function m(value: string): Money {
  return Money.fromString(value, USD);
}

/** Zero USD. */
export function zero(): Money {
  return Money.zero(USD);
}

/** `a > b`. */
export function gt(a: Money, b: Money): boolean {
  const diff = a.sub(b);
  return !diff.isNegative() && !diff.isZero();
}

/** `a >= b`. */
export function gte(a: Money, b: Money): boolean {
  return !a.sub(b).isNegative();
}

/** `a < b`. */
export function lt(a: Money, b: Money): boolean {
  return a.sub(b).isNegative();
}

/** The larger of two amounts. */
export function maxMoney(a: Money, b: Money): Money {
  return gt(a, b) ? a : b;
}

/** The smaller of two amounts. */
export function minMoney(a: Money, b: Money): Money {
  return lt(a, b) ? a : b;
}

/**
 * Floor an amount at zero.
 *
 * Used wherever a *gap* is computed: an emergency fund that is over target has a
 * gap of zero, not a negative shortfall that would render as "you need
 * -$4,200 more".
 */
export function clampAtZero(a: Money): Money {
  return a.isNegative() ? zero() : a;
}

/** True when the amount is strictly greater than zero. */
export function isPositive(a: Money): boolean {
  return !a.isNegative() && !a.isZero();
}

/**
 * A percentage string ("4.5000") applied to an amount, rounded to cents.
 *
 * The percentage convention Batch 1 locked for `accounts.apy`,
 * `minimum_payment_percent` and the split overrides. An APR is a decimal
 * fraction and must NOT come through here — use {@link fractionOf}.
 */
export function percentOf(amount: Money, percent: string): Money {
  return amount.mul(percent).div(100);
}

/**
 * A decimal fraction ("0.070000") applied to an amount, rounded to cents.
 *
 * The convention for `credit_lines.apr`, `liabilities.annual_rate` and
 * `high_interest_threshold_apr`.
 */
export function fractionOf(amount: Money, fraction: string): Money {
  return m(amount.mul(fraction).toString());
}

/** Compare two rate strings in the same unit. Returns -1 / 0 / 1. */
export function compareRates(a: string, b: string): number {
  return new Decimal(a).comparedTo(new Decimal(b));
}

/**
 * Round a ratio up to whole months.
 *
 * "You will close the gap in 7.2 months" is a promise; "8 months" is the honest
 * rounding when payments land monthly.
 */
export function ceilMonths(amount: Money, perMonth: Money): number | null {
  if (!isPositive(perMonth)) return null;
  return new Decimal(amount.toString())
    .dividedBy(new Decimal(perMonth.toString()))
    .ceil()
    .toNumber();
}
