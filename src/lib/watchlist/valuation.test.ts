import { describe, expect, it } from "vitest";
import { paperValuation } from "./valuation.ts";

/**
 * Unit tests for the watchlist paper-position valuation (P11-09). Pure Money
 * math — cents must be exact (no float drift), and the two "unknown" cases must
 * collapse to nulls rather than throw.
 */
describe("paperValuation", () => {
  const usd = (item: { qty: string | null; cost: string | null }) => ({
    pretendQuantity: item.qty,
    pretendUnitCost: item.cost,
    currency: "USD",
  });

  it("computes a gain when the latest close exceeds the unit cost", () => {
    const v = paperValuation(usd({ qty: "10", cost: "100.00" }), "150.00");
    expect(v.value?.toString()).toBe("1500.00");
    expect(v.costBasis?.toString()).toBe("1000.00");
    expect(v.gainLoss.absolute?.toString()).toBe("500.00");
    expect(v.gainLoss.percent).toBe("50.00");
  });

  it("computes a loss when the latest close is below the unit cost", () => {
    const v = paperValuation(usd({ qty: "4", cost: "250.00" }), "200.00");
    expect(v.value?.toString()).toBe("800.00");
    expect(v.costBasis?.toString()).toBe("1000.00");
    expect(v.gainLoss.absolute?.toString()).toBe("-200.00");
    expect(v.gainLoss.percent).toBe("-20.00");
  });

  it("keeps fractional-quantity cents exact (no float drift)", () => {
    // 0.10000000 × 65000.12 = 6500.012 → 6500.01 at cents.
    const v = paperValuation(usd({ qty: "0.10000000", cost: "60000.00" }), "65000.12");
    expect(v.value?.toString()).toBe("6500.01");
    expect(v.costBasis?.toString()).toBe("6000.00");
  });

  it("returns all-null for a watch-only item (no pretend position)", () => {
    const v = paperValuation(usd({ qty: null, cost: null }), "150.00");
    expect(v.value).toBeNull();
    expect(v.costBasis).toBeNull();
    expect(v.gainLoss.absolute).toBeNull();
    expect(v.gainLoss.percent).toBeNull();
  });

  it("returns a known basis but null value/gain when the price is missing", () => {
    const v = paperValuation(usd({ qty: "10", cost: "100.00" }), null);
    expect(v.value).toBeNull();
    expect(v.costBasis?.toString()).toBe("1000.00");
    expect(v.gainLoss.absolute).toBeNull();
    expect(v.gainLoss.percent).toBeNull();
  });
});
