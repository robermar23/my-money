// @vitest-environment node
import { Money } from "@/lib/money/money.ts";
import { describe, expect, it } from "vitest";
import type { DebtTerm } from "./debt-terms.ts";
import {
  MAX_SIMULATION_MONTHS,
  type PayoffDebtInput,
  comparePayoffStrategies,
  orderDebts,
  partitionDebts,
  simulatePayoff,
} from "./payoff.ts";

/*
 * P15-18 — the payoff simulator. Pure: no DB, no fixtures, no clock.
 *
 * The two tests that matter most are the termination guard (a debt whose minimum
 * does not cover its interest must report `blocked` in bounded time, never hang)
 * and the avalanche-beats-snowball-on-interest invariant. Everything else here
 * is arithmetic that has to be right to the cent.
 */

function debt(partial: Partial<PayoffDebtInput> & { balance: string }): PayoffDebtInput {
  return {
    accountId: `acct-${partial.accountName ?? partial.balance}`,
    accountName: "Card",
    apr: "0.000000",
    minimumPayment: "100.00",
    ...partial,
  };
}

function term(partial: Partial<DebtTerm> & { accountId: string; balance: string }): DebtTerm {
  return {
    accountName: "Card",
    institution: "M&T",
    kind: "revolving",
    apr: "0.199900",
    minimumPayment: "50.00",
    creditLimit: "5000.00",
    balanceAsOf: "2026-08-01",
    termsUpdatedAt: null,
    status: "complete",
    missing: [],
    ...partial,
  };
}

describe("orderDebts", () => {
  const debts = [
    debt({ accountId: "a", accountName: "Big low-rate", balance: "12000.00", apr: "0.049900" }),
    debt({ accountId: "b", accountName: "Small high-rate", balance: "900.00", apr: "0.249900" }),
    debt({ accountId: "c", accountName: "Middle", balance: "4000.00", apr: "0.129900" }),
  ];

  it("orders the avalanche by APR, highest first", () => {
    expect(orderDebts(debts, "avalanche").map((d) => d.accountId)).toEqual(["b", "c", "a"]);
  });

  it("orders the snowball by balance, smallest first", () => {
    expect(orderDebts(debts, "snowball").map((d) => d.accountId)).toEqual(["b", "c", "a"]);
  });

  it("puts the strategies in genuinely different orders when they disagree", () => {
    const conflicting = [
      debt({ accountId: "big-rate", accountName: "Big", balance: "9000.00", apr: "0.229900" }),
      debt({ accountId: "small-rate", accountName: "Small", balance: "500.00", apr: "0.069900" }),
    ];

    expect(orderDebts(conflicting, "avalanche").map((d) => d.accountId)).toEqual([
      "big-rate",
      "small-rate",
    ]);
    expect(orderDebts(conflicting, "snowball").map((d) => d.accountId)).toEqual([
      "small-rate",
      "big-rate",
    ]);
  });

  it("breaks an APR tie on balance, then on name — deterministically", () => {
    const tied = [
      debt({ accountId: "z", accountName: "Zulu", balance: "1000.00", apr: "0.199900" }),
      debt({ accountId: "a", accountName: "Alpha", balance: "1000.00", apr: "0.199900" }),
      debt({ accountId: "s", accountName: "Smaller", balance: "400.00", apr: "0.199900" }),
    ];

    // Smaller balance first, then alphabetical. Re-sorting a reversed copy must
    // land in the same place: an advice list that reshuffles between page loads
    // reads as broken even when every figure in it is right.
    expect(orderDebts(tied, "avalanche").map((d) => d.accountId)).toEqual(["s", "a", "z"]);
    expect(orderDebts([...tied].reverse(), "avalanche").map((d) => d.accountId)).toEqual([
      "s",
      "a",
      "z",
    ]);
  });

  it("does not mutate the caller's array", () => {
    const original = [...debts];
    orderDebts(debts, "snowball");
    expect(debts).toEqual(original);
  });
});

