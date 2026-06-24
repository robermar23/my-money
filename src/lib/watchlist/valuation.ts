import { type GainLoss, gainLoss } from "@/lib/investments/gain-loss.ts";
import { Money } from "@/lib/money/money.ts";

/**
 * Paper-position valuation for a watchlist item (Phase 11, P11-09, ADR-025).
 *
 * A watch row may carry an OPTIONAL "pretend" buy (`pretendQuantity` +
 * `pretendUnitCost`). When present, we show a simple DISPLAY gain/loss exactly
 * like a real holding — `value − costBasis`, where `value = latestClose × qty`
 * and `costBasis = unitCost × qty`. This is never realized P&L, tax lots, or a
 * 1099 (CLAUDE.md §Domain Scope); it never touches net worth (the row is neither
 * an account nor a holding).
 *
 * Pure + Money-only — no `Number()`, no clock, no I/O (CLAUDE.md §Money). The two
 * "unknown" cases collapse cleanly to nulls:
 *   - watch-only (no pretend position) → value/costBasis/gain all null
 *   - pretend position but no price yet → costBasis known, value + gain null
 */
export interface PaperPosition {
  /** Pretend share/coin/oz count, or null when watch-only. */
  readonly pretendQuantity: string | null;
  /** Pretend price per unit at purchase, or null when watch-only. */
  readonly pretendUnitCost: string | null;
  /** Currency of the position (and of `latestClose`). */
  readonly currency: string;
}

export interface PaperValuation {
  /** qty × latestClose, or null when watch-only or the price is missing. */
  readonly value: Money | null;
  /** qty × unitCost, or null when watch-only. */
  readonly costBasis: Money | null;
  /** Display gain/loss over the basis; nulls when value or basis is unknown. */
  readonly gainLoss: GainLoss;
}

const NO_GAIN: GainLoss = { absolute: null, percent: null };

/**
 * Value a watchlist item's pretend position against its latest close.
 *
 * @param item - The pretend-position columns + currency.
 * @param latestClose - Latest close (decimal string) or null when unpriced.
 * @returns Value, cost basis, and gain/loss — with nulls for the unknown cases.
 */
export function paperValuation(item: PaperPosition, latestClose: string | null): PaperValuation {
  // Watch-only: no pretend position to value.
  if (item.pretendQuantity === null || item.pretendUnitCost === null) {
    return { value: null, costBasis: null, gainLoss: NO_GAIN };
  }
  const costBasis = Money.fromString(item.pretendUnitCost, item.currency).mul(item.pretendQuantity);
  // Basis is known, but with no price the value (and gain) is unknowable.
  if (latestClose === null) {
    return { value: null, costBasis, gainLoss: NO_GAIN };
  }
  const value = Money.fromString(latestClose, item.currency).mul(item.pretendQuantity);
  return { value, costBasis, gainLoss: gainLoss({ value, costBasis }) };
}
