import { describe, expect, it } from "vitest";
import { CoinGeckoFetcher } from "./coingecko.ts";

function mockFetchOk(json: unknown): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(json), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

function mockFetchStatus(status: number, json: unknown = {}): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(json), {
      status,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

describe("CoinGeckoFetcher", () => {
  it("maps BTC → bitcoin and returns a normalized quote", async () => {
    const fetcher = new CoinGeckoFetcher({
      fetchImpl: mockFetchOk({ bitcoin: { usd: 65000.12 } }),
    });
    const q = await fetcher.quote("BTC");
    expect(q.symbol).toBe("BTC");
    expect(q.close).toBe("65000.12000000");
    expect(q.source).toBe("coingecko");
    expect(q.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("falls back to lowercased symbol when ID not in the map", async () => {
    let observed = "";
    const fetcher = new CoinGeckoFetcher({
      fetchImpl: (async (input: RequestInfo | URL) => {
        observed = String(input);
        return new Response(JSON.stringify({ unknowncoin: { usd: 1.23 } }), { status: 200 });
      }) as unknown as typeof fetch,
    });
    await fetcher.quote("UnknownCoin");
    expect(observed).toContain("ids=unknowncoin");
  });

  it("throws on non-2xx HTTP", async () => {
    const fetcher = new CoinGeckoFetcher({ fetchImpl: mockFetchStatus(429) });
    await expect(fetcher.quote("BTC")).rejects.toThrow(/CoinGecko HTTP 429/);
  });

  it("throws on schema mismatch", async () => {
    const fetcher = new CoinGeckoFetcher({
      fetchImpl: mockFetchOk({ bitcoin: { eur: 60000 } }),
    });
    await expect(fetcher.quote("BTC")).rejects.toThrow(/schema/);
  });

  it("throws when the requested id is missing from the response", async () => {
    const fetcher = new CoinGeckoFetcher({
      fetchImpl: mockFetchOk({ ethereum: { usd: 3500 } }),
    });
    await expect(fetcher.quote("BTC")).rejects.toThrow(/no entry/);
  });
});

describe("CoinGeckoFetcher.series", () => {
  /** A `/market_chart/range` body from [epochMs, price] tuples. */
  function chartBody(tuples: [number, number][]) {
    return { prices: tuples, market_caps: [], total_volumes: [] };
  }

  const ms = (iso: string) => Date.parse(`${iso}T00:00:00Z`);

  it("collapses intraday points to one close per UTC day (last wins), sorted", async () => {
    const fetcher = new CoinGeckoFetcher({
      fetchImpl: mockFetchOk(
        chartBody([
          [ms("2026-01-02") + 3_600_000, 41000.5], // Jan 2, early — overwritten
          [ms("2026-01-02") + 7_200_000, 42000.25], // Jan 2, later — kept
          [ms("2026-01-01") + 3_600_000, 40000], // Jan 1
        ]),
      ),
    });
    const series = await fetcher.series("BTC", "2026-01-01");
    expect(series).toEqual([
      { date: "2026-01-01", close: "40000.00000000" },
      { date: "2026-01-02", close: "42000.25000000" },
    ]);
  });

  it("resolves the coin id and from-window into the range URL", async () => {
    let observed = "";
    const fetcher = new CoinGeckoFetcher({
      fetchImpl: (async (input: RequestInfo | URL) => {
        observed = String(input);
        return new Response(JSON.stringify(chartBody([])), { status: 200 });
      }) as unknown as typeof fetch,
    });
    await fetcher.series("BTC", "2025-06-01");
    expect(observed).toContain("/coins/bitcoin/market_chart/range");
    expect(observed).toContain(`from=${Math.floor(ms("2025-06-01") / 1000)}`);
  });

  it("throws on a non-2xx (e.g. unknown coin → 404) for the backfill to catch", async () => {
    const fetcher = new CoinGeckoFetcher({ fetchImpl: mockFetchStatus(404) });
    await expect(fetcher.series("NOPE", "2026-01-01")).rejects.toThrow(/CoinGecko HTTP 404/);
  });

  it("throws on a schema mismatch", async () => {
    const fetcher = new CoinGeckoFetcher({ fetchImpl: mockFetchOk({ prices: "nope" }) });
    await expect(fetcher.series("BTC", "2026-01-01")).rejects.toThrow(/schema/);
  });
});
