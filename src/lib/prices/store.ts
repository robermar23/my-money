import "server-only";

import { db } from "@/db/client.ts";
import { holdings, prices } from "@/db/schema/index.ts";
import { and, desc, eq, lte } from "drizzle-orm";
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
 */
export interface HeldSymbol {
  readonly symbol: string;
  readonly assetClass: string;
}

export async function distinctHeldSymbols(): Promise<HeldSymbol[]> {
  const rows = await db
    .selectDistinct({ symbol: holdings.symbol, assetClass: holdings.assetClass })
    .from(holdings);
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
