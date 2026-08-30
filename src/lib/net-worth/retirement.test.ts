// @vitest-environment node
import { describe, expect, it } from "vitest";
import { type ContributionTxn, payrollDirectContributions } from "./retirement.ts";

/**
 * P17-09 — the payroll-direct retirement rung, per ADR-041 §3.
 *
 * This rung closes the largest systematic hole in a naive decomposition. A 401k
 * contribution never touches checking, so `transactions` cannot see it and
 * `saved` misses it entirely — while `attribution()` correctly subtracts it as
 * an external flow so it is not mistaken for market growth. Left alone it lands
 * in `unexplained` every single period, at the same amount, forever.
 *
 * The cancellation is by construction, not by coincidence: this rung is scoped
 * to `source='income'`, the exact marker Phase 14's materializer writes, and it
 * sums the same `|amount|` that `externalFlow()` reads. That is why the two
 * cancel exactly and why the tests below care so much about the sign and the
 * source.
 */

function txn(over: Partial<ContributionTxn> & Pick<ContributionTxn, "amount">): ContributionTxn {
  return {
    accountId: "401k",
    tradeDate: "2026-03-13",
    source: "income",
    ...over,
  };
}

describe("payrollDirectContributions", () => {
  it("returns zero for an empty window", () => {
    const result = payrollDirectContributions([], "2026-01-01", "2026-12-31");

    expect(result.contributions).toBe("0.00");
    expect(result.count).toBe(0);
    expect(result.byAccount).toEqual([]);
  });

  it("sums a window of biweekly contributions", () => {
    const dates = ["2026-01-02", "2026-01-16", "2026-01-30", "2026-02-13"];
    const rows = dates.map((tradeDate) => txn({ tradeDate, amount: "-650.00" }));

    const result = payrollDirectContributions(rows, "2026-01-01", "2026-02-28");

    expect(result.contributions).toBe("2600.00");
    expect(result.count).toBe(4);
  });

  it("counts a NEGATIVE amount by its magnitude, because a contribution buy is negative", () => {
    // Phase 14's materializer writes a priceable contribution as a `buy` with a
    // negative amount (cash leaving the sleeve to acquire shares) and a
    // basis-only one as a positive `cash`/`deposit`. `externalFlow()` reads both
    // as an inflow via `|amount|`; so must this, or the two stop cancelling and
    // the rung silently subtracts money the household actually put away.
    const result = payrollDirectContributions(
      [txn({ amount: "-650.00" }), txn({ accountId: "ira", amount: "650.00" })],
      "2026-01-01",
      "2026-12-31",
    );

    expect(result.contributions).toBe("1300.00");
  });

  it("includes the employer match, because the materializer writes one row for the total", () => {
    // `contribution.ts` computes `total = employee + employer` and
    // `persistContribution` writes that single total as one row. An employer
    // match is money that entered the household without touching checking —
    // exactly what this rung exists to capture.
    const result = payrollDirectContributions(
      [txn({ amount: "-975.00" })], // 650 employee + 325 match
      "2026-01-01",
      "2026-12-31",
    );

    expect(result.contributions).toBe("975.00");
  });

  it("does NOT count a source='plaid' deposit", () => {
    // A brokerage deposit funded from a tracked checking account already
    // reconciles through `saved` and Δcash. Re-adding it here would credit the
    // household twice for one transfer.
    const result = payrollDirectContributions(
      [txn({ amount: "-5000.00", source: "plaid" })],
      "2026-01-01",
      "2026-12-31",
    );

    expect(result.contributions).toBe("0.00");
    expect(result.count).toBe(0);
  });

  it("does NOT count a source='manual' row", () => {
    const result = payrollDirectContributions(
      [txn({ amount: "-5000.00", source: "manual" })],
      "2026-01-01",
      "2026-12-31",
    );

    expect(result.contributions).toBe("0.00");
  });

  it("is inclusive at both window edges and excludes the days either side", () => {
    const rows = [
      txn({ tradeDate: "2025-12-31", amount: "-100.00" }),
      txn({ tradeDate: "2026-01-01", amount: "-200.00" }),
      txn({ tradeDate: "2026-06-30", amount: "-400.00" }),
      txn({ tradeDate: "2026-07-01", amount: "-800.00" }),
    ];

    const result = payrollDirectContributions(rows, "2026-01-01", "2026-06-30");

    expect(result.contributions).toBe("600.00");
    expect(result.count).toBe(2);
  });

  it("breaks the figure down per account, in account-id order", () => {
    const rows = [
      txn({ accountId: "roth", amount: "-200.00" }),
      txn({ accountId: "401k", amount: "-650.00" }),
      txn({ accountId: "401k", amount: "-650.00" }),
    ];

    const result = payrollDirectContributions(rows, "2026-01-01", "2026-12-31");

    expect(result.byAccount).toEqual([
      { accountId: "401k", contributions: "1300.00", count: 2 },
      { accountId: "roth", contributions: "200.00", count: 1 },
    ]);
  });

  it("rejects a window that runs backwards", () => {
    expect(() => payrollDirectContributions([], "2026-12-31", "2026-01-01")).toThrow();
  });
});
