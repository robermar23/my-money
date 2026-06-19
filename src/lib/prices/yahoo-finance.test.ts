import { afterEach, describe, expect, it, vi } from "vitest";
import { YahooFinanceFetcher } from "./yahoo-finance.ts";

/** Build a stub `fetch` Response carrying the given chart JSON. */
function chartResponse(body: unknown, init: { ok?: boolean; status?: number } = {}) {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => body,
  } as Response;
}

/** A minimal well-formed chart payload. */
function chartBody(opts: { regularMarketPrice?: number; closes?: (number | null)[] }) {
  return {
    chart: {
      error: null,
      result: [
        {
          meta:
            opts.regularMarketPrice !== undefined
              ? { regularMarketPrice: opts.regularMarketPrice }
              : {},
          indicators: { quote: [{ close: opts.closes ?? [] }] },
        },
      ],
    },
  };
}

afterEach(() => vi.restoreAllMocks());

describe("YahooFinanceFetcher", () => {
  it("returns a normalized quote from the chart meta", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        chartResponse(chartBody({ regularMarketPrice: 234.56, closes: [230] })),
      );

    const q = await new YahooFinanceFetcher().quote("AAPL");

    expect(fetchMock.mock.calls[0]?.[0]).toContain("/v8/finance/chart/AAPL");
    expect(q.symbol).toBe("AAPL");
    expect(q.close).toBe("234.56000000");
    expect(q.source).toBe("yahoo");
    expect(q.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("uppercases the requested symbol so it joins back to holdings", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      chartResponse(chartBody({ regularMarketPrice: 100 })),
    );
    const q = await new YahooFinanceFetcher().quote("aapl");
    expect(q.symbol).toBe("AAPL");
  });

  it("falls back to the last non-null close when meta price is absent", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      chartResponse(chartBody({ closes: [12.34, null] })),
    );
    const q = await new YahooFinanceFetcher().quote("FOO");
    expect(q.close).toBe("12.34000000");
  });

  it("throws when no usable price is present", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      chartResponse(chartBody({ closes: [null] })),
    );
    await expect(new YahooFinanceFetcher().quote("AAPL")).rejects.toThrow(/no usable price/);
  });

  it("throws on a non-200 response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(chartResponse({}, { ok: false, status: 404 }));
    await expect(new YahooFinanceFetcher().quote("AAPL")).rejects.toThrow(/HTTP 404/);
  });

  it("propagates upstream errors", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("network blip"));
    await expect(new YahooFinanceFetcher().quote("AAPL")).rejects.toThrow(/network blip/);
  });
});
