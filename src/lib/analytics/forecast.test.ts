// @vitest-environment node
import { describe, expect, it } from "vitest";
import { forecastMonthlySpend, runRateToMonthEnd } from "./forecast.ts";
import type { MonthlyTotals } from "./spending.ts";

/* Pure functions — no DB, no mocks. Crisp I/O, high TDD payoff (CLAUDE.md). */

/** Terse builder for a monthly bucket; expense defaults to the byCategory sum. */
function month(
  m: string,
  byCategory: Record<string, string> = {},
  opts: { income?: string; expense?: string } = {},
): MonthlyTotals {
  const expense =
    opts.expense ??
    Object.values(byCategory)
      .reduce((acc, v) => acc + Number(v), 0)
      .toFixed(2);
  const income = opts.income ?? "0.00";
  const net = (Number(income) - Number(expense)).toFixed(2);
  return { month: m, byCategory, income, expense, net };
}

describe("forecastMonthlySpend", () => {
  it("averages the trailing N months, skipping leading empties and counting middle gaps", () => {
    const history: MonthlyTotals[] = [
      month("2026-01"), // leading empty — dropped
      month("2026-02", { a: "300.00" }), // active begins
      month("2026-03"), // gap month AFTER activity — counts as zero
      month("2026-04", { a: "300.00" }),
    ];

    const f = forecastMonthlySpend(history, { months: 3 });

    // Window = Feb/Mar/Apr → a: (300 + 0 + 300) / 3 = 200.
    expect(f.byCategory.a).toBe("200.00");
    expect(f.expense).toBe("200.00");
    expect(f.basisMonths).toBe(3);
  });

  it("averages only what exists when history is shorter than the window", () => {
    const f = forecastMonthlySpend([month("2026-04", { a: "300.00" })], { months: 3 });
    expect(f.byCategory.a).toBe("300.00"); // divide by 1, not 3
    expect(f.expense).toBe("300.00");
    expect(f.basisMonths).toBe(1);
  });

  it("returns flat zero for all-empty or empty history (no divide-by-zero)", () => {
    const allEmpty = forecastMonthlySpend([month("2026-01"), month("2026-02")], { months: 3 });
    expect(allEmpty).toEqual({
      byCategory: {},
      expense: "0.00",
      income: "0.00",
      net: "0.00",
      basisMonths: 0,
    });

    const none = forecastMonthlySpend([], { months: 3 });
    expect(none.basisMonths).toBe(0);
    expect(none.expense).toBe("0.00");
  });

  it("keeps penny precision through the mean (banker's rounding)", () => {
    const history: MonthlyTotals[] = [
      month("2026-02", { a: "10.00" }),
      month("2026-03", { a: "10.00" }),
      month("2026-04", { a: "10.05" }),
    ];
    // (10.00 + 10.00 + 10.05) / 3 = 30.05 / 3 = 10.0166… → 10.02
    expect(forecastMonthlySpend(history, { months: 3 }).byCategory.a).toBe("10.02");
  });

  it("projects income and net alongside expense", () => {
    const history: MonthlyTotals[] = [
      month("2026-03", { a: "100.00" }, { income: "1000.00" }),
      month("2026-04", { a: "200.00" }, { income: "1000.00" }),
    ];
    const f = forecastMonthlySpend(history, { months: 3 });
    expect(f.income).toBe("1000.00");
    expect(f.expense).toBe("150.00"); // (100 + 200) / 2
    expect(f.net).toBe("850.00"); // 1000 − 150
    expect(f.basisMonths).toBe(2);
  });

  it("defaults to a trailing-3 window", () => {
    const history: MonthlyTotals[] = [
      month("2026-01", { a: "999.00" }), // outside the default 3-month window
      month("2026-02", { a: "100.00" }),
      month("2026-03", { a: "100.00" }),
      month("2026-04", { a: "100.00" }),
    ];
    expect(forecastMonthlySpend(history).byCategory.a).toBe("100.00");
  });
});

describe("runRateToMonthEnd", () => {
  it("extrapolates month-to-date spend at the elapsed run-rate", () => {
    // Day 10 of a 30-day month, $100 so far → $300 projected.
    const now = new Date("2026-06-10T12:00:00Z");
    expect(runRateToMonthEnd("100.00", "2026-06", now)).toBe("300.00");
  });

  it("keeps penny precision on uneven run-rates", () => {
    // Day 7 of June (30 days): 100 × 30 / 7 = 428.571… → 428.57.
    const now = new Date("2026-06-07T00:00:00Z");
    expect(runRateToMonthEnd("100.00", "2026-06", now)).toBe("428.57");
  });

  it("returns null for a past month (the actual is already final)", () => {
    const now = new Date("2026-06-15T00:00:00Z");
    expect(runRateToMonthEnd("500.00", "2026-05", now)).toBeNull();
  });

  it("returns null for a future month (nothing to extrapolate)", () => {
    const now = new Date("2026-06-15T00:00:00Z");
    expect(runRateToMonthEnd("0.00", "2026-07", now)).toBeNull();
  });

  it("returns the actual unchanged on the last day of the month", () => {
    const now = new Date("2026-06-30T23:00:00Z");
    expect(runRateToMonthEnd("742.19", "2026-06", now)).toBe("742.19");
  });
});
