import { db } from "@/db/client.ts";
import { prices, watchlistItems } from "@/db/schema/index.ts";
import { CoinGeckoFetcher } from "@/lib/prices/coingecko.ts";
import type { DailyClose } from "@/lib/prices/types.ts";
import { fetchYahooDailySeries } from "@/lib/prices/yahoo-chart.ts";
import { yahooSymbolForMetal } from "@/lib/prices/yahoo-metals.ts";
import type { Job } from "bullmq";
import { eq, sql } from "drizzle-orm";

/**
 * Phase 11 (P11-08, ADR-025) — on-add history backfill for a watchlist symbol.
 *
 * When the user starts following a symbol, this seeds `prices` with its daily
 * closes from `pretend_purchased_at` (so a paper position has history back to its
 * hypothetical buy) — or, when watch-only, the last 24 months — up to today. The
 * nightly `fetch-prices-daily` job keeps it fresh from here on; this is a
 * one-time, on-demand catch-up (no cron).
 *
 * Best-effort by design: a fetch failure for one symbol must NOT fail the whole
 * job (the watch row already exists and will still get live closes nightly), so
 * we catch, log, and return `{ written: 0 }`. Idempotent — UPSERT on the
 * `(symbol, date)` PK means a re-run overwrites with no net change.
 *
 * `deps` are injectable so the job test runs offline with a mock series fetcher.
 */
export interface BackfillWatchlistSymbolResult {
  readonly written: number;
}

interface WatchlistSymbolRow {
  readonly symbol: string;
  readonly assetClass: string;
  readonly pretendPurchasedAt: string | null;
}

export interface BackfillWatchlistSymbolDeps {
  readonly loadItem?: (id: string) => Promise<WatchlistSymbolRow | null>;
  readonly fetchSeries?: (
    assetClass: string,
    symbol: string,
    fromIso: string,
  ) => Promise<DailyClose[]>;
  readonly now?: () => Date;
}

/** ISO date (YYYY-MM-DD) `months` before `now`, UTC. */
function windowStart(now: Date, months: number): string {
  const d = new Date(now);
  d.setUTCMonth(d.getUTCMonth() - months);
  return d.toISOString().slice(0, 10);
}

/** Default loader: the symbol/class/purchase-date for one watch row. */
async function loadWatchlistSymbol(id: string): Promise<WatchlistSymbolRow | null> {
  const [row] = await db
    .select({
      symbol: watchlistItems.symbol,
      assetClass: watchlistItems.assetClass,
      pretendPurchasedAt: watchlistItems.pretendPurchasedAt,
    })
    .from(watchlistItems)
    .where(eq(watchlistItems.id, id))
    .limit(1);
  return row ?? null;
}

/** Default series router: Yahoo for equities/metals, CoinGecko for crypto. */
async function fetchSeriesDefault(
  assetClass: string,
  symbol: string,
  fromIso: string,
): Promise<DailyClose[]> {
  switch (assetClass) {
    case "equity":
      return fetchYahooDailySeries(symbol, fromIso);
    case "physical_metal":
      return fetchYahooDailySeries(yahooSymbolForMetal(symbol), fromIso);
    case "crypto":
      return new CoinGeckoFetcher().series(symbol, fromIso);
    default:
      throw new Error(`Unsupported watchlist asset_class for backfill: ${assetClass}`);
  }
}

/** `prices.source` tag for a given asset class. */
function sourceFor(assetClass: string): string {
  return assetClass === "crypto" ? "coingecko" : "yahoo";
}

export async function backfillWatchlistSymbolProcessor(
  job: Job<{ watchlistItemId: string }>,
  deps: BackfillWatchlistSymbolDeps = {},
): Promise<BackfillWatchlistSymbolResult> {
  const { watchlistItemId } = job.data;
  const now = (deps.now ?? (() => new Date()))();
  const item = await (deps.loadItem ?? loadWatchlistSymbol)(watchlistItemId);
  if (!item) {
    console.error(`[backfill-watchlist-symbol] no watch row for ${watchlistItemId}`);
    return { written: 0 };
  }

  const fromIso = item.pretendPurchasedAt ?? windowStart(now, 24);

  let series: DailyClose[];
  try {
    series = await (deps.fetchSeries ?? fetchSeriesDefault)(item.assetClass, item.symbol, fromIso);
  } catch (err) {
    // Best-effort: the symbol still gets live closes nightly. Log and move on.
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[backfill-watchlist-symbol] ${item.symbol} (${item.assetClass}): ${message}`);
    return { written: 0 };
  }
  if (series.length === 0) return { written: 0 };

  const source = sourceFor(item.assetClass);
  // Batch UPSERT — idempotent on (symbol, date), so a re-run is a no-op.
  await db
    .insert(prices)
    .values(series.map((p) => ({ symbol: item.symbol, date: p.date, close: p.close, source })))
    .onConflictDoUpdate({
      target: [prices.symbol, prices.date],
      set: { close: sql`excluded.close`, source: sql`excluded.source` },
    });

  return { written: series.length };
}
