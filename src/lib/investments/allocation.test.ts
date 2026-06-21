import { Money } from "@/lib/money/money.ts";
import { describe, expect, it } from "vitest";
import {
  type ValuedHolding,
  allocationByAccount,
  allocationByAssetClass,
  allocationByAssetType,
  allocationByRegion,
  allocationBySector,
  concentration,
} from "./allocation.ts";

const usd = (s: string) => Money.fromString(s, "USD");
const vh = (assetClass: string, accountId: string, value: string): ValuedHolding => ({
  assetClass,
  accountId,
  value: usd(value),
});

describe("allocationByAssetClass", () => {
  it("groups by asset class with value and percent, largest first", () => {
    const slices = allocationByAssetClass(
      [
        vh("equity", "a", "600.00"),
        vh("crypto", "a", "300.00"),
        vh("physical_metal", "b", "100.00"),
      ],
      "USD",
    );
    expect(slices.map((s) => s.label)).toEqual(["equity", "crypto", "physical_metal"]);
    expect(slices.map((s) => s.value.toString())).toEqual(["600.00", "300.00", "100.00"]);
    expect(slices.map((s) => s.percent)).toEqual(["60.00", "30.00", "10.00"]);
  });

  it("sums multiple holdings within the same class", () => {
    const slices = allocationByAssetClass(
      [vh("equity", "a", "400.00"), vh("equity", "b", "200.00")],
      "USD",
    );
    expect(slices).toHaveLength(1);
    expect(slices[0]?.value.toString()).toBe("600.00");
    expect(slices[0]?.percent).toBe("100.00");
  });

  it("forces percents to sum to exactly 100.00, remainder to the largest slice", () => {
    const slices = allocationByAssetClass(
      [vh("equity", "a", "1.00"), vh("crypto", "b", "1.00"), vh("cash", "c", "1.00")],
      "USD",
    );
    const sum = slices.reduce((acc, s) => acc + Number(s.percent), 0);
    expect(sum).toBeCloseTo(100, 5);
    // remainder (0.01) lands on the first (largest / tie-break-first) slice
    expect(slices[0]?.percent).toBe("33.34");
    expect(slices[1]?.percent).toBe("33.33");
    expect(slices[2]?.percent).toBe("33.33");
  });

  it("excludes zero-value classes", () => {
    const slices = allocationByAssetClass(
      [vh("equity", "a", "100.00"), vh("crypto", "b", "0.00")],
      "USD",
    );
    expect(slices.map((s) => s.label)).toEqual(["equity"]);
    expect(slices[0]?.percent).toBe("100.00");
  });

  it("returns an empty array when total value is zero", () => {
    expect(allocationByAssetClass([vh("equity", "a", "0.00")], "USD")).toEqual([]);
    expect(allocationByAssetClass([], "USD")).toEqual([]);
  });
});

describe("allocationByAccount", () => {
  it("groups by account and resolves display names", () => {
    const slices = allocationByAccount(
      [vh("equity", "a", "750.00"), vh("crypto", "b", "250.00")],
      "USD",
      { a: "Fidelity", b: "iTrust" },
    );
    expect(slices.map((s) => s.label)).toEqual(["Fidelity", "iTrust"]);
    expect(slices.map((s) => s.percent)).toEqual(["75.00", "25.00"]);
  });

  it("falls back to the account id when no name is provided", () => {
    const slices = allocationByAccount([vh("equity", "acct-1", "100.00")], "USD");
    expect(slices[0]?.label).toBe("acct-1");
  });
});

describe("allocationBySector / byRegion / byAssetType", () => {
  const meta = (
    value: string,
    extra: Partial<Pick<ValuedHolding, "sector" | "region" | "assetType">>,
  ): ValuedHolding => ({ assetClass: "equity", accountId: "a", value: usd(value), ...extra });

  it("groups by sector, percents sum to 100.00", () => {
    const slices = allocationBySector(
      [
        meta("600.00", { sector: "Technology" }),
        meta("300.00", { sector: "Healthcare" }),
        meta("100.00", { sector: "Technology" }),
      ],
      "USD",
    );
    expect(slices.map((s) => s.label)).toEqual(["Technology", "Healthcare"]);
    expect(slices.map((s) => s.value.toString())).toEqual(["700.00", "300.00"]);
    expect(slices.reduce((acc, s) => acc + Number(s.percent), 0)).toBeCloseTo(100, 5);
  });

  it("buckets null / blank sector into Unclassified", () => {
    const slices = allocationBySector(
      [
        meta("400.00", { sector: "Technology" }),
        meta("300.00", { sector: null }),
        meta("300.00", { sector: "   " }),
      ],
      "USD",
    );
    const unclassified = slices.find((s) => s.label === "Unclassified");
    expect(unclassified?.value.toString()).toBe("600.00");
  });

  it("groups by region and by asset type", () => {
    const holdings = [
      meta("700.00", { region: "United States", assetType: "equity" }),
      meta("300.00", { region: "Japan", assetType: "etf" }),
    ];
    expect(allocationByRegion(holdings, "USD").map((s) => s.label)).toEqual([
      "United States",
      "Japan",
    ]);
    expect(allocationByAssetType(holdings, "USD").map((s) => s.label)).toEqual(["equity", "etf"]);
  });
});

describe("concentration", () => {
  const pos = (label: string, value: string) => ({ label, value: usd(value) });

  it("returns the top-N positions largest first with portfolio-share percents", () => {
    const c = concentration(
      [pos("AAPL", "500.00"), pos("MSFT", "300.00"), pos("VTI", "200.00")],
      "USD",
      2,
    );
    expect(c.top.map((r) => r.label)).toEqual(["AAPL", "MSFT"]);
    expect(c.top.map((r) => r.percent)).toEqual(["50.00", "30.00"]);
    // top-2 of a 3-name book → does NOT sum to 100
    expect(c.topPercent).toBe("80.00");
  });

  it("returns all positions when topN exceeds the count", () => {
    const c = concentration([pos("AAPL", "600.00"), pos("MSFT", "400.00")], "USD");
    expect(c.top).toHaveLength(2);
    expect(c.topPercent).toBe("100.00");
  });

  it("drops zero-value positions and returns empty on a zero total", () => {
    expect(concentration([pos("AAPL", "0.00")], "USD")).toEqual({ top: [], topPercent: "0.00" });
    expect(concentration([], "USD")).toEqual({ top: [], topPercent: "0.00" });
  });
});
