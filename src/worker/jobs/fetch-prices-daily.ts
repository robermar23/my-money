import {
  type PriceRouter,
  defaultRouter,
  fetcherFor,
  isFetchableAssetClass,
} from "@/lib/prices/router.ts";
import { distinctHeldSymbols, upsertPrice } from "@/lib/prices/store.ts";
import type { Job } from "bullmq";

/**
 * Phase 2 nightly job: refresh today's price for every distinct held symbol.
 *
 * Strategy:
 *   1. Walk `holdings` for the distinct (symbol, asset_class) set.
 *   2. Route each to its source via `PriceRouter` (Yahoo for equities + metals,
 *      CoinGecko for crypto).
 *   3. Upsert into `prices(symbol, date, close, source)` — idempotent per
 *      (symbol, date), so re-running the job on the same day overwrites with
 *      the latest close.
 *
 * Per CLAUDE.md §Background Jobs: one symbol's failure must not kill the run.
 * We catch per-symbol and surface a count of (succeeded, failed) at the end so
 * `failed_jobs` (Phase 6) can pick up the diff later.
 *
 * `router` is injectable so tests can run the job offline with mock fetchers.
 */
export interface FetchPricesResult {
  readonly succeeded: number;
  readonly failed: number;
  readonly errors: ReadonlyArray<{ symbol: string; error: string }>;
}

export async function fetchPricesDailyProcessor(
  _job: Job,
  router: PriceRouter = defaultRouter(),
): Promise<FetchPricesResult> {
  const held = await distinctHeldSymbols();
  let succeeded = 0;
  let failed = 0;
  const errors: Array<{ symbol: string; error: string }> = [];

  for (const { symbol, assetClass } of held) {
    if (!isFetchableAssetClass(assetClass)) continue; // cash, property: no fetch
    try {
      const fetcher = fetcherFor(router, assetClass);
      const quote = await fetcher.quote(symbol);
      await upsertPrice(quote);
      succeeded += 1;
    } catch (err) {
      failed += 1;
      const message = err instanceof Error ? err.message : String(err);
      errors.push({ symbol, error: message });
      console.error(`[fetch-prices-daily] ${symbol} (${assetClass}): ${message}`);
    }
  }
  return { succeeded, failed, errors };
}
