import Decimal from "decimal.js";

/**
 * Where a holding's cost basis came from (Phase 14, P14-16, ADR-031).
 *
 * Phase 14 makes payroll contributions a real source of cost basis: the
 * materialization job writes `holding_lots` rows with `source='income'`, which
 * flow through the existing `resolveCostBasis` precedence untouched. That is the
 * whole trick — gain/loss on a 401k "just works" with no change to the
 * investment machinery.
 *
 * But it leaves a number on screen whose *provenance* is not obvious. A 401k
 * that showed "—" for cost basis last month now shows a figure, and the user is
 * entitled to know it came from a rule they defined rather than from the
 * institution. These flags drive that annotation; they compute no money.
 *
 * The second flag matters more than it looks. When a contribution cannot be
 * priced — no holding designated, no symbol, or no close on the pay date — the
 * job records a **zero-quantity lot carrying the full basis** rather than
 * inventing a share count (ADR-031 §3). Basis is then real while quantity is
 * whatever the user typed, so value ÷ basis is only as good as that manual
 * quantity. Saying so is the difference between an honest figure and a
 * confidently wrong one.
 */

/** The lot fields provenance reads — a structural subset of `HoldingLot`. */
export interface ProvenanceLot {
  readonly quantity: string;
  readonly source: string;
}

export interface BasisProvenance {
  /** Any of the basis came from a payroll contribution rule. */
  readonly fromContributions: boolean;
  /**
   * At least one contribution lot recorded basis without shares, so the
   * position's quantity is the user's own entry rather than a bought amount.
   */
  readonly hasBasisOnlyContributions: boolean;
}

/**
 * Classify where a holding's lots came from.
 *
 * @param lots - The holding's cost-basis lots (any order; may be empty).
 * @returns Whether contributions fund the basis, and whether any of them are
 *   basis-only (zero-quantity).
 */
export function basisProvenance(lots: readonly ProvenanceLot[]): BasisProvenance {
  let fromContributions = false;
  let hasBasisOnlyContributions = false;
  for (const lot of lots) {
    if (lot.source !== "income") continue;
    fromContributions = true;
    if (new Decimal(lot.quantity).isZero()) hasBasisOnlyContributions = true;
  }
  return { fromContributions, hasBasisOnlyContributions };
}