describe("simulatePayoff — single debt", () => {
  it("retires an interest-free debt in exactly balance / payment months", () => {
    const result = simulatePayoff(
      [debt({ balance: "1000.00", minimumPayment: "100.00" })],
      "avalanche",
    );

    expect(result.status).toBe("complete");
    expect(result.monthsToDebtFree).toBe(10);
    expect(result.totalInterest).toBe("0.00");
    expect(result.totalPaid).toBe("1000.00");
    expect(result.reason).toBeNull();
  });

  it("compounds interest to the cent", () => {
    // $1,000 at 12% APR (1.00%/month) paying $100. Hand-checked month by month:
    // the final payment is a partial $58.98 in month 11.
    const result = simulatePayoff(
      [debt({ balance: "1000.00", apr: "0.120000", minimumPayment: "100.00" })],
      "avalanche",
    );

    expect(result.monthsToDebtFree).toBe(11);
    expect(result.totalInterest).toBe("58.98");
    expect(result.totalPaid).toBe("1058.98");
    expect(result.debts[0]?.remainingBalance).toBe("0.00");
    expect(result.debts[0]?.monthsToPayoff).toBe(11);
  });

  it("never overpays the final month", () => {
    const result = simulatePayoff(
      [debt({ balance: "250.00", apr: "0.180000", minimumPayment: "100.00" })],
      "avalanche",
    );

    // Total paid is principal + interest exactly — the last payment is trimmed
    // to the balance rather than billing a full minimum against a $58 debt.
    const paid = Money.fromString(result.totalPaid, "USD");
    const expected = Money.fromString("250.00", "USD").add(
      Money.fromString(result.totalInterest, "USD"),
    );
    expect(paid.toString()).toBe(expected.toString());
  });
});

