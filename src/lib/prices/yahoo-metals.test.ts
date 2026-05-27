import { describe, expect, it, vi } from "vitest";

// Mock yahoo-finance2 before importing the fetcher so its
// `import yahooFinance from "yahoo-finance2"` resolves to our stub.
vi.mock("yahoo-finance2", () => ({
  default: { quote: vi.fn() },
}));

const yahooModule = await import("yahoo-finance2");
const { YahooMetalsFetcher } = await import("./yahoo-metals.ts");

describe("YahooMetalsFetcher", () => {
  it("translates XAU to GC=F and returns the canonical symbol", async () => {
    const mock = yahooModule.default.quote as ReturnType<typeof vi.fn>;
    mock.mockResolvedValueOnce({ regularMarketPrice: 2345.6, currency: "USD" });

    const q = await new YahooMetalsFetcher().quote("XAU");

    expect(mock).toHaveBeenCalledWith("GC=F");
    expect(q.symbol).toBe("XAU");
    expect(q.close).toBe("2345.60000000");
    expect(q.source).toBe("yahoo");
    expect(q.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("translates XAG to SI=F", async () => {
    const mock = yahooModule.default.quote as ReturnType<typeof vi.fn>;
    mock.mockResolvedValueOnce({ regularMarketPrice: 30.25 });

    const q = await new YahooMetalsFetcher().quote("XAG");

    expect(mock).toHaveBeenCalledWith("SI=F");
    expect(q.symbol).toBe("XAG");
  });

  it("uppercases lowercase input", async () => {
    const mock = yahooModule.default.quote as ReturnType<typeof vi.fn>;
    mock.mockResolvedValueOnce({ regularMarketPrice: 2345.6 });

    const q = await new YahooMetalsFetcher().quote("xau");

    expect(mock).toHaveBeenCalledWith("GC=F");
    expect(q.symbol).toBe("XAU");
  });

  it("rejects unsupported metal symbols", async () => {
    await expect(new YahooMetalsFetcher().quote("XBT")).rejects.toThrow(
      /Unsupported metal symbol "XBT"/,
    );
  });

  it("throws when regularMarketPrice is missing", async () => {
    const mock = yahooModule.default.quote as ReturnType<typeof vi.fn>;
    mock.mockResolvedValueOnce({ symbol: "GC=F" });
    await expect(new YahooMetalsFetcher().quote("XAU")).rejects.toThrow(/schema/);
  });

  it("propagates upstream errors", async () => {
    const mock = yahooModule.default.quote as ReturnType<typeof vi.fn>;
    mock.mockRejectedValueOnce(new Error("network blip"));
    await expect(new YahooMetalsFetcher().quote("XAU")).rejects.toThrow(/network blip/);
  });
});
