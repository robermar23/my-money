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
