import { z } from "zod";
import { type PriceFetcher, type PriceQuote, todayIso } from "./types.ts";

/**
 * Alpha Vantage fetcher for physical metals.
 *
 * Uses CURRENCY_EXCHANGE_RATE with from=XAU/XAG/etc. and to=USD. AV doesn't
 * expose a dedicated gold spot endpoint on the free tier, but the FX path
 * returns the spot quote per troy ounce. Free tier limit is 25 req/day, which
 * is plenty for the small number of metal symbols we hold (typically just XAU).
 *
 * AV's response shape is the famously verbose hyphenated-numbered keys:
 *   { "Realtime Currency Exchange Rate": { "5. Exchange Rate": "..." } }
 *
 * We validate the bits we use and let the rest pass through.
 */
const responseSchema = z.object({
  "Realtime Currency Exchange Rate": z.object({
    "1. From_Currency Code": z.string(),
    "3. To_Currency Code": z.string(),
    "5. Exchange Rate": z.string().regex(/^\d+(\.\d+)?$/, "Exchange rate must be a numeric string"),
  }),
});

export interface AlphaVantageFetcherOptions {
  readonly apiKey?: string;
  readonly fetchImpl?: typeof fetch;
  readonly baseUrl?: string;
}

export class AlphaVantageFetcher implements PriceFetcher {
  readonly source = "alpha_vantage";
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;

  constructor(opts: AlphaVantageFetcherOptions = {}) {
    const apiKey = opts.apiKey ?? process.env.ALPHAVANTAGE_API_KEY;
    if (!apiKey) {
      throw new Error(
        "ALPHAVANTAGE_API_KEY is not set. Get a free key at https://www.alphavantage.co/support/#api-key",
      );
    }
    this.apiKey = apiKey;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.baseUrl = opts.baseUrl ?? "https://www.alphavantage.co/query";
  }

  async quote(symbol: string): Promise<PriceQuote> {
    const params = new URLSearchParams({
      function: "CURRENCY_EXCHANGE_RATE",
      from_currency: symbol.toUpperCase(),
      to_currency: "USD",
      apikey: this.apiKey,
    });
    const url = `${this.baseUrl}?${params.toString()}`;
    const res = await this.fetchImpl(url, {
      headers: { accept: "application/json" },
    });
    if (!res.ok) {
      throw new Error(`Alpha Vantage HTTP ${res.status} for ${symbol}`);
    }
    const body = (await res.json()) as unknown;
    const parsed = responseSchema.safeParse(body);
    if (!parsed.success) {
      // AV returns a different shape on rate-limit / quota / bad key:
      //   { "Information": "..." }  or  { "Note": "..." }
      // Surface a clearer error for those cases.
      const raw = body as Record<string, unknown>;
      const apMsg = raw.Information ?? raw.Note ?? raw["Error Message"];
      throw new Error(
        `Alpha Vantage response for ${symbol} did not match schema${
          apMsg ? `: ${String(apMsg)}` : ""
        }`,
      );
    }
    const rate = parsed.data["Realtime Currency Exchange Rate"];
    return {
      symbol: rate["1. From_Currency Code"].toUpperCase(),
      date: todayIso(),
      close: Number(rate["5. Exchange Rate"]).toFixed(8),
      source: this.source,
    };
  }
}
