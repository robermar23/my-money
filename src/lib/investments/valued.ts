import "server-only";

import { valueHolding } from "@/lib/holdings/value.ts";
import { resolveCostBasis } from "@/lib/investments/lots.ts";
import {
  type BalanceOnlyAccount,
  type InvestmentPosition,
  listBalanceOnlyInvestmentAccounts,
  listInvestmentLots,
  listInvestmentPositions,
} from "@/lib/investments/queries.ts";
import type { Money } from "@/lib/money/money.ts";

/**
 * Shared "valued positions" loader (Phase 13, P13-02).
 *
 * The `/investments` overview and `/investments/forecast` pages each value every
 * position the same way — price each holding as of today, resolve its cost basis
 * (cash positions are basis-free), and keep balance-only accounts (e.g. a 401k
 * Plaid reports only as a total) alongside. The Phase-13 dashboard loader needs
 * the *same* assembly to feed `allocationByAssetClass` and `forwardIncome`, so it
 * lives here as one tested helper rather than a third inline copy — keeping the
 * dashboard's numbers identical by construction to the dedicated pages (ADR-029).
 *
 * Server-only (it calls the price-backed {@link valueHolding}); money stays in
 * {@link Money}/string end-to-end — no `Number()` here.
 */

/** One priced position with its resolved basis. */
export interface ValuedPosition {
  readonly position: InvestmentPosition;
  /** quantity × latest close (or face value for cash); `Money.zero` when unpriced. */
  readonly value: Money;
  /** Resolved cost basis, or null when unknown (cash, manual, no lots). */
  readonly costBasis: Money | null;
  /** True when a real price (or cash face value) backs `value`. */
  readonly priced: boolean;
}

export interface ValuedPositions {
  readonly positions: readonly ValuedPosition[];
  readonly balanceOnly: readonly BalanceOnlyAccount[];
}

/**
 * Value every investment/crypto_ira position as of `asOf`, plus the balance-only
 * accounts that carry value but no itemized holdings.
 *
 * @param asOf - Valuation date (`YYYY-MM-DD`). Defaults to today (UTC).
 * @returns Priced positions (with basis) and the balance-only accounts.
 */
export async function listValuedPositions(asOf?: string): Promise<ValuedPositions> {
  const today = asOf ?? new Date().toISOString().slice(0, 10);

  const [positions, lots, balanceOnly] = await Promise.all([
    listInvestmentPositions(),
    listInvestmentLots(),
    listBalanceOnlyInvestmentAccounts(),
  ]);

  const lotsByHolding = new Map<string, { quantity: string; costBasisTotal: string }[]>();
  for (const lot of lots) {
    const arr = lotsByHolding.get(lot.holdingId) ?? [];
    arr.push({ quantity: lot.quantity, costBasisTotal: lot.costBasisTotal });
    lotsByHolding.set(lot.holdingId, arr);
  }

  const valued = await Promise.all(
    positions.map(async (p): Promise<ValuedPosition> => {
      const currency = p.accountCurrency;
      const valuation = await valueHolding(p.holding, currency, today);
      // Cash positions have no basis/gain (the inflow isn't a purchase); mirrors
      // the overview/forecast pages so the dashboard agrees with them.
      const isCash = p.holding.assetClass === "cash";
      const costBasis = isCash
        ? null
        : resolveCostBasis(
            { costBasis: p.holding.costBasis },
            lotsByHolding.get(p.holding.id) ?? [],
            currency,
          );
      const priced = valuation.closeUsed !== null || isCash;
      return { position: p, value: valuation.value, costBasis, priced };
    }),
  );

  return { positions: valued, balanceOnly };
}
