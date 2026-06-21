import { describe, expect, it } from "vitest";
import { buildFetchWorkList } from "./fetch-prices-daily.ts";

/**
 * Unit test for the price-fetch work-list union/dedup (P11-05). Pure — no DB,
 * no fetchers. The invariant: held ∪ watched ∪ {^GSPC}, each symbol once.
 */
describe("buildFetchWorkList", () => {
  it("unions held + watched + benchmark, de-duping a held+watched symbol", () => {
    const work = buildFetchWorkList(
      [{ symbol: "AAPL", assetClass: "equity" }],
      [
        { symbol: "AAPL", assetClass: "equity" },
        { symbol: "BTC", assetClass: "crypto" },
      ],
    );
    expect(work.map((w) => w.symbol)).toEqual(["AAPL", "BTC", "^GSPC"]);
  });

  it("always includes the benchmark even with no held or watched symbols", () => {
    expect(buildFetchWorkList([], [])).toEqual([{ symbol: "^GSPC", assetClass: "equity" }]);
  });

  it("does not duplicate the benchmark when it is already held", () => {
    const work = buildFetchWorkList([{ symbol: "^GSPC", assetClass: "equity" }], []);
    expect(work).toEqual([{ symbol: "^GSPC", assetClass: "equity" }]);
  });

  it("preserves each source's asset class for the first occurrence", () => {
    const work = buildFetchWorkList(
      [{ symbol: "XAU", assetClass: "physical_metal" }],
      [{ symbol: "ETH", assetClass: "crypto" }],
    );
    expect(work).toEqual([
      { symbol: "XAU", assetClass: "physical_metal" },
      { symbol: "ETH", assetClass: "crypto" },
      { symbol: "^GSPC", assetClass: "equity" },
    ]);
  });
});