describe("simulatePayoff — termination", () => {
  it("reports `blocked` when the minimum does not cover the interest", () => {
    // $5,000 at 30% APR accrues $125/month; a $100 minimum never touches the
    // principal. This must terminate, and terminate fast.
    const started = Date.now();
    const result = simulatePayoff(
      [
        debt({
          accountId: "runaway",
          accountName: "Store card",
          balance: "5000.00",
          apr: "0.300000",
          minimumPayment: "100.00",
        }),
      ],
      "avalanche",
    );

    expect(result.status).toBe("blocked");
    expect(result.monthsToDebtFree).toBeNull();
    expect(result.debts[0]?.blocked).toBe(true);
    expect(result.reason).toContain("Store card");
    // The no-progress detector fires on the first month, not after 600 of them.
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("reports `blocked` when the payment exactly equals the interest", () => {
    // The knife-edge case: the balance is unchanged, forever. "Not falling" and
    // "rising" have to be handled the same way.
    const result = simulatePayoff(
      [debt({ balance: "1200.00", apr: "0.120000", minimumPayment: "12.00" })],
      "avalanche",
    );

    expect(result.status).toBe("blocked");
    expect(result.debts[0]?.remainingBalance).toBe("1200.00");
  });

  it("respects a hard iteration ceiling even on a debt that would eventually clear", () => {
    const result = simulatePayoff(
      [debt({ balance: "10000.00", apr: "0.050000", minimumPayment: "200.00" })],
      "avalanche",
      { maxMonths: 3 },
    );

    expect(result.status).toBe("blocked");
    expect(result.reason).toContain("3 months");
  });

  it("clamps an absurd ceiling to MAX_SIMULATION_MONTHS", () => {
    // The guard is structural: no input, including a hostile one, makes this
    // loop run longer than the ceiling.
    const result = simulatePayoff(
      [debt({ balance: "1.00", apr: "0.900000", minimumPayment: "0.00" })],
      "avalanche",
      { maxMonths: Number.MAX_SAFE_INTEGER },
    );

    expect(result.status).toBe("blocked");
    expect(MAX_SIMULATION_MONTHS).toBe(600);
  });

  it("says so plainly when there are no debts at all", () => {
    const result = simulatePayoff([], "avalanche");

    expect(result.status).toBe("no_debts");
    expect(result.monthsToDebtFree).toBe(0);
    expect(result.reason).toBeNull();
  });

  it("reports unknown_input when every debt was excluded for missing terms", () => {
    const result = simulatePayoff([], "avalanche", {}, [
      { accountId: "x", accountName: "Visa", missing: ["apr"] },
    ]);

    expect(result.status).toBe("unknown_input");
    expect(result.monthsToDebtFree).toBeNull();
    expect(result.reason).toContain("no payoff plan");
    expect(result.excluded).toHaveLength(1);
  });
});

describe("simulatePayoff — the rolling snowball", () => {
  const debts = [
    debt({ accountId: "small", accountName: "Small", balance: "600.00", minimumPayment: "50.00" }),
    debt({ accountId: "big", accountName: "Big", balance: "2400.00", minimumPayment: "100.00" }),
  ];

  it("keeps the monthly outlay constant as debts clear", () => {
    const result = simulatePayoff(debts, "snowball");

    expect(result.monthlyOutlay).toBe("150.00");
    // $3,000 of interest-free debt at $150/month.
    expect(result.monthsToDebtFree).toBe(20);
    expect(result.totalPaid).toBe("3000.00");
  });

  it("rolls a cleared debt's minimum into the next one", () => {
    const result = simulatePayoff(debts, "snowball");
    const small = result.debts.find((d) => d.accountId === "small");
    const big = result.debts.find((d) => d.accountId === "big");

    // Small gets $50 + the whole surplus ($100 that Big does not need beyond its
    // own minimum? no — Big takes its $100 minimum first), so Small clears in 12
    // months at $50/month, after which Big receives the full $150.
    expect(small?.monthsToPayoff).toBe(12);
    expect(big?.monthsToPayoff).toBe(20);
  });

  it("applies an extra payment to the priority debt", () => {
    const base = simulatePayoff(debts, "snowball");
    const boosted = simulatePayoff(debts, "snowball", { extraMonthly: "150.00" });

    expect(boosted.monthlyOutlay).toBe("300.00");
    expect(boosted.monthsToDebtFree).toBe(10);
    expect(boosted.monthsToDebtFree ?? 0).toBeLessThan(base.monthsToDebtFree ?? 0);
  });
});

describe("comparePayoffStrategies", () => {
  // A deliberately conflicting shape: the biggest balance also carries the
  // highest rate, so the two strategies genuinely diverge.
  const debts = [
    debt({
      accountId: "card",
      accountName: "Rewards card",
      balance: "3000.00",
      apr: "0.240000",
      minimumPayment: "60.00",
    }),
    debt({
      accountId: "loan",
      accountName: "Signature loan",
      balance: "800.00",
      apr: "0.060000",
      minimumPayment: "25.00",
    }),
  ];

  it("holds the invariant: the avalanche never pays more interest", () => {
    const { avalanche, snowball, interestSaved } = comparePayoffStrategies(debts, {
      extraMonthly: "200.00",
    });

    expect(avalanche.status).toBe("complete");
    expect(snowball.status).toBe("complete");

    const saved = Money.fromString(snowball.totalInterest, "USD").sub(
      Money.fromString(avalanche.totalInterest, "USD"),
    );
    expect(saved.isNegative()).toBe(false);
    expect(interestSaved).toBe(saved.toString());
  });

  it("orders the two strategies differently on the same debts", () => {
    const { avalanche, snowball } = comparePayoffStrategies(debts, { extraMonthly: "200.00" });

    expect(avalanche.order).toEqual(["card", "loan"]);
    expect(snowball.order).toEqual(["loan", "card"]);
  });

  it("reports no delta when either strategy fails to complete", () => {
    const stuck = comparePayoffStrategies([
      debt({ balance: "5000.00", apr: "0.300000", minimumPayment: "100.00" }),
    ]);

    expect(stuck.interestSaved).toBeNull();
    expect(stuck.monthsSaved).toBeNull();
  });

  it("finds no delta at all when there is only one debt", () => {
    const single = comparePayoffStrategies([
      debt({ balance: "1000.00", apr: "0.120000", minimumPayment: "100.00" }),
    ]);

    expect(single.interestSaved).toBe("0.00");
    expect(single.monthsSaved).toBe(0);
  });
});

describe("partitionDebts", () => {
  it("excludes a debt with no APR rather than treating it as 0%", () => {
    // A 0% default would make the avalanche confidently recommend paying this
    // debt LAST — the exact failure mode debt-terms.ts refuses to create.
    const { simulatable, excluded } = partitionDebts([
      term({ accountId: "known", balance: "1000.00" }),
      term({
        accountId: "unknown",
        accountName: "Untriaged card",
        balance: "2000.00",
        apr: null,
        status: "unknown_input",
        missing: ["apr"],
      }),
    ]);

    expect(simulatable.map((d) => d.accountId)).toEqual(["known"]);
    expect(excluded).toEqual([
      { accountId: "unknown", accountName: "Untriaged card", missing: ["apr"] },
    ]);
  });

  it("excludes a debt with no minimum payment", () => {
    const { simulatable, excluded } = partitionDebts([
      term({
        accountId: "no-min",
        balance: "500.00",
        minimumPayment: null,
        status: "unknown_input",
        missing: ["minimum_payment"],
      }),
    ]);

    expect(simulatable).toHaveLength(0);
    expect(excluded[0]?.missing).toEqual(["minimum_payment"]);
  });

  it("drops zero-balance debts from both lists", () => {
    // A paid-off card is not part of a payoff plan, and its stale minimum would
    // inflate the monthly outlay of every simulation it appeared in.
    const { simulatable, excluded } = partitionDebts([
      term({ accountId: "cleared", balance: "0.00" }),
      term({ accountId: "cleared-no-terms", balance: "0.00", apr: null, missing: ["apr"] }),
    ]);

    expect(simulatable).toHaveLength(0);
    expect(excluded).toHaveLength(0);
  });

  it("does not report a missing credit limit as a payoff blocker", () => {
    // A card can be simulated to zero without knowing its limit; the limit
    // belongs to the utilization rule.
    const { simulatable, excluded } = partitionDebts([
      term({
        accountId: "no-limit",
        balance: "1200.00",
        creditLimit: null,
        missing: ["credit_limit"],
      }),
    ]);

    expect(simulatable).toHaveLength(1);
    expect(excluded).toHaveLength(0);
  });
});
