import { z } from "zod";
import { type DailyClose, type PriceFetcher, type PriceQuote, todayIso } from "./types.ts";

/**
 * Map common crypto tickers to CoinGecko IDs. Users can extend by editing
 * this file — for Phase 2 the small built-in set covers our anticipated
 * holdings. Anything not in the map falls through to a lowercased-symbol
 * lookup which CoinGecko also accepts for many coins.
 */
const SYMBOL_TO_COINGECKO_ID: Record<string, string> = {
  BTC: "bitcoin",
  ETH: "ethereum",
  USDT: "tether",
  USDC: "usd-coin",
  SOL: "solana",
  ADA: "cardano",
  DOGE: "dogecoin",
  XRP: "ripple",
  LTC: "litecoin",
  AVAX: "avalanche-2",
  DOT: "polkadot",
  MATIC: "matic-network",
  LINK: "chainlink",
  BCH: "bitcoin-cash",
  ATOM: "cosmos",
  ALGO: "algorand",
};

function coingeckoIdFor(symbol: string): string {
  return SYMBOL_TO_COINGECKO_ID[symbol.toUpperCase()] ?? symbol.toLowerCase();
}

const responseSchema = z.record(z.string(), z.object({ usd: z.number().finite().nonnegative() }));

/**
 * `/market_chart/range` returns parallel `[epochMs, value]` tuples. We only read
 * `prices`; the wider `market_caps`/`total_volumes` are ignored.
 */
const marketChartSchema = z.object({
  prices: z.array(z.tuple([z.number(), z.number()])),
});

export interface CoinGeckoFetcherOptions {
  /** Override fetch for tests. Defaults to global fetch. */
  readonly fetchImpl?: typeof fetch;
  /** Base URL override (e.g. for a self-hosted proxy). */
  readonly baseUrl?: string;
}

export class CoinGeckoFetcher implements PriceFetcher {
  readonly source = "coingecko";
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;

  constructor(opts: CoinGeckoFetcherOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.baseUrl = opts.baseUrl ?? "https://api.coingecko.com/api/v3";
  }

  async quote(symbol: string): Promise<PriceQuote> {
    const id = coingeckoIdFor(symbol);
    const url = `${this.baseUrl}/simple/price?ids=${encodeURIComponent(id)}&vs_currencies=usd`;
    const res = await this.fetchImpl(url, {
      headers: { accept: "application/json" },
    });
    if (!res.ok) {
      throw new Error(`CoinGecko HTTP ${res.status} for ${symbol} (id=${id})`);
    }
    const body = (await res.json()) as unknown;
    const parsed = responseSchema.safeParse(body);
    if (!parsed.success) {
      throw new Error(
        `CoinGecko response for ${symbol} did not match schema: ${parsed.error.issues[0]?.message}`,
      );
    }
    const entry = parsed.data[id];
    if (!entry) {
      throw new Error(`CoinGecko returned no entry for ${symbol} (id=${id})`);
    }
    return {
      symbol: symbol.toUpperCase(),
      date: todayIso(),
      close: entry.usd.toFixed(8),
      source: this.source,
    };
  }

  /**
   * Daily close SERIES for a coin spanning `fromIso → today` (P11-07).
   *
   * Hits `/coins/{id}/market_chart/range`, which returns many intraday points;
   * we collapse to one close per UTC day by keeping the LAST point of each day
   * (the freshest reading for that date). Returns ascending `{date, close}[]`.
   * Seeds watchlist history for a newly-followed crypto symbol.
   *
   * @param symbol - Crypto ticker (e.g. `BTC`); resolved to a CoinGecko id.
   * @param fromIso - Inclusive start date (`YYYY-MM-DD`, UTC).
   * @returns Ascending one-per-day `{date, close}[]`.
   * @throws If the upstream call is non-2xx (unknown coin → 404) or unparseable.
   */
  async series(symbol: string, fromIso: string): Promise<DailyClose[]> {
    const id = coingeckoIdFor(symbol);
    const from = Math.floor(Date.parse(`${fromIso}T00:00:00Z`) / 1000);
    const to = Math.floor(Date.now() / 1000);
    const url =
      `${this.baseUrl}/coins/${encodeURIComponent(id)}/market_chart/range` +
      `?vs_currency=usd&from=${from}&to=${to}`;
    const res = await this.fetchImpl(url, { headers: { accept: "application/json" } });
    if (!res.ok) {
      throw new Error(`CoinGecko HTTP ${res.status} for ${symbol} series (id=${id})`);
    }
    const body = (await res.json()) as unknown;
    const parsed = marketChartSchema.safeParse(body);
    if (!parsed.success) {
      throw new Error(
        `CoinGecko series for ${symbol} did not match schema: ${parsed.error.issues[0]?.message}`,
      );
    }

    // Keep the last reading per UTC day (later tuples overwrite earlier ones).
    const lastByDay = new Map<string, number>();
    for (const [ms, price] of parsed.data.prices) {
      if (price <= 0) continue;
      lastByDay.set(new Date(ms).toISOString().slice(0, 10), price);
    }
    return [...lastByDay.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map(([date, price]) => ({ date, close: price.toFixed(8) }));
  }
}
