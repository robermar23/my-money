import { Money } from "@/lib/money/money.ts";
import Decimal from "decimal.js";

/**
 * Lot aggregation + cost-basis precedence (Phase 5, ADR-012).
 *
 * Cost-basis precedence (single source of truth):
 *   sum(lots.cost_basis_total) when any lots exist
 *   → else holding.cost_basis (manual or Plaid aggregate)
 *   → else null (unknown).
 *
 * Quantities use Decimal (28,8 precision); cost basis uses Money. Per-unit
 * basis is derived at display, never stored as a lossy float division.
 */

/** The lot fields these helpers consume — a structural subset of `HoldingLot`. */
export interface LotInput {
  readonly quantity: string;
  readonly costBasisTotal: string;
}

export interface LotAggregate {
  /** Sum of lot quantities, trimmed Decimal string (e.g. "4", "0.3"). */
  readonly totalQuantity: string;
  readonly totalCostBasis: Money;
}

/**
 * Sum lot quantities and cost bases.
 *
 * @param lots - The lots to aggregate.
 * @param currency - Currency for the cost-basis sum.
 * @returns Total quantity (string) and total cost basis (Money).
 */
export function aggregateLots(lots: readonly LotInput[], currency: string): LotAggregate {
  let quantity = new Decimal(0);
  let totalCostBasis = Money.zero(currency);
  for (const lot of lots) {
    quantity = quantity.plus(new Decimal(lot.quantity));
    totalCostBasis = totalCostBasis.add(Money.fromString(lot.costBasisTotal, currency));
  }
  return { totalQuantity: quantity.toString(), totalCostBasis };
}

/**
 * Resolve a holding's cost basis per the precedence rule.
 *
 * @param holding - The holding's aggregate `cost_basis` (nullable).
 * @param lots - Any lots recorded for the holding.
 * @param currency - Currency for the result.
 * @returns Resolved cost basis, or null when neither lots nor an aggregate exist.
 */
export function resolveCostBasis(
  holding: { readonly costBasis: string | null },
  lots: readonly LotInput[],
  currency: string,
): Money | null {
  if (lots.length > 0) {
    return aggregateLots(lots, currency).totalCostBasis;
  }
  if (holding.costBasis !== null) {
    return Money.fromString(holding.costBasis, currency);
  }
  return null;
}

export interface LotCoverage {
  /** Sum of lot quantities (string). */
  readonly coveredQty: string;
  /** The holding's quantity (string). */
  readonly holdingQty: string;
  /** True when lots exactly cover the position. */
  readonly isComplete: boolean;
}

/**
 * How much of a position its lots account for — drives the "lots cover N of M
 * shares" UI note (P5-19).
 */
export function lotCoverage(
  holding: { readonly quantity: string },
  lots: readonly Pick<LotInput, "quantity">[],
): LotCoverage {
  let covered = new Decimal(0);
  for (const lot of lots) {
    covered = covered.plus(new Decimal(lot.quantity));
  }
  const holdingQty = new Decimal(holding.quantity);
  return {
    coveredQty: covered.toString(),
    holdingQty: holdingQty.toString(),
    isComplete: covered.equals(holdingQty),
  };
}
