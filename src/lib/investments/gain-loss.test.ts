import { Money } from "@/lib/money/money.ts";
import { describe, expect, it } from "vitest";
import { gainLoss, portfolioGainLoss } from "./gain-loss.ts";

const usd = (s: string) => Money.fromString(s, "USD");

describe("gainLoss", () => {
  it("reports a positive gain in absolute dollars and percent", () => {
    const r = gainLoss({ value: usd("150.00"), costBasis: usd("100.00") });
    expect(r.absolute?.toString()).toBe("50.00");
    expect(r.percent).toBe("50.00");
  });

  it("reports a loss as negative absolute and percent", () => {
    const r = gainLoss({ value: usd("80.00"), costBasis: usd("100.00") });
    expect(r.absolute?.toString()).toBe("-20.00");
    expect(r.percent).toBe("-20.00");
  });

  it("reports zero gain when value equals basis", () => {
    const r = gainLoss({ value: usd("100.00"), costBasis: usd("100.00") });
    expect(r.absolute?.toString()).toBe("0.00");
    expect(r.percent).toBe("0.00");
  });

  it("returns nulls when cost basis is unknown", () => {
    const r = gainLoss({ value: usd("100.00"), costBasis: null });
    expect(r.absolute).toBeNull();
    expect(r.percent).toBeNull();
  });

  it("returns absolute but null percent when basis is zero (no divide-by-zero)", () => {
    const r = gainLoss({ value: usd("10.00"), costBasis: usd("0.00") });
    expect(r.absolute?.toString()).toBe("10.00");
    expect(r.percent).toBeNull();
  });

  it("rounds percent to two decimal places (banker's rounding)", () => {
    // gain 97 on basis 3 → 3233.333...% → 3233.33
    const r = gainLoss({ value: usd("100.00"), costBasis: usd("3.00") });
    expect(r.percent).toBe("3233.33");
  });

  it("throws on currency mismatch (must convert through fx first)", () => {
    expect(() =>
      gainLoss({ value: usd("100.00"), costBasis: Money.fromString("50.00", "EUR") }),
    ).toThrow();
  });
});

describe("portfolioGainLoss", () => {
  it("computes gain/loss over positions that have a known basis", () => {
    const r = portfolioGainLoss(
      [
        { value: usd("150.00"), costBasis: usd("100.00") },
        { value: usd("50.00"), costBasis: null },
      ],
      "USD",
    );
    expect(r.totalValue.toString()).toBe("200.00");
    expect(r.totalCostBasis?.toString()).toBe("100.00");
    // gain only over the basis-known subset: 150 - 100 = 50
    expect(r.absolute?.toString()).toBe("50.00");
    expect(r.percent).toBe("50.00");
  });

  it("reports null basis/gain when no position has a known basis", () => {
    const r = portfolioGainLoss(
      [
        { value: usd("150.00"), costBasis: null },
        { value: usd("50.00"), costBasis: null },
      ],
      "USD",
    );
    expect(r.totalValue.toString()).toBe("200.00");
    expect(r.totalCostBasis).toBeNull();
    expect(r.absolute).toBeNull();
    expect(r.percent).toBeNull();
  });

  it("handles an empty portfolio", () => {
    const r = portfolioGainLoss([], "USD");
    expect(r.totalValue.toString()).toBe("0.00");
    expect(r.totalCostBasis).toBeNull();
    expect(r.absolute).toBeNull();
    expect(r.percent).toBeNull();
  });
});
