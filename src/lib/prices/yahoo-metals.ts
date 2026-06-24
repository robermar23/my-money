import { type PriceFetcher, type PriceQuote, todayIso } from "./types.ts";
import { fetchYahooClose } from "./yahoo-chart.ts";

/**
 * Physical-metal price fetcher backed by Yahoo Finance.
 *
 * Alpha Vantage removed metals from its free tier (CURRENCY_EXCHANGE_RATE for
 * XAU returns "Invalid API call"; their cheapest paid plan is ~$50/mo). Yahoo
 * exposes front-month COMEX futures for the major precious metals, which track
 * spot within a fraction of a percent — accurate enough for personal net-worth
 * tracking and free, with no per-day quota.
 *
 * The caller passes a canonical ISO-4217-style metal symbol (XAU/XAG/XPT/XPD).
 * The fetcher translates that to Yahoo's futures ticker on the way out and
 * translates back to the canonical symbol on the way in, so the rest of the
 * system stores prices under `XAU` and the user never has to know about `GC=F`.
 */
const YAHOO_BY_METAL = {
  XAU: "GC=F", // Gold, front-month COMEX
  XAG: "SI=F", // Silver
  XPT: "PL=F", // Platinum
  XPD: "PA=F", // Palladium
} as const satisfies Record<string, string>;

export type MetalSymbol = keyof typeof YAHOO_BY_METAL;

/**
 * Translate a canonical metal symbol (XAU/XAG/XPT/XPD) to its Yahoo futures
 * ticker (GC=F, …). Shared by the live quote fetcher and the watchlist history
 * backfill (P11-08) so both agree on the mapping.
 *
 * @param symbol - Canonical ISO-4217-style metal symbol.
 * @returns The Yahoo futures ticker.
 * @throws If the symbol isn't a supported precious metal.
 */
export function yahooSymbolForMetal(symbol: string): string {
  const yahooSymbol = YAHOO_BY_METAL[symbol.toUpperCase() as MetalSymbol];
  if (!yahooSymbol) {
    throw new Error(
      `Unsupported metal symbol "${symbol}". Supported: ${Object.keys(YAHOO_BY_METAL).join(", ")}.`,
    );
  }
  return yahooSymbol;
}

export class YahooMetalsFetcher implements PriceFetcher {
  readonly source = "yahoo";

  async quote(symbol: string): Promise<PriceQuote> {
    const canonical = symbol.toUpperCase();
    const close = await fetchYahooClose(yahooSymbolForMetal(canonical));
    return {
      symbol: canonical,
      date: todayIso(),
      close: close.toFixed(8),
      source: this.source,
    };
  }
}
