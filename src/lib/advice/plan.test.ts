// @vitest-environment node
import { describe, expect, it } from "vitest";
import { makeAccount, makeAdviceInput, makeDebt } from "./advice-input.fixture.ts";
import { planReadiness } from "./plan.ts";

/**
 * The graceful-degradation matrix (P15-37, ADR-029 §5).
 *
 * The rule this file enforces is the one from the plan: **every empty state must
 * name the missing input and link to where to supply it.** A "no data" message
 * tells a user the app is broken; "2 cards have no APR recorded" tells them what
 * to do. So each case asserts the count in the copy and the destination, not just
 * that *something* was reported.
 */

/** Find a gap by its stable id, failing loudly when absent. */
function gap(readiness: ReturnType<typeof planReadiness>, id: string) {
  const found = readiness.missing.find((entry) => entry.id === id);
  expect(found, `expected a "${id}" gap`).toBeDefined();
  return found as NonNullable<typeof found>;
}

describe("planReadiness", () => {
  it("reports nothing missing on a fully-populated household", () => {
    const readiness = planReadiness(
      makeAdviceInput({
        accounts: [makeAccount({ accountId: "a", type: "depository", subtype: "checking" })],
        household: {
          profile: null,
          members: [{ id: "m", label: "A", birthYear: 1985, isDependent: false }],
        },
      }),
    );
    expect(readiness.missing).toEqual([]);
  });

  it("flags an empty book as having no history", () => {
    const readiness = planReadiness(makeAdviceInput({ historyMonths: 0 }));
    expect(readiness.hasHistory).toBe(false);
    expect(readiness.historyMonths).toBe(0);
  });

  it("names the unclassified share and links to the categories manager", () => {
    const readiness = planReadiness(makeAdviceInput({ essentials: { unclassifiedShare: 0.42 } }));
    const entry = gap(readiness, "category-necessity");
    expect(entry.detail).toContain("42%");
    expect(entry.href).toBe("/settings/categories");
  });

  it("says nothing about classification when everything is classified", () => {
    const readiness = planReadiness(makeAdviceInput({ essentials: { unclassifiedShare: 0 } }));
    expect(readiness.missing.map((entry) => entry.id)).not.toContain("category-necessity");
  });

  it("counts cash accounts with no subtype and links to /accounts", () => {
    const readiness = planReadiness(
      makeAdviceInput({
        accounts: [
          makeAccount({ accountId: "a", type: "depository", subtype: null }),
          makeAccount({ accountId: "b", type: "depository", subtype: null }),
          makeAccount({ accountId: "c", type: "depository", subtype: "savings" }),
          // A non-cash account with no subtype is not a gap — subtype only
          // tiers depository balances.
          makeAccount({ accountId: "d", type: "investment", subtype: null }),
        ],
      }),
    );
    const entry = gap(readiness, "account-subtype");
    expect(entry.detail).toContain("2 cash accounts");
    expect(entry.href).toBe("/accounts");
  });

  it("uses the singular when exactly one account is untyped", () => {
    const readiness = planReadiness(
      makeAdviceInput({
        accounts: [makeAccount({ accountId: "a", type: "depository", subtype: null })],
      }),
    );
    expect(gap(readiness, "account-subtype").detail).toContain("1 cash account has");
  });

  it("flags a debt with a balance and no APR", () => {
    const readiness = planReadiness(
      makeAdviceInput({
        debts: [makeDebt({ accountId: "card", balance: "2400.00", apr: null })],
      }),
    );
    const entry = gap(readiness, "debt-apr");
    expect(entry.detail).toContain("1 debt has");
    expect(entry.href).toBe("/accounts");
  });

  it("ignores a paid-off debt with no APR — there is nothing to order", () => {
    const readiness = planReadiness(
      makeAdviceInput({
        debts: [makeDebt({ accountId: "card", balance: "0.00", apr: null })],
      }),
    );
    expect(readiness.missing.map((entry) => entry.id)).not.toContain("debt-apr");
  });

  it("flags an absent take-home figure", () => {
    const readiness = planReadiness(makeAdviceInput({ netIncome: { trailingMedian: null } }));
    expect(gap(readiness, "net-income").detail).toContain("no denominator");
  });

  it("flags an unconfigured household and says generic multipliers are in use", () => {
    const readiness = planReadiness(makeAdviceInput());
    const entry = gap(readiness, "household");
    expect(entry.detail).toContain("generic multipliers");
    expect(entry.href).toBe("/settings/household");
  });

  it("stops flagging the household once a member is recorded", () => {
    const readiness = planReadiness(
      makeAdviceInput({
        household: {
          profile: null,
          members: [{ id: "m", label: "A", birthYear: 1985, isDependent: false }],
        },
      }),
    );
    expect(readiness.missing.map((entry) => entry.id)).not.toContain("household");
  });

  it("orders gaps by what they unlock, classification first and household last", () => {
    const readiness = planReadiness(
      makeAdviceInput({
        essentials: { unclassifiedShare: 0.2 },
        accounts: [makeAccount({ accountId: "a", type: "depository", subtype: null })],
        debts: [makeDebt({ accountId: "card", balance: "100.00", apr: null })],
      }),
    );
    expect(readiness.missing.map((entry) => entry.id)).toEqual([
      "category-necessity",
      "account-subtype",
      "debt-apr",
      "household",
    ]);
  });

  it("gives every gap a link the user can actually follow", () => {
    const readiness = planReadiness(
      makeAdviceInput({
        essentials: { unclassifiedShare: 0.5 },
        netIncome: { trailingMedian: null },
        accounts: [makeAccount({ accountId: "a", type: "depository", subtype: null })],
        debts: [makeDebt({ accountId: "card", balance: "100.00", apr: null })],
      }),
    );
    expect(readiness.missing.length).toBeGreaterThan(0);
    for (const entry of readiness.missing) {
      expect(entry.href.startsWith("/"), `${entry.id} must link somewhere`).toBe(true);
      expect(entry.linkLabel.length).toBeGreaterThan(0);
      expect(entry.detail.length).toBeGreaterThan(0);
    }
  });
});
