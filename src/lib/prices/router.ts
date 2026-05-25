import { AlphaVantageFetcher } from "./alpha-vantage.ts";
import { CoinGeckoFetcher } from "./coingecko.ts";
import type { PriceFetcher } from "./types.ts";
import { YahooFinanceFetcher } from "./yahoo-finance.ts";

/**
 * Routes a holding's `asset_class` to the price source we use for that class.
 *
 * Adding a new class? Add a case here and wire it to a fetcher in `defaultRouter`.
 * Classes that don't need a fetch (cash, property) return `null` and the
 * orchestrator skips them.
 */
export type FetchableAssetClass = "equity" | "crypto" | "physical_metal";

const ROUTABLE = new Set<string>(["equity", "crypto", "physical_metal"]);

export function isFetchableAssetClass(value: string): value is FetchableAssetClass {
  return ROUTABLE.has(value);
}

export interface PriceRouter {
  readonly equity: PriceFetcher;
  readonly crypto: PriceFetcher;
  readonly physicalMetal: PriceFetcher;
}

export function fetcherFor(router: PriceRouter, assetClass: FetchableAssetClass): PriceFetcher {
  switch (assetClass) {
    case "equity":
      return router.equity;
    case "crypto":
      return router.crypto;
    case "physical_metal":
      return router.physicalMetal;
  }
}

/**
 * Production router. Constructed lazily so tests can substitute mocks before
 * any fetcher tries to read its env var (AlphaVantage requires an API key).
 */
export function defaultRouter(): PriceRouter {
  return {
    equity: new YahooFinanceFetcher(),
    crypto: new CoinGeckoFetcher(),
    physicalMetal: new AlphaVantageFetcher(),
  };
}
