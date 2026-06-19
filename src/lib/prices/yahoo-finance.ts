import { type PriceFetcher, type PriceQuote, todayIso } from "./types.ts";
import { fetchYahooClose } from "./yahoo-chart.ts";

/**
 * Equity price fetcher backed by Yahoo Finance's chart endpoint.
 *
 * Stores the price under the requested symbol (uppercased) so it joins back to
 * `holdings.symbol`; see `fetchYahooClose` for why we use chart() over quote().
 */
export class YahooFinanceFetcher implements PriceFetcher {
  readonly source = "yahoo";

  async quote(symbol: string): Promise<PriceQuote> {
    const close = await fetchYahooClose(symbol);
    return {
      symbol: symbol.toUpperCase(),
      date: todayIso(),
      // toFixed(8) keeps NUMERIC(18,8) shape; sufficient even for sub-cent ETFs.
      close: close.toFixed(8),
      source: this.source,
    };
  }
}
