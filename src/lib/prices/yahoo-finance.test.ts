import { describe, expect, it, vi } from "vitest";

// Mock the yahoo-finance2 module before importing the fetcher so the fetcher's
// `import yahooFinance from "yahoo-finance2"` resolves to our stub. This keeps
// the test offline.
vi.mock("yahoo-finance2", () => ({
  default: { quote: vi.fn() },
}));

const yahooModule = await import("yahoo-finance2");
const { YahooFinanceFetcher } = await import("./yahoo-finance.ts");

describe("YahooFinanceFetcher", () => {
  it("returns a normalized quote from the library", async () => {
    (yahooModule.default.quote as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      symbol: "aapl",
      regularMarketPrice: 234.56,
      // Extra fields the library returns — must be ignored without failing schema validation.
      currency: "USD",
      marketCap: 3_500_000_000_000,
    });

    const q = await new YahooFinanceFetcher().quote("AAPL");
    expect(q.symbol).toBe("AAPL");
    expect(q.close).toBe("234.56000000");
    expect(q.source).toBe("yahoo");
    expect(q.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("throws when regularMarketPrice is missing", async () => {
    (yahooModule.default.quote as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      symbol: "AAPL",
      // no regularMarketPrice
    });
    await expect(new YahooFinanceFetcher().quote("AAPL")).rejects.toThrow(/schema/);
  });

  it("propagates upstream errors", async () => {
    (yahooModule.default.quote as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("network blip"),
    );
    await expect(new YahooFinanceFetcher().quote("AAPL")).rejects.toThrow(/network blip/);
  });
});
