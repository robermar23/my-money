import yahooFinance from "yahoo-finance2";
import { z } from "zod";
import { withRateLimitRetry } from "./retry.ts";
import { type PriceFetcher, type PriceQuote, todayIso } from "./types.ts";

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

const yahooQuoteSchema = z.object({
  regularMarketPrice: z.number().finite().positive(),
});

export class YahooMetalsFetcher implements PriceFetcher {
  readonly source = "yahoo";

  async quote(symbol: string): Promise<PriceQuote> {
    const canonical = symbol.toUpperCase();
    const yahooSymbol = YAHOO_BY_METAL[canonical as MetalSymbol];
    if (!yahooSymbol) {
      throw new Error(
        `Unsupported metal symbol "${symbol}". Supported: ${Object.keys(YAHOO_BY_METAL).join(", ")}.`,
      );
    }
    // Retry through Yahoo's 429 throttle (metals use the same Yahoo backend).
    const raw = await withRateLimitRetry(() => yahooFinance.quote(yahooSymbol));
    const parsed = yahooQuoteSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(
        `Yahoo metals response for ${canonical} (${yahooSymbol}) did not match schema: ${parsed.error.issues[0]?.message}`,
      );
    }
    return {
      symbol: canonical,
      date: todayIso(),
      close: parsed.data.regularMarketPrice.toFixed(8),
      source: this.source,
    };
  }
}
