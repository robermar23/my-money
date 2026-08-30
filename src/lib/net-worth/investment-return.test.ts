// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { AccountEndpoint } from "./endpoints.ts";
import { type AccountInvestmentTxn, investmentReturn } from "./investment-return.ts";

/**
 * P17-10 — the market rung, per ADR-041 §4.
 *
 * This module is a *composition* of two shipped, tested functions —
 * `externalFlow()` and `attribution()` from
 * [investments/performance.ts](../investments/performance.ts) — applied across
 * every `investment` and `crypto_ira` account instead of one brokerage. The
 * cases below therefore assert the household-level wiring: which accounts are
 * included, which rows count as flows, and that the per-account results sum.
 *
 * If a case here starts needing return math that `attribution()` does not
 * already do, the module is being reimplemented and the task is wrong.
 */

function endpoint(over: Partial<AccountEndpoint> & Pick<AccountEndpoint, "accountId">) {
  return {
    accountName: `acct ${over.accountId}`,
    accountType: "investment",
    opening: "0.00",
    closing: "0.00",
    delta: "0.00",
    presence: "both" as const,
    ...over,
  } satisfies AccountEndpoint;
}

function byAccount(...entries: readonly AccountEndpoint[]): ReadonlyMap<string, AccountEndpoint> {
  return new Map(entries.map((e) => [e.accountId, e]));
}

function txn(
  over: Partial<AccountInvestmentTxn> & Pick<AccountInvestmentTxn, "amount">,
): AccountInvestmentTxn {
  return {
    accountId: "brk",
    type: "cash",
    subtype: "deposit",
    date: "2026-03-15",
    ...over,
  };
}

const WINDOW = { from: "2026-01-01", to: "2026-06-30" } as const;

