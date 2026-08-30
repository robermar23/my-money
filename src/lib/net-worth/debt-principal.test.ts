// @vitest-environment node
import { describe, expect, it } from "vitest";
import { type AmortizingLiability, debtPrincipalPaid } from "./debt-principal.ts";

/**
 * P17-07 — the principal rung, per ADR-041 §2.
 *
 * This is the closed-form half of the phase's central trap. A $2,000 mortgage
 * payment leaves `saved` down by the full $2,000, because `transactions` has no
 * principal/interest split. This rung adds the principal back from the
 * amortization schedule — which needs no transaction at all — and the two net
 * to the interest, which is exactly what a mortgage payment costs a household's
 * net worth.
 *
 * Everything here is therefore about the SCHEDULE, never about payments: the
 * figure is `balanceAtMonth(T0) − balanceAtMonth(T1)`, and no transaction row
 * appears in any fixture below on purpose.
 */

function loan(over: Partial<AmortizingLiability> = {}): AmortizingLiability {
  return {
    accountId: "loan-1",
    name: "Sunwest 30yr",
    principalAtOrigination: "200000.00",
    annualRate: "0.06",
    termMonths: 360,
    startDate: "2020-01-01",
    ...over,
  };
}

describe("debtPrincipalPaid", () => {
  it("returns zero for no liabilities", () => {
    const result = debtPrincipalPaid([], "2026-01-01", "2026-12-31");

    expect(result.principalPaid).toBe("0.00");
    expect(result.byLiability).toEqual([]);
  });

  it("pays down MORE principal in a later year than an earlier one", () => {
    // The defining property of an amortizing loan, and the reason this rung
    // cannot be approximated by a flat monthly figure.
    const rows = [loan()];

    const year1 = debtPrincipalPaid(rows, "2020-01-01", "2020-12-31");
    const year6 = debtPrincipalPaid(rows, "2025-01-01", "2025-12-31");

    expect(Number(year1.principalPaid)).toBeGreaterThan(0);
    expect(Number(year6.principalPaid)).toBeGreaterThan(Number(year1.principalPaid));
  });

  it("computes an exact figure for a zero-rate loan", () => {
    // 120,000 over 120 months with no interest = 1,000/month exactly, so a
    // twelve-month window is 12,000.00 and there is nothing to round.
    const rows = [loan({ principalAtOrigination: "120000.00", annualRate: "0", termMonths: 120 })];

    const result = debtPrincipalPaid(rows, "2020-01-01", "2021-01-01");

    expect(result.principalPaid).toBe("12000.00");
  });

  it("returns zero for a window entirely BEFORE the loan started", () => {
    // Months elapsed floors at zero on both endpoints, so both balances are the
    // full principal and the difference is exactly nothing. A loan the family
    // had not taken out yet did not pay down any principal.
    const result = debtPrincipalPaid([loan()], "2018-01-01", "2018-12-31");

    expect(result.principalPaid).toBe("0.00");
  });

  it("returns zero — never negative — for a window past the final payment", () => {
    // Both endpoints clamp to a paid-off balance of zero. A negative principal
    // rung would read as the household having BORROWED, which is a different
    // and much more alarming claim than "this loan is finished".
    const result = debtPrincipalPaid([loan()], "2055-01-01", "2056-01-01");

    expect(result.principalPaid).toBe("0.00");
  });

  it("counts only the part of a straddling window that falls inside the term", () => {
    // A window that opens before the final payment and closes after it pays
    // down whatever was left, and not a cent more.
    const rows = [loan({ principalAtOrigination: "12000.00", annualRate: "0", termMonths: 12 })];

    const result = debtPrincipalPaid(rows, "2020-11-01", "2021-06-01");

    expect(result.principalPaid).toBe("2000.00");
  });

  it("sums several liabilities and reports each one separately", () => {
    const rows = [
      loan({
        accountId: "mortgage",
        principalAtOrigination: "120000.00",
        annualRate: "0",
        termMonths: 120,
      }),
      loan({
        accountId: "car",
        name: "Auto loan",
        principalAtOrigination: "24000.00",
        annualRate: "0",
        termMonths: 48,
      }),
    ];

    const result = debtPrincipalPaid(rows, "2020-01-01", "2021-01-01");

    // 12,000 on the mortgage + 6,000 on the car.
    expect(result.principalPaid).toBe("18000.00");
    expect(result.byLiability.map((l) => [l.accountId, l.principalPaid])).toEqual([
      ["car", "6000.00"],
      ["mortgage", "12000.00"],
    ]);
  });

  it("reports the opening and closing balances alongside the figure", () => {
    // The audit trail (ADR-039 §5): a household that disputes the rung can see
    // both ends of the schedule the app read it from.
    const rows = [loan({ principalAtOrigination: "120000.00", annualRate: "0", termMonths: 120 })];

    const [entry] = debtPrincipalPaid(rows, "2020-01-01", "2021-01-01").byLiability;

    expect(entry?.openingBalance).toBe("120000.00");
    expect(entry?.closingBalance).toBe("108000.00");
  });

  it("rejects a window that runs backwards rather than reporting negative principal", () => {
    expect(() => debtPrincipalPaid([loan()], "2026-12-31", "2026-01-01")).toThrow();
  });
});
