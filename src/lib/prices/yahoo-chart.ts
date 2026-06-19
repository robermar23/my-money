import { z } from "zod";
import { withRateLimitRetry } from "./retry.ts";

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
