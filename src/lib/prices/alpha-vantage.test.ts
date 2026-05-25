import { describe, expect, it } from "vitest";
import { AlphaVantageFetcher } from "./alpha-vantage.ts";

function mockFetchOk(json: unknown): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(json), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

const VALID_RESPONSE = {
  "Realtime Currency Exchange Rate": {
    "1. From_Currency Code": "XAU",
    "2. From_Currency Name": "Gold",
    "3. To_Currency Code": "USD",
    "4. To_Currency Name": "United States Dollar",
    "5. Exchange Rate": "2350.4500",
    "6. Last Refreshed": "2026-05-25 12:00:00",
    "7. Time Zone": "UTC",
    "8. Bid Price": "2350.4400",
    "9. Ask Price": "2350.4600",
  },
};

describe("AlphaVantageFetcher", () => {
  it("requires an API key", () => {
    const orig = process.env.ALPHAVANTAGE_API_KEY;
    // `delete` is the only way to make an env var actually absent — assigning
    // `undefined` coerces to the string "undefined" (still truthy).
    // biome-ignore lint/performance/noDelete: env-var deletion is exactly the point of this test
    delete process.env.ALPHAVANTAGE_API_KEY;
    try {
      expect(() => new AlphaVantageFetcher()).toThrow(/ALPHAVANTAGE_API_KEY/);
    } finally {
      if (orig !== undefined) process.env.ALPHAVANTAGE_API_KEY = orig;
    }
  });

  it("parses a XAU/USD quote", async () => {
    const fetcher = new AlphaVantageFetcher({
      apiKey: "test",
      fetchImpl: mockFetchOk(VALID_RESPONSE),
    });
    const q = await fetcher.quote("XAU");
    expect(q.symbol).toBe("XAU");
    expect(q.close).toBe("2350.45000000");
    expect(q.source).toBe("alpha_vantage");
  });

  it("surfaces AV rate-limit responses with the Information field", async () => {
    const rateLimited = {
      Information:
        "Thank you for using Alpha Vantage! Our standard API rate limit is 25 requests per day.",
    };
    const fetcher = new AlphaVantageFetcher({
      apiKey: "test",
      fetchImpl: mockFetchOk(rateLimited),
    });
    await expect(fetcher.quote("XAU")).rejects.toThrow(/rate limit/);
  });

  it("throws on non-2xx HTTP", async () => {
    const fetcher = new AlphaVantageFetcher({
      apiKey: "test",
      fetchImpl: (async () => new Response("", { status: 503 })) as unknown as typeof fetch,
    });
    await expect(fetcher.quote("XAU")).rejects.toThrow(/HTTP 503/);
  });
});
