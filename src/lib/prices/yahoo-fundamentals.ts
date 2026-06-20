import { z } from "zod";
import { withRateLimitRetry } from "./retry.ts";

/**
 * Security enrichment fetcher (Phase 9, ADR-020) — sector / industry / region /
 * asset type / forward dividend, from Yahoo's public `quoteSummary` endpoint.
 *
 * Same posture as [yahoo-chart.ts](./yahoo-chart.ts): a raw `fetch` of an
 * unauthenticated endpoint, a Zod-validated narrow slice (Yahoo's shape is much
 * wider; an upstream addition must not break us), and `withRateLimitRetry` for
 * 429s.
 *
 * **Privacy (CLAUDE.md §Privacy):** the ONLY outbound datum is the ticker
 * `symbol`. No quantities, balances, account names, or holdings ever leave the
 * host — the same data category the price fetch already sends. The egress test
 * ([../investments/fundamentals-egress.test.ts]) enforces this statically.
 *
 * Coverage is best-effort: proprietary / 401k funds, foreign tickers, and
 * `SEC:`-synthetic symbols have no public profile — those resolve to nulls
 * (rendered "Unclassified"), never a crash or a guess.
 */

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const MODULES = "assetProfile,summaryDetail,quoteType";

/** What the enrichment store consumes — strings/null, money-shaped fields stay strings. */
export interface SecurityFundamentals {
  readonly sector: string | null;
  readonly industry: string | null;
  readonly region: string | null;
  /** Normalized: equity | etf | mutual_fund | bond | crypto | cash | other; null if unknown. */
  readonly assetType: string | null;
  readonly expenseRatio: string | null;
  /** Forward annual dividend, $/share (string). */
  readonly dividendRate: string | null;
  readonly dividendExDate: string | null;
}

/** quoteSummary wraps numbers as `{ raw, fmt }`; we read `raw`. */
const wrappedNumber = z.object({ raw: z.number().finite() });

const resultSchema = z.object({
  assetProfile: z
    .object({
      sector: z.string().nullish(),
      industry: z.string().nullish(),
      country: z.string().nullish(),
    })
    .nullish(),
  quoteType: z
    .object({
      quoteType: z.string().nullish(),
    })
    .nullish(),
  summaryDetail: z
    .object({
      dividendRate: wrappedNumber.nullish(),
      exDividendDate: wrappedNumber.nullish(),
      annualReportExpenseRatio: wrappedNumber.nullish(),
    })
    .nullish(),
});

const responseSchema = z.object({
  quoteSummary: z.object({
    error: z.unknown().nullish(),
    result: z.array(resultSchema).nullish(),
  }),
});

/**
 * Map Yahoo's `quoteType` to our normalized `asset_type` bucket.
 *
 * @param quoteType - Yahoo's quote type (EQUITY, ETF, …) or null.
 * @returns A bucket from the schema CHECK, or null when Yahoo gave nothing
 *   (so the caller can fall back to the Plaid `type`).
 */
export function normalizeAssetType(quoteType: string | null | undefined): string | null {
  if (!quoteType) return null;
  switch (quoteType.toUpperCase()) {
    case "EQUITY":
      return "equity";
    case "ETF":
      return "etf";
    case "MUTUALFUND":
      return "mutual_fund";
    case "CRYPTOCURRENCY":
      return "crypto";
    case "CURRENCY":
    case "MONEYMARKET":
      return "cash";
    default:
      return "other";
  }
}

/** Unix seconds → YYYY-MM-DD (UTC), or null. */
function unixToIso(seconds: number | null | undefined): string | null {
  if (seconds == null) return null;
  return new Date(seconds * 1000).toISOString().slice(0, 10);
}

/**
 * Parse a quoteSummary JSON payload into our fundamentals shape. Pure — the
 * tested core. Returns null when the payload is malformed or has no result.
 *
 * @param json - The raw parsed JSON from the endpoint.
 * @returns Fundamentals, or null if unusable.
 */
export function parseFundamentals(json: unknown): SecurityFundamentals | null {
  const parsed = responseSchema.safeParse(json);
  if (!parsed.success) return null;
  if (parsed.data.quoteSummary.error != null) return null;
  const result = parsed.data.quoteSummary.result?.[0];
  if (!result) return null;

  const ap = result.assetProfile;
  const sd = result.summaryDetail;
  return {
    sector: ap?.sector ?? null,
    industry: ap?.industry ?? null,
    region: ap?.country ?? null,
    assetType: normalizeAssetType(result.quoteType?.quoteType),
    expenseRatio:
      sd?.annualReportExpenseRatio?.raw != null ? String(sd.annualReportExpenseRatio.raw) : null,
    dividendRate: sd?.dividendRate?.raw != null ? String(sd.dividendRate.raw) : null,
    dividendExDate: unixToIso(sd?.exDividendDate?.raw),
  };
}

/**
 * Fetch enrichment for a single ticker. Short-circuits `SEC:`-synthetic symbols
 * (no public profile). Never throws — any network/parse failure returns null so
 * the weekly job tolerates a bad symbol and moves on.
 *
 * @param symbol - The ticker (the ONLY value sent upstream).
 * @returns Fundamentals, or null when unavailable.
 */
export async function fetchFundamentals(symbol: string): Promise<SecurityFundamentals | null> {
  if (symbol.startsWith("SEC:")) return null;

  const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(
    symbol,
  )}?modules=${MODULES}`;

  try {
    const json = await withRateLimitRetry(async () => {
      const res = await fetch(url, {
        headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      });
      if (!res.ok) {
        // 429 → retried by withRateLimitRetry; other statuses bubble to the catch.
        throw new Error(`Yahoo quoteSummary HTTP ${res.status} for ${symbol}`);
      }
      return (await res.json()) as unknown;
    });
    return parseFundamentals(json);
  } catch {
    return null;
  }
}
