import "server-only";

import { db } from "@/db/client.ts";
import { holdings, prices, watchlistItems } from "@/db/schema/index.ts";
import { and, desc, eq, lte, notLike } from "drizzle-orm";
import type { PriceQuote } from "./types.ts";

/**
 * Insert or update a price row. Idempotent on (symbol, date) — re-fetching
 * the same day overwrites with the latest close.
 */
export async function upsertPrice(quote: PriceQuote): Promise<void> {
  await db
    .insert(prices)
    .values({
      symbol: quote.symbol,
      date: quote.date,
      close: quote.close,
      source: quote.source,
    })
    .onConflictDoUpdate({
      target: [prices.symbol, prices.date],
      set: { close: quote.close, source: quote.source },
    });
}

/**
 * The set of (symbol, asset_class) pairs currently held across all accounts.
 * Drives the fetch-prices-daily job's work list.
 *
 * Synthetic `SEC:`-prefixed symbols (Plaid securities with no public ticker,
 * P5-11) are EXCLUDED: they have no upstream price source and are valued from
 * Plaid's `institution_price`, written into `prices` by the investments sync
 * worker (P5-16). Sending them to Yahoo would just 404.
 */
export interface HeldSymbol {
  readonly symbol: string;
  readonly assetClass: string;
}

export async function distinctHeldSymbols(): Promise<HeldSymbol[]> {
  const rows = await db
    .selectDistinct({ symbol: holdings.symbol, assetClass: holdings.assetClass })
    .from(holdings)
    .where(notLike(holdings.symbol, "SEC:%"));
  return rows.map((r) => ({ symbol: r.symbol, assetClass: r.assetClass }));
}

/**
 * The set of (symbol, asset_class) pairs the user WATCHES but does not own
 * (Phase 11, ADR-025). Folded into `fetch-prices-daily`'s work list so a watched
 * symbol gets a fresh daily close in `prices` exactly like a held one — the
 * watchlist's value/history reads straight off that shared `prices` series.
 *
 * Every row is fetchable by construction (the `watchlist_items` CHECK restricts
 * `asset_class` to equity/crypto/physical_metal), so unlike holdings there's no
 * SEC:-synthetic exclusion to apply here.
 */
export async function distinctWatchlistSymbols(): Promise<HeldSymbol[]> {
  const rows = await db
    .selectDistinct({ symbol: watchlistItems.symbol, assetClass: watchlistItems.assetClass })
    .from(watchlistItems);
  return rows.map((r) => ({ symbol: r.symbol, assetClass: r.assetClass }));
}

/**
 * Latest close for a symbol on or before `asOf`. Returns `null` if no price
 * row exists. Used by snapshot computation to value holdings.
 */
export async function latestCloseOnOrBefore(symbol: string, asOf: string): Promise<string | null> {
  const [row] = await db
    .select({ close: prices.close })
    .from(prices)
    .where(and(eq(prices.symbol, symbol), lte(prices.date, asOf)))
    .orderBy(desc(prices.date))
    .limit(1);
  return row?.close ?? null;
}