describe("investmentReturn", () => {
  it("returns zero for a book with no investment accounts", () => {
    const result = investmentReturn(
      byAccount(endpoint({ accountId: "chk", accountType: "depository", closing: "5000.00" })),
      [],
      WINDOW.from,
      WINDOW.to,
    );

    expect(result.marketGrowth).toBe("0.00");
    expect(result.netFlows).toBe("0.00");
    expect(result.byAccount).toEqual([]);
  });

  it("credits pure appreciation with no flows entirely to market growth", () => {
    const result = investmentReturn(
      byAccount(
        endpoint({
          accountId: "brk",
          opening: "50000.00",
          closing: "58000.00",
          delta: "8000.00",
        }),
      ),
      [],
      WINDOW.from,
      WINDOW.to,
    );

    expect(result.marketGrowth).toBe("8000.00");
    expect(result.netFlows).toBe("0.00");
  });

  it("credits a flat market with a deposit to NOTHING", () => {
    // The whole point of the rung. A household that deposited $5,000 into a
    // brokerage that went nowhere did not earn $5,000 from the market — it
    // saved $5,000, and `saved` is where that belongs.
    const result = investmentReturn(
      byAccount(
        endpoint({
          accountId: "brk",
          opening: "50000.00",
          closing: "55000.00",
          delta: "5000.00",
        }),
      ),
      [txn({ amount: "5000.00" })],
      WINDOW.from,
      WINDOW.to,
    );

    expect(result.marketGrowth).toBe("0.00");
    expect(result.netFlows).toBe("5000.00");
  });

  it("adds a withdrawal back, so selling to spend is not read as a market loss", () => {
    const result = investmentReturn(
      byAccount(
        endpoint({
          accountId: "brk",
          opening: "50000.00",
          closing: "45000.00",
          delta: "-5000.00",
        }),
      ),
      [txn({ subtype: "withdrawal", amount: "5000.00" })],
      WINDOW.from,
      WINDOW.to,
    );

    expect(result.netFlows).toBe("-5000.00");
    expect(result.marketGrowth).toBe("0.00");
  });

  it("leaves a dividend INSIDE market growth, because it is internal to the portfolio", () => {
    // `externalFlow()` returns null for a dividend (money earned on money
    // already inside), so the value it added shows up as growth. That is the
    // household reading — "the portfolio produced this" — and the convention
    // Phase 9 already ships.
    const result = investmentReturn(
      byAccount(
        endpoint({
          accountId: "brk",
          opening: "50000.00",
          closing: "50400.00",
          delta: "400.00",
        }),
      ),
      [txn({ subtype: "dividend", amount: "400.00" })],
      WINDOW.from,
      WINDOW.to,
    );

    expect(result.netFlows).toBe("0.00");
    expect(result.marketGrowth).toBe("400.00");
  });

  it("treats a payroll-direct contribution buy as a flow, so the retirement rung cancels it", () => {
    // ADR-041 §3's cancellation seen from this side: the `buy` this rung
    // subtracts is the same row `payrollDirectContributions` re-adds.
    const result = investmentReturn(
      byAccount(
        endpoint({
          accountId: "401k",
          opening: "100000.00",
          closing: "107800.00",
          delta: "7800.00",
        }),
      ),
      [txn({ accountId: "401k", type: "buy", subtype: "contribution", amount: "-7800.00" })],
      WINDOW.from,
      WINDOW.to,
    );

    expect(result.netFlows).toBe("7800.00");
    expect(result.marketGrowth).toBe("0.00");
  });

  it("sums a crypto_ira alongside a brokerage", () => {
    const result = investmentReturn(
      byAccount(
        endpoint({
          accountId: "brk",
          accountType: "investment",
          opening: "50000.00",
          closing: "58000.00",
          delta: "8000.00",
        }),
        endpoint({
          accountId: "itrust",
          accountType: "crypto_ira",
          opening: "20000.00",
          closing: "26800.00",
          delta: "6800.00",
        }),
      ),
      [txn({ accountId: "itrust", amount: "1000.00" })],
      WINDOW.from,
      WINDOW.to,
    );

    expect(result.marketGrowth).toBe("13800.00");
    expect(result.netFlows).toBe("1000.00");
    expect(result.byAccount.map((a) => [a.accountId, a.marketGrowth])).toEqual([
      ["brk", "8000.00"],
      ["itrust", "5800.00"],
    ]);
  });

  it("ignores flows dated outside the window", () => {
    // The rung and the retirement rung must see the SAME rows or they stop
    // cancelling, so each windows the list itself rather than trusting the
    // caller to have done it identically.
    const result = investmentReturn(
      byAccount(
        endpoint({
          accountId: "brk",
          opening: "50000.00",
          closing: "55000.00",
          delta: "5000.00",
        }),
      ),
      [txn({ date: "2025-12-31", amount: "5000.00" })],
      WINDOW.from,
      WINDOW.to,
    );

    expect(result.netFlows).toBe("0.00");
    expect(result.marketGrowth).toBe("5000.00");
  });

  it("ignores flows on an account that has no endpoints", () => {
    // A transaction on an account absent from both `computeNetWorth` results has
    // no value to attribute against. The guarantee is structural — the result is
    // built by mapping over the market accounts, so a bucket keyed to an account
    // that is not one of them is unreachable — and the explicit skip inside the
    // collection loop is a cost guard rather than the thing that makes this
    // pass. Mutation-checking confirmed it: deleting that skip leaves this case
    // green, correctly.
    const result = investmentReturn(
      byAccount(
        endpoint({
          accountId: "brk",
          opening: "50000.00",
          closing: "58000.00",
          delta: "8000.00",
        }),
      ),
      [txn({ accountId: "ghost", amount: "5000.00" })],
      WINDOW.from,
      WINDOW.to,
    );

    expect(result.marketGrowth).toBe("8000.00");
    expect(result.netFlows).toBe("0.00");
  });

  it("ignores flows on a non-investment account", () => {
    const result = investmentReturn(
      byAccount(
        endpoint({ accountId: "chk", accountType: "depository", closing: "5000.00" }),
        endpoint({
          accountId: "brk",
          opening: "50000.00",
          closing: "58000.00",
          delta: "8000.00",
        }),
      ),
      [txn({ accountId: "chk", amount: "5000.00" })],
      WINDOW.from,
      WINDOW.to,
    );

    expect(result.marketGrowth).toBe("8000.00");
    expect(result.netFlows).toBe("0.00");
  });

  it("reports each account's endpoints alongside its growth, for the audit trail", () => {
    const result = investmentReturn(
      byAccount(
        endpoint({
          accountId: "brk",
          opening: "50000.00",
          closing: "58000.00",
          delta: "8000.00",
        }),
      ),
      [txn({ amount: "1000.00" })],
      WINDOW.from,
      WINDOW.to,
    );

    expect(result.byAccount).toEqual([
      {
        accountId: "brk",
        accountName: "acct brk",
        accountType: "investment",
        startValue: "50000.00",
        endValue: "58000.00",
        netFlows: "1000.00",
        marketGrowth: "7000.00",
      },
    ]);
  });

  it("rejects a window that runs backwards", () => {
    expect(() => investmentReturn(byAccount(), [], "2026-12-31", "2026-01-01")).toThrow();
  });
});
