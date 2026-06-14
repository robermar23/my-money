import type { NewHolding, NewInvestmentTransaction } from "@/db/schema/index.ts";
import { Money } from "@/lib/money/money.ts";
import { type PriceQuote, todayIso } from "@/lib/prices/types.ts";

/**
 * P5-12 / P5-13 — pure mappers from Plaid Investments payloads to our row
 * shapes (ADR-012). No DB, no `server-only` — same posture as map.ts.
 *
 * Money is always converted at the boundary via `toFixed(2)` / `Money`; never
 * raw `Number` arithmetic (CLAUDE.md §Money & Numeric Precision). Quantities
 * pass through as their source string (a count, not money).
 */

/** Our `securities` row info the holding mapper needs (a subset of `Security`). */
export interface SecurityInfo {
  /** Our internal securities.id (set once the security row is upserted). */
  readonly id?: string;
  readonly symbol: string;
  readonly tickerSymbol: string | null;
  readonly type: string | null;
  readonly isCashEquivalent: boolean;
}

/** The Plaid `Holding` fields we consume. */
export interface PlaidHoldingLike {
  readonly account_id: string;
  readonly security_id: string;
  readonly institution_price: number;
  readonly institution_price_as_of?: string | null;
  readonly cost_basis: number | null;
  readonly quantity: number;
  readonly iso_currency_code: string | null;
}

/** The Plaid `InvestmentTransaction` fields we consume. */
export interface PlaidInvestmentTxnLike {
  readonly investment_transaction_id: string;
  readonly account_id: string;
  readonly security_id: string | null;
  readonly date: string;
  readonly name: string;
  readonly quantity: number;
  readonly amount: number;
  readonly price: number;
  readonly fees: number | null;
  readonly type: string;
  readonly subtype: string | null;
  readonly iso_currency_code: string | null;
}

type AssetClass = NewHolding["assetClass"];
type QuantityUnit = NewHolding["quantityUnit"];

/**
 * Map a Plaid security type to our `asset_class` + `quantity_unit`. Plaid never
 * reports `physical_metal` (that's manual iTrust gold) or `property`, so the
 * three reachable classes are crypto, cash, and equity (the catch-all for
 * stocks / ETFs / mutual funds / fixed income — our enum has no finer bucket).
 */
function classify(security: SecurityInfo): {
  assetClass: AssetClass;
  quantityUnit: QuantityUnit;
} {
  if (security.type === "cryptocurrency") {
    return { assetClass: "crypto", quantityUnit: "coin" };
  }
  if (security.isCashEquivalent || security.type === "cash") {
    return { assetClass: "cash", quantityUnit: "usd" };
  }
  return { assetClass: "equity", quantityUnit: "shares" };
}

/**
 * Map a Plaid holding to our `holdings` insert row.
 *
 * @param h - The Plaid holding.
 * @param security - Our resolved security info (provides symbol + id + class).
 * @param accountId - Our internal account UUID this holding belongs to.
 * @returns A `NewHolding` with `source='plaid'`. The caller decides whether to
 *   apply `costBasis` (it skips it when `cost_basis_overridden_at` is set).
 */
export function plaidHoldingToHolding(
  h: PlaidHoldingLike,
  security: SecurityInfo,
  accountId: string,
): NewHolding {
  const { assetClass, quantityUnit } = classify(security);
  return {
    accountId,
    symbol: security.symbol,
    quantity: String(h.quantity),
    quantityUnit,
    assetClass,
    costBasis: h.cost_basis === null ? null : h.cost_basis.toFixed(2),
    securityId: security.id ?? null,
    source: "plaid",
  };
}

/**
 * Build a `prices` quote from a holding's `institution_price`.
 *
 * Emitted for EVERY security — tickered (AAPL, MSTR) and synthetic (`SEC:`)
 * alike — so a freshly-synced holding has a value immediately. Previously this
 * was gated to synthetic securities only, which left tickered positions reading
 * $0 (and the account total wrong) until the nightly Yahoo `fetch-prices-daily`
 * ran. Plaid's price is the seed; the daily Yahoo fetch overwrites the same
 * `(symbol, date)` row and remains the ongoing source of truth.
 *
 * @param h - The Plaid holding (carries `institution_price`).
 * @param security - Resolved security info (provides the price symbol).
 * @param now - Clock injection for the date fallback (testability).
 * @returns A `PriceQuote`, or null when Plaid omitted a usable price.
 */
export function institutionPriceQuote(
  h: PlaidHoldingLike,
  security: SecurityInfo,
  now: Date = new Date(),
): PriceQuote | null {
  if (!Number.isFinite(h.institution_price)) return null;
  return {
    symbol: security.symbol,
    date: h.institution_price_as_of ?? todayIso(now),
    close: String(h.institution_price),
    source: "plaid",
  };
}

/**
 * Map a Plaid investment transaction to our `investment_transactions` row.
 *
 * Sign flip (CRITICAL, mirrors map.ts): Plaid positive `amount` = cash debited
 * (a buy); negative = cash credited (a sell / dividend). We negate so `amount`
 * follows our convention (positive = inflow), via `Money`, never `Number`.
 *
 * @param t - The Plaid investment transaction.
 * @param accountId - Our internal account UUID.
 * @param securityId - Our internal securities.id, or null for pure-cash rows.
 * @returns A `NewInvestmentTransaction` with `source='plaid'`.
 * @throws If the trade date is not a valid YYYY-MM-DD.
 */
export function plaidInvestmentTxnToRow(
  t: PlaidInvestmentTxnLike,
  accountId: string,
  securityId: string | null,
): NewInvestmentTransaction {
  const currency = t.iso_currency_code ?? "USD";
  const tradeDate = t.date.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(tradeDate)) {
    throw new Error(
      `plaidInvestmentTxnToRow: bad date for ${t.investment_transaction_id}: ${t.date}`,
    );
  }

  const amount = Money.fromString(t.amount.toFixed(2), currency).negate().toString();

  return {
    accountId,
    securityId,
    plaidInvestmentTransactionId: t.investment_transaction_id,
    type: t.type,
    subtype: t.subtype,
    tradeDate,
    quantity: t.quantity === null || t.quantity === undefined ? null : String(t.quantity),
    price: t.price === null || t.price === undefined ? null : String(t.price),
    fees: t.fees === null || t.fees === undefined ? null : t.fees.toFixed(2),
    amount,
    name: t.name,
    isoCurrencyCode: currency,
    source: "plaid",
    raw: t as unknown as Record<string, unknown>,
  };
}
