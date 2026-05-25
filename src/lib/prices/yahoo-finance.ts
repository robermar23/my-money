import yahooFinance from "yahoo-finance2";
import { z } from "zod";
import { type PriceFetcher, type PriceQuote, todayIso } from "./types.ts";

/**
 * Zod schema for the subset of yahoo-finance2's `quote()` response that we
 * actually use. The library returns a much wider shape — we validate only what
 * we depend on so an upstream addition can't break us.
 */
const yahooQuoteSchema = z.object({
  symbol: z.string(),
  regularMarketPrice: z.number().finite().positive(),
});

export class YahooFinanceFetcher implements PriceFetcher {
  readonly source = "yahoo";

  async quote(symbol: string): Promise<PriceQuote> {
    const raw = await yahooFinance.quote(symbol);
    const parsed = yahooQuoteSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(
        `Yahoo response for ${symbol} did not match schema: ${parsed.error.issues[0]?.message}`,
      );
    }
    return {
      symbol: parsed.data.symbol.toUpperCase(),
      date: todayIso(),
      // toFixed(8) keeps NUMERIC(18,8) shape; sufficient even for sub-cent ETFs.
      close: parsed.data.regularMarketPrice.toFixed(8),
      source: this.source,
    };
  }
}
