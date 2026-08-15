import type { NewHoldingLot } from "@/db/schema/index.ts";
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

/** The investment-transaction fields lot construction reads (a mapped row subset). */
export interface BuyTxnInput {
  readonly type: string;
  readonly quantity?: string | null;
  readonly amount: string;
  readonly tradeDate: string;
  readonly plaidInvestmentTransactionId?: string | null;
  readonly isoCurrencyCode?: string;
}

/** Where a lot came from — mirrors the `holding_lots.source` CHECK. */
export type LotSource = "manual" | "plaid" | "income";

/**
 * P5-14 — Construct a cost-basis lot from a `buy` investment transaction.
 *
 * The lot's cost basis is the absolute cash spent (`|amount|` — amounts arrive
 * already sign-flipped to our convention, so a buy is negative). Non-buy rows
 * and buys with no usable quantity yield null (only buys create shares to base).
 *
 * @param txn - A mapped investment-transaction row.
 * @param holdingId - The holding this lot belongs to.
 * @param source - Lot provenance. Defaults to 'plaid' (the P5-14 caller);
 *   the Phase-14 contribution job passes 'income' so its lots stay
 *   source-scoped and never mingle with synced ones (ADR-031 §5).
 * @returns A `NewHoldingLot`, or null when the row can't form a lot.
 */
export function lotFromBuy(
  txn: BuyTxnInput,
  holdingId: string,
  source: LotSource = "plaid",
): NewHoldingLot | null {
  if (txn.type !== "buy") return null;
  if (txn.quantity === null || txn.quantity === undefined) return null;
  const quantity = new Decimal(txn.quantity);
  if (quantity.isZero()) return null;

  const currency = txn.isoCurrencyCode ?? "USD";
  const cash = Money.fromString(txn.amount, currency);
  const costBasisTotal = cash.isNegative() ? cash.negate() : cash;

  return {
    holdingId,
    acquiredAt: txn.tradeDate,
    quantity: txn.quantity,
    costBasisTotal: costBasisTotal.toString(),
    source,
    plaidInvestmentTransactionId: txn.plaidInvestmentTransactionId,
  };
}
