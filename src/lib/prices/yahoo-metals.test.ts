import { afterEach, describe, expect, it, vi } from "vitest";
import { YahooMetalsFetcher } from "./yahoo-metals.ts";

/** Build a stub `fetch` Response carrying a minimal chart payload. */
function chartResponse(regularMarketPrice: number | undefined) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      chart: {
        error: null,
        result: [
          {
            meta: regularMarketPrice !== undefined ? { regularMarketPrice } : {},
            indicators: { quote: [{ close: [] }] },
          },
        ],
      },
    }),
  } as Response;
}

afterEach(() => vi.restoreAllMocks());

describe("YahooMetalsFetcher", () => {
  it("translates XAU to GC=F and returns the canonical symbol", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(chartResponse(2345.6));

    const q = await new YahooMetalsFetcher().quote("XAU");

    // GC=F is URL-encoded in the chart path.
    expect(fetchMock.mock.calls[0]?.[0]).toContain("/v8/finance/chart/GC%3DF");
    expect(q.symbol).toBe("XAU");
    expect(q.close).toBe("2345.60000000");
    expect(q.source).toBe("yahoo");
    expect(q.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("translates XAG to SI=F", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(chartResponse(30.25));

    const q = await new YahooMetalsFetcher().quote("XAG");

    expect(fetchMock.mock.calls[0]?.[0]).toContain("/v8/finance/chart/SI%3DF");
    expect(q.symbol).toBe("XAG");
  });

  it("uppercases lowercase input", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(chartResponse(2345.6));

    const q = await new YahooMetalsFetcher().quote("xau");

    expect(fetchMock.mock.calls[0]?.[0]).toContain("/v8/finance/chart/GC%3DF");
    expect(q.symbol).toBe("XAU");
  });

  it("rejects unsupported metal symbols", async () => {
    await expect(new YahooMetalsFetcher().quote("XBT")).rejects.toThrow(
      /Unsupported metal symbol "XBT"/,
    );
  });

  it("throws when no usable price is present", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(chartResponse(undefined));
    await expect(new YahooMetalsFetcher().quote("XAU")).rejects.toThrow(/no usable price/);
  });

  it("propagates upstream errors", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("network blip"));
    await expect(new YahooMetalsFetcher().quote("XAU")).rejects.toThrow(/network blip/);
  });
});
