import { z } from "zod";
import { type PriceFetcher, type PriceQuote, todayIso } from "./types.ts";

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
}
