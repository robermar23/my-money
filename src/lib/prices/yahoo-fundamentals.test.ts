// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchFundamentals, normalizeAssetType, parseFundamentals } from "./yahoo-fundamentals.ts";

/**
 * P9-06 — the parser is the always-test pure core (Yahoo boundary). The network
 * wrapper is exercised only for its SEC:-synthetic short-circuit (no fetch).
 */

const AAPL_FIXTURE = {
  quoteSummary: {
    error: null,
    result: [
      {
        assetProfile: {
          sector: "Technology",
          industry: "Consumer Electronics",
          country: "United States",
        },
        quoteType: { quoteType: "EQUITY" },
        summaryDetail: {
          dividendRate: { raw: 0.96, fmt: "0.96" },
          exDividendDate: { raw: 1707264000, fmt: "2024-02-07" }, // 2024-02-07T00:00:00Z
          annualReportExpenseRatio: { raw: 0.0945, fmt: "9.45%" },
        },
      },
    ],
  },
};

describe("parseFundamentals", () => {
  it("extracts sector/industry/region/type/dividend/ex-date/expense from a full payload", () => {
    const f = parseFundamentals(AAPL_FIXTURE);
    expect(f).toEqual({
      sector: "Technology",
      industry: "Consumer Electronics",
      region: "United States",
      assetType: "equity",
      expenseRatio: "0.0945",
      dividendRate: "0.96",
      dividendExDate: "2024-02-07",
    });
  });

  it("tolerates a sparse payload — missing modules become null", () => {
    const f = parseFundamentals({
      quoteSummary: { error: null, result: [{ quoteType: { quoteType: "ETF" } }] },
    });
    expect(f).toEqual({
      sector: null,
      industry: null,
      region: null,
      assetType: "etf",
      expenseRatio: null,
      dividendRate: null,
      dividendExDate: null,
    });
  });

  it("returns null for a malformed payload, an upstream error, or no result", () => {
    expect(parseFundamentals({})).toBeNull();
    expect(parseFundamentals(null)).toBeNull();
    expect(
      parseFundamentals({ quoteSummary: { error: { code: "Not Found" }, result: [] } }),
    ).toBeNull();
    expect(parseFundamentals({ quoteSummary: { error: null, result: [] } })).toBeNull();
  });
});

describe("normalizeAssetType", () => {
  it("maps Yahoo quote types to our buckets", () => {
    expect(normalizeAssetType("EQUITY")).toBe("equity");
    expect(normalizeAssetType("ETF")).toBe("etf");
    expect(normalizeAssetType("MUTUALFUND")).toBe("mutual_fund");
    expect(normalizeAssetType("CRYPTOCURRENCY")).toBe("crypto");
    expect(normalizeAssetType("MONEYMARKET")).toBe("cash");
    expect(normalizeAssetType("FUTURE")).toBe("other");
    expect(normalizeAssetType(null)).toBeNull();
    expect(normalizeAssetType(undefined)).toBeNull();
  });
});

describe("fetchFundamentals", () => {
  afterEach(() => vi.restoreAllMocks());

  it("short-circuits SEC: synthetic symbols without any network call", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const result = await fetchFundamentals("SEC:plaid-proprietary-fund");
    expect(result).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
