import { Money } from "@/lib/money/money.ts";
import Decimal from "decimal.js";

/**
 * Investment gain/loss math (Phase 5, ADR-012). Pure functions over `Money` —
 * never raw `Number` arithmetic (CLAUDE.md §Money & Numeric Precision).
 *
 * Gain/loss is a DISPLAY figure: `value − cost_basis`. This is not tax-lot
 * accounting (FIFO/LIFO/wash sales / realized vs. unrealized) — those are out
 * of scope per CLAUDE.md §Domain Scope.
 */

export interface Position {
  readonly value: Money;
  /** Resolved cost basis (see lots.ts). `null` = unknown → gain/loss is "—". */
  readonly costBasis: Money | null;
}

export interface GainLoss {
  /** value − costBasis, or null when basis is unknown. */
  readonly absolute: Money | null;
  /** Percent string (2dp), or null when basis is unknown or zero. */
  readonly percent: string | null;
}

/** Percent of `absolute` relative to `basis`, or null when basis is zero. */
function percentOf(absolute: Money, basis: Money): string | null {
  const basisDec = new Decimal(basis.toString());
  if (basisDec.isZero()) return null;
  return new Decimal(absolute.toString())
    .dividedBy(basisDec)
    .times(100)
    .toDecimalPlaces(2)
    .toFixed(2);
}

/**
 * Gain/loss for a single position.
 *
 * @param position - Current value and resolved cost basis (same currency).
 * @returns Absolute gain (Money) and percent (string), or nulls when basis is
 *   unknown. Percent is null (not zero) when basis is exactly zero.
 * @throws If `value` and `costBasis` carry different currencies.
 */
export function gainLoss({ value, costBasis }: Position): GainLoss {
  if (costBasis === null) {
    return { absolute: null, percent: null };
  }
  const absolute = value.sub(costBasis);
  return { absolute, percent: percentOf(absolute, costBasis) };
}

export interface PortfolioGainLoss {
  /** Sum of every position's value. */
  readonly totalValue: Money;
  /** Sum of known cost bases, or null when no position has a known basis. */
  readonly totalCostBasis: Money | null;
  /** Gain over the basis-known subset, or null when none is known. */
  readonly absolute: Money | null;
  readonly percent: string | null;
}

/**
 * Aggregate gain/loss across positions. `totalValue` covers every position;
 * gain/loss covers only the subset with a known cost basis (so unknown-basis
 * holdings don't silently distort the figure).
 *
 * @param positions - The valued positions.
 * @param currency - Currency to sum in (all positions must share it).
 * @returns Portfolio totals + gain/loss over the basis-known subset.
 */
export function portfolioGainLoss(
  positions: readonly Position[],
  currency: string,
): PortfolioGainLoss {
  const totalValue = Money.sum(
    positions.map((p) => p.value),
    currency,
  );

  const known = positions.filter(
    (p): p is { value: Money; costBasis: Money } => p.costBasis !== null,
  );
  if (known.length === 0) {
    return { totalValue, totalCostBasis: null, absolute: null, percent: null };
  }

  const totalCostBasis = Money.sum(
    known.map((p) => p.costBasis),
    currency,
  );
  const knownValue = Money.sum(
    known.map((p) => p.value),
    currency,
  );
  const absolute = knownValue.sub(totalCostBasis);
  return { totalValue, totalCostBasis, absolute, percent: percentOf(absolute, totalCostBasis) };
}
