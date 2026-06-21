import { BENCHMARK_SYMBOL } from "@/lib/investments/performance.ts";
import { sleep } from "@/lib/prices/retry.ts";
import {
  type PriceRouter,
  defaultRouter,
  fetcherFor,
  isFetchableAssetClass,
} from "@/lib/prices/router.ts";
import {
  type HeldSymbol,
  distinctHeldSymbols,
  distinctWatchlistSymbols,
  upsertPrice,
} from "@/lib/prices/store.ts";
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
 * `delayMs` spaces out upstream calls to avoid tripping Yahoo's burst throttle
 * (tests pass 0 to stay fast). Per-symbol retry/backoff lives in the fetchers.
 */
export interface FetchPricesResult {
  readonly succeeded: number;
  readonly failed: number;
  readonly errors: ReadonlyArray<{ symbol: string; error: string }>;
}

/**
 * Merge held + watched symbols + the benchmark into a single, de-duplicated work
 * list (P11-05). A symbol that is both held and watched is fetched once; the
 * benchmark (^GSPC) is always present so the performance page can overlay its
 * buy-and-hold line (ADR-021). Dedup key is the bare symbol — the same ticker
 * never carries two asset classes across these sources.
 *
 * Pure (no I/O) so the union/dedup invariant is unit-testable offline.
 */
export function buildFetchWorkList(
  held: readonly HeldSymbol[],
  watched: readonly HeldSymbol[],
): HeldSymbol[] {
  const seen = new Set<string>();
  const work: HeldSymbol[] = [];
  for (const s of [...held, ...watched, { symbol: BENCHMARK_SYMBOL, assetClass: "equity" }]) {
    if (seen.has(s.symbol)) continue;
    seen.add(s.symbol);
    work.push(s);
  }
  return work;
}

export async function fetchPricesDailyProcessor(
  _job: Job,
  router: PriceRouter = defaultRouter(),
  delayMs = 250,
): Promise<FetchPricesResult> {
  const [held, watched] = await Promise.all([distinctHeldSymbols(), distinctWatchlistSymbols()]);
  // Held + watched + the always-on ^GSPC benchmark, de-duped (P11-05).
  const work = buildFetchWorkList(held, watched);
  let succeeded = 0;
  let failed = 0;
  let processedAny = false;
  const errors: Array<{ symbol: string; error: string }> = [];

  for (const { symbol, assetClass } of work) {
    if (!isFetchableAssetClass(assetClass)) continue; // cash, property: no fetch
    // Space out fetched symbols (not the first) to stay under rate limits.
    if (processedAny && delayMs > 0) await sleep(delayMs);
    processedAny = true;
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
