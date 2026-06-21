import { z } from "zod";
import { withRateLimitRetry } from "./retry.ts";
import type { DailyClose } from "./types.ts";

/**
 * Shared Yahoo price extraction backed by the public `/v8/finance/chart`
 * endpoint, fetched directly (no `yahoo-finance2` wrapper).
 *
 * Why a raw fetch: `yahoo-finance2` performs a cookie-consent + crumb handshake
 * and attaches those credentials to every data request. From many IPs (incl.
 * self-hosted / datacenter) that authenticated request is what Yahoo answers
 * with HTTP 429 — the plaintext `"Too Many Requests"` body the library then
 * fails to `JSON.parse` ("Unexpected token 'T'"). The *unauthenticated* chart
 * endpoint, by contrast, returns 200 from the exact same IP. So we skip the
 * crumb dance entirely and hit the endpoint ourselves.
 *
 * We read the latest price from `meta.regularMarketPrice`, falling back to the
 * last non-null daily close, so weekends/holidays still resolve to the most
 * recent trading day.
 */

/** A short window guarantees at least one trading day even across a long weekend. */
const RANGE = "7d";

/** Polite, browser-like UA. The endpoint works without one, but this is cheap insurance. */
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

/**
 * Validate only the slice of the chart response we depend on. Yahoo returns a
 * much wider shape; an upstream addition must not break us.
 */
const chartResponseSchema = z.object({
  chart: z.object({
    error: z.unknown().nullable().optional(),
    result: z
      .array(
        z.object({
          meta: z.object({
            regularMarketPrice: z.number().finite().positive().optional(),
          }),
          indicators: z
            .object({
              quote: z
                .array(z.object({ close: z.array(z.number().nullable()).optional() }))
                .optional(),
            })
            .optional(),
        }),
      )
      .nullable()
      .optional(),
  }),
});

/** Thrown for non-2xx responses; carries the status so 429s can be retried. */
class YahooHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "YahooHttpError";
  }
}

/**
 * Fetch the latest close for a Yahoo ticker via the chart endpoint.
 *
 * @param yahooSymbol - The exact Yahoo ticker (e.g. `AAPL`, `GC=F`).
 * @returns The latest price as a number.
 * @throws If the response lacks any usable price, the symbol is rejected, or the
 *   upstream call fails (429s are retried with backoff before throwing).
 */
export async function fetchYahooClose(yahooSymbol: string): Promise<number> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    yahooSymbol,
  )}?interval=1d&range=${RANGE}`;

  const json = await withRateLimitRetry(async () => {
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    });
    if (!res.ok) {
      // 429 → retried by withRateLimitRetry; everything else throws straight out.
      throw new YahooHttpError(res.status, `Yahoo chart HTTP ${res.status} for ${yahooSymbol}`);
    }
    return (await res.json()) as unknown;
  });

  const parsed = chartResponseSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(
      `Yahoo chart response for ${yahooSymbol} did not match schema: ${parsed.error.issues[0]?.message}`,
    );
  }
  if (parsed.data.chart.error != null) {
    throw new Error(
      `Yahoo chart error for ${yahooSymbol}: ${JSON.stringify(parsed.data.chart.error)}`,
    );
  }

  const result = parsed.data.chart.result?.[0];
  if (!result) {
    throw new Error(`Yahoo chart response for ${yahooSymbol} contained no result.`);
  }

  const fromMeta = result.meta.regularMarketPrice;
  if (fromMeta !== undefined) return fromMeta;

  // Fall back to the most recent non-null daily close.
  const closes = result.indicators?.quote?.[0]?.close ?? [];
  for (let i = closes.length - 1; i >= 0; i--) {
    const close = closes[i];
    if (close != null && close > 0) return close;
  }

  throw new Error(`Yahoo chart response for ${yahooSymbol} contained no usable price.`);
}

/**
 * Validate the slice of the chart response the historical series depends on:
 * the parallel `timestamp[]` (epoch seconds, UTC) and `indicators.quote[0].close[]`
 * arrays. Same defensive narrowing as the single-close schema.
 */
const chartSeriesResponseSchema = z.object({
  chart: z.object({
    error: z.unknown().nullable().optional(),
    result: z
      .array(
        z.object({
          timestamp: z.array(z.number()).optional(),
          indicators: z
            .object({
              quote: z
                .array(z.object({ close: z.array(z.number().nullable()).optional() }))
                .optional(),
            })
            .optional(),
        }),
      )
      .nullable()
      .optional(),
  }),
});

/** Epoch seconds at UTC midnight for an ISO `YYYY-MM-DD` date. */
function unixDayStart(iso: string): number {
  return Math.floor(Date.parse(`${iso}T00:00:00Z`) / 1000);
}

/**
 * Fetch a daily close SERIES for a Yahoo ticker via the same unauthenticated
 * chart endpoint, spanning `fromIso → today` (P11-06).
 *
 * Unlike {@link fetchYahooClose} (which returns one latest price), this walks the
 * parallel `timestamp[]`/`close[]` arrays and returns one `{date, close}` per
 * trading day, sorted ascending, with null closes skipped. Used by the watchlist
 * backfill to seed history for a newly-followed symbol.
 *
 * @param yahooSymbol - The exact Yahoo ticker (e.g. `AAPL`, `GC=F`).
 * @param fromIso - Inclusive start date (`YYYY-MM-DD`, UTC).
 * @returns Ascending `{date, close}[]`; empty if the window holds no trading days.
 * @throws If the upstream call fails (429s retried) or the response is unparseable.
 */
export async function fetchYahooDailySeries(
  yahooSymbol: string,
  fromIso: string,
): Promise<DailyClose[]> {
  const period1 = unixDayStart(fromIso);
  // +1 day of headroom so today's bar is always inside the window.
  const period2 = Math.floor(Date.now() / 1000) + 86_400;
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}` +
    `?interval=1d&period1=${period1}&period2=${period2}`;

  const json = await withRateLimitRetry(async () => {
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    });
    if (!res.ok) {
      throw new YahooHttpError(res.status, `Yahoo chart HTTP ${res.status} for ${yahooSymbol}`);
    }
    return (await res.json()) as unknown;
  });

  const parsed = chartSeriesResponseSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(
      `Yahoo chart series for ${yahooSymbol} did not match schema: ${parsed.error.issues[0]?.message}`,
    );
  }
  if (parsed.data.chart.error != null) {
    throw new Error(
      `Yahoo chart error for ${yahooSymbol}: ${JSON.stringify(parsed.data.chart.error)}`,
    );
  }

  const result = parsed.data.chart.result?.[0];
  const timestamps = result?.timestamp ?? [];
  const closes = result?.indicators?.quote?.[0]?.close ?? [];

  const series: DailyClose[] = [];
  for (let i = 0; i < timestamps.length; i++) {
    const close = closes[i];
    const ts = timestamps[i];
    if (close == null || close <= 0 || ts == null) continue;
    series.push({ date: new Date(ts * 1000).toISOString().slice(0, 10), close: close.toFixed(8) });
  }
  series.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return series;
}
