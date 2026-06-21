// @vitest-environment node
import { describe, expect, it } from "vitest";
import { type ForwardHolding, forwardIncome, incomeGrowth } from "./forward-income.ts";
import type { IncomeTxn } from "./income.ts";

const USD = "USD";

function holding(over: Partial<ForwardHolding>): ForwardHolding {
  return {
    holdingId: over.holdingId ?? "h1",
    symbol: over.symbol ?? "AAPL",
    accountId: over.accountId ?? "a1",
    accountName: over.accountName ?? "Brokerage",
    quantity: over.quantity ?? "10",
    dividendRate: over.dividendRate ?? null,
    costBasis: over.costBasis ?? null,
  };
}

function income(over: Partial<IncomeTxn>): IncomeTxn {
  return {
    subtype: over.subtype ?? "dividend",
    tradeDate: over.tradeDate ?? "2025-01-15",
    amount: over.amount ?? "100.00",
    isoCurrencyCode: over.isoCurrencyCode ?? USD,
  };
}

describe("forwardIncome", () => {
  it("sums quantity × rate across holdings", () => {
    const result = forwardIncome(
      [
        holding({ holdingId: "h1", symbol: "AAPL", quantity: "10", dividendRate: "1.00" }),
        holding({ holdingId: "h2", symbol: "KO", quantity: "20", dividendRate: "2.00" }),
      ],
      USD,
    );
    // 10×1 + 20×2 = 50
    expect(result.total.toString()).toBe("50.00");
    expect(result.rows).toHaveLength(2);
    // Largest first (KO = 40).
    expect(result.rows[0]?.symbol).toBe("KO");
    expect(result.rows[0]?.annualIncome.toString()).toBe("40.00");
  });

  it("treats a null/blank dividend rate as zero income (not NaN)", () => {
    const result = forwardIncome(
      [
        holding({ holdingId: "h1", symbol: "AAPL", quantity: "10", dividendRate: "1.00" }),
        holding({ holdingId: "h2", symbol: "BRK.B", quantity: "5", dividendRate: null }),
        holding({ holdingId: "h3", symbol: "TSLA", quantity: "5", dividendRate: "" }),
      ],
      USD,
    );
    expect(result.total.toString()).toBe("10.00");
    // Non-income holdings are dropped from the breakdown.
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.symbol).toBe("AAPL");
  });

  it("computes per-holding and portfolio yield-on-cost from known basis", () => {
    const result = forwardIncome(
      [holding({ quantity: "10", dividendRate: "2.00", costBasis: "500.00" })],
      USD,
    );
    // income 20 / basis 500 = 4.00%
    expect(result.rows[0]?.yieldOnCost).toBe("4.00");
    expect(result.yieldOnCost).toBe("4.00");
  });

  it("leaves yield-on-cost null when basis is unknown", () => {
    const result = forwardIncome(
      [holding({ quantity: "10", dividendRate: "2.00", costBasis: null })],
      USD,
    );
    expect(result.rows[0]?.yieldOnCost).toBeNull();
    expect(result.yieldOnCost).toBeNull();
  });

  it("groups income by account, largest first", () => {
    const result = forwardIncome(
      [
        holding({
          holdingId: "h1",
          accountId: "a1",
          accountName: "IRA",
          quantity: "10",
          dividendRate: "1.00",
        }),
        holding({
          holdingId: "h2",
          accountId: "a2",
          accountName: "Brokerage",
          quantity: "30",
          dividendRate: "1.00",
        }),
      ],
      USD,
    );
    expect(result.byAccount).toHaveLength(2);
    expect(result.byAccount[0]?.accountName).toBe("Brokerage");
    expect(result.byAccount[0]?.annualIncome.toString()).toBe("30.00");
  });

  it("returns zeros for an empty portfolio", () => {
    const result = forwardIncome([], USD);
    expect(result.total.toString()).toBe("0.00");
    expect(result.yieldOnCost).toBeNull();
    expect(result.rows).toHaveLength(0);
    expect(result.byAccount).toHaveLength(0);
  });
});

describe("incomeGrowth", () => {
  it("computes year-over-year growth and a trailing run rate", () => {
    const txns: IncomeTxn[] = [
      income({ tradeDate: "2023-06-01", amount: "100.00" }),
      income({ tradeDate: "2024-06-01", amount: "150.00" }),
      // Trailing 12 months from the latest date (2024-12-01): 150 + 60 = 210.
      income({ tradeDate: "2024-12-01", amount: "60.00" }),
    ];
    const result = incomeGrowth(txns, USD);
    expect(result.points.map((p) => p.year)).toEqual(["2023", "2024"]);
    // 2024 total = 210, 2023 = 100 → (210-100)/100 = 110%.
    expect(result.points[1]?.total.toString()).toBe("210.00");
    expect(result.points[1]?.yoyPercent).toBe("110.00");
    expect(result.latestYoyPercent).toBe("110.00");
    // Trailing 12 months ending 2024-12-01 excludes 2023-06-01.
    expect(result.runRate.toString()).toBe("210.00");
  });

  it("leaves YoY null when there is no prior-year baseline", () => {
    const result = incomeGrowth([income({ tradeDate: "2024-06-01", amount: "100.00" })], USD);
    expect(result.points).toHaveLength(1);
    expect(result.points[0]?.yoyPercent).toBeNull();
    expect(result.latestYoyPercent).toBeNull();
  });

  it("returns zero run rate for no income", () => {
    const result = incomeGrowth([], USD);
    expect(result.points).toHaveLength(0);
    expect(result.runRate.toString()).toBe("0.00");
    expect(result.latestYoyPercent).toBeNull();
  });
});
