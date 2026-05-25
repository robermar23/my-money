import "server-only";

import { db } from "@/db/client.ts";
import { type Holding, holdings } from "@/db/schema/index.ts";
import { Money } from "@/lib/money/money.ts";
import { latestCloseOnOrBefore } from "@/lib/prices/store.ts";
import Decimal from "decimal.js";
import { eq } from "drizzle-orm";

export interface HoldingValuation {
  readonly holding: Holding;
  /** Most-recent close used (string), or null if no price row exists. */
  readonly closeUsed: string | null;
  /** quantity * close. For `cash` holdings, equals quantity (face value). */
  readonly value: Money;
}

/**
 * Value a single holding as of `asOf` (YYYY-MM-DD).
 *
 * Strategy:
 *   - cash → face value (quantity is the dollar amount, regardless of unit)
 *   - physical_metal / equity / crypto → quantity × latest price on or before asOf
 *   - property → face value (single-position property accounts; cost basis acts as the value)
 *
 * Returns Money.zero(currency) if no price has been fetched yet — Phase 2 only
 * starts populating prices after the first `fetch-prices-daily` run. Until then
 * holdings-based accounts contribute $0 (which is honest: we don't know yet).
 */
export async function valueHolding(
  holding: Holding,
  currency: string,
  asOf: string,
): Promise<HoldingValuation> {
  if (holding.assetClass === "cash" || holding.assetClass === "property") {
    return {
      holding,
      closeUsed: null,
      value: Money.fromString(holding.quantity, currency),
    };
  }

  const close = await latestCloseOnOrBefore(holding.symbol, asOf);
  if (close === null) {
    return { holding, closeUsed: null, value: Money.zero(currency) };
  }

  const quantity = new Decimal(holding.quantity);
  const product = quantity.times(new Decimal(close));
  return {
    holding,
    closeUsed: close,
    value: Money.fromString(product.toFixed(2), currency),
  };
}

/** Sum all holdings for an account into a single Money value. */
export async function valueAccountHoldings(
  accountId: string,
  currency: string,
  asOf: string,
): Promise<Money> {
  const rows = await db.select().from(holdings).where(eq(holdings.accountId, accountId));
  if (rows.length === 0) return Money.zero(currency);
  let total = Money.zero(currency);
  for (const h of rows) {
    const v = await valueHolding(h, currency, asOf);
    total = total.add(v.value);
  }
  return total;
}
