import { describe, expect, it } from "vitest";
import { type IncomeTxn, incomeByPeriod } from "./income.ts";

const txn = (subtype: string | null, tradeDate: string, amount: string): IncomeTxn => ({
  subtype,
  tradeDate,
  amount,
  isoCurrencyCode: "USD",
});

describe("incomeByPeriod", () => {
  it("sums dividends and interest per month and ignores non-income rows", () => {
    const points = incomeByPeriod(
      [
        txn("dividend", "2026-01-10", "10.00"),
        txn("dividend", "2026-01-20", "5.00"),
        txn("interest", "2026-01-31", "2.00"),
        txn(null, "2026-01-15", "-500.00"), // a buy — ignored
        txn("fee", "2026-01-15", "-1.00"), // a fee — ignored
      ],
      "month",
      "USD",
    );
    expect(points).toHaveLength(1);
    expect(points[0]).toMatchObject({ period: "2026-01" });
    expect(points[0]?.dividend.toString()).toBe("15.00");
    expect(points[0]?.interest.toString()).toBe("2.00");
    expect(points[0]?.total.toString()).toBe("17.00");
  });

  it("groups by calendar quarter", () => {
    const points = incomeByPeriod(
      [txn("dividend", "2026-01-15", "10.00"), txn("dividend", "2026-03-20", "5.00")],
      "quarter",
      "USD",
    );
    expect(points).toHaveLength(1);
    expect(points[0]?.period).toBe("2026-Q1");
    expect(points[0]?.total.toString()).toBe("15.00");
  });

  it("groups by year and sorts periods ascending", () => {
    const points = incomeByPeriod(
      [txn("dividend", "2026-02-01", "5.00"), txn("interest", "2025-12-31", "3.00")],
      "year",
      "USD",
    );
    expect(points.map((p) => p.period)).toEqual(["2025", "2026"]);
    expect(points[0]?.interest.toString()).toBe("3.00");
    expect(points[1]?.dividend.toString()).toBe("5.00");
  });

  it("returns an empty array when there is no income", () => {
    expect(incomeByPeriod([], "month", "USD")).toEqual([]);
    expect(incomeByPeriod([txn(null, "2026-01-01", "100.00")], "month", "USD")).toEqual([]);
  });
});
