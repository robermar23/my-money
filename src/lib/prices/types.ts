/**
 * Shared types for the price-fetching subsystem.
 *
 * Each `PriceFetcher` is responsible for one upstream source (Yahoo, CoinGecko,
 * Alpha Vantage, …). The job orchestrator (`fetch-prices-daily`) routes each
 * symbol to the right fetcher based on `asset_class` and writes the result to
 * the `prices` table.
 *
 * `quote()` is the only required entry point. Implementations must:
 *   - validate the upstream response with Zod
 *   - return a decimal string (8-digit precision) suitable for NUMERIC(18,8)
 *   - throw on hard errors (network, schema mismatch); the orchestrator catches
 *     and moves on to the next symbol so one bad source doesn't kill the run.
 */
export interface PriceQuote {
  /** The canonical symbol stored in `prices.symbol`. */
  readonly symbol: string;
  /** ISO date (YYYY-MM-DD) the close applies to. */
  readonly date: string;
  /** Decimal string, exact precision preserved. */
  readonly close: string;
  /** Free-text source tag: 'yahoo' | 'coingecko' | 'alpha_vantage'. */
  readonly source: string;
}

export interface PriceFetcher {
  /** Source tag written to `prices.source`. */
  readonly source: string;
  /** Fetch the most recent close for a single symbol. */
  quote(symbol: string): Promise<PriceQuote>;
}

/**
 * One closing price for one UTC day — the shape every historical-series fetcher
 * returns (Phase 11, P11-06/07). The watchlist backfill (P11-08) maps these
 * straight into `prices(symbol, date, close, source)`.
 */
export interface DailyClose {
  /** ISO date (YYYY-MM-DD), the UTC day the close applies to. */
  readonly date: string;
  /** Decimal string, 8-digit precision (NUMERIC(18,8)). */
  readonly close: string;
}

/**
 * Today's date in UTC as a YYYY-MM-DD string. Centralized so test code can
 * stub `Date` and every fetcher agrees on what "today" means.
 */
export function todayIso(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}
