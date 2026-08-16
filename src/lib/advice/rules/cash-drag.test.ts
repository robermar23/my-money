// @vitest-environment node
import { Money } from "@/lib/money/money.ts";
import { describe, expect, it } from "vitest";
import {
  type FixtureCashAccount,
  makeAdviceInput,
  makeCash,
  makeMember,
  makeProfile,
} from "../advice-input.fixture.ts";
import { cashDragRule, cashExcess, suggestLadder } from "./cash-drag.ts";

/*
 * P15-20 — the cash-drag rule. Pure: no DB, no clock beyond the injected date.
 *
 * Reference household: $3,000/month essentials, income from two sources (so a
 * 3-month reserve), $5,000 in checking and $25,000 in savings. Targets are
 * $3,000 operating + $9,000 reserve = $12,000, leaving $18,000 idle.
 */

const DIVERSIFIED = [
  { categoryId: "c1", name: "Salary A", total: "40000.00", excluded: false },
  { categoryId: "c2", name: "Salary B", total: "32000.00", excluded: false },
];

function household(
  accounts: readonly FixtureCashAccount[],
  extra: Parameters<typeof makeAdviceInput>[0] = {},
) {
  return makeAdviceInput({
    netIncome: { trailingMedian: "6000.00", contributingCategories: DIVERSIFIED },
    cash: makeCash(accounts, "3000.00"),
    ...extra,
  });
}

const FLUSH: readonly FixtureCashAccount[] = [
  { name: "Everyday", subtype: "checking", balance: "5000.00" },
  { name: "Savings", subtype: "savings", balance: "25000.00", apy: "0.5000" },
];

describe("cashExcess", () => {
  it("sizes both targets and the excess above them", () => {
    const excess = cashExcess(household(FLUSH));

    expect(excess.operatingTarget).toBe("3000.00");
    expect(excess.reserveTarget).toBe("9000.00");
    expect(excess.reserveMonths).toBe(3);
    expect(excess.liquid).toBe("30000.00");
    expect(excess.excess).toBe("18000.00");
  });

  it("uses the same reserve multiplier the emergency-fund rule chose", () => {
    // A dependent moves the reserve to 6 months, which moves the excess by three
    // months of essentials. Two rules disagreeing about the reserve size on one
    // screen would read as a bug even if both were internally consistent.
    const excess = cashExcess(
      household(FLUSH, {
        household: { members: [makeMember({ id: "kid", isDependent: true })] },
      }),
    );

    expect(excess.reserveMonths).toBe(6);
    expect(excess.reserveTarget).toBe("18000.00");
    expect(excess.excess).toBe("9000.00");
  });

  it("floors the excess at zero for a household that is short of cash", () => {
    const excess = cashExcess(
      household([{ name: "Everyday", subtype: "checking", balance: "1200.00" }]),
    );

    expect(excess.excess).toBe("0.00");
  });

  it("computes forgone yield when both rate inputs are recorded", () => {
    const excess = cashExcess(
      household(FLUSH, {
        household: { profile: makeProfile({ benchmarkSavingsApy: "4.5000" }) },
      }),
    );

    // $18,000 idle at 0.5% against a 4.5% benchmark: a 4-point spread.
    expect(excess.weightedApy).toBe("0.5");
    expect(excess.benchmarkApy).toBe("4.5000");
    expect(excess.forgoneAnnualYield).toBe("720.00");
  });

  it("balance-weights the yield across savings accounts", () => {
    const excess = cashExcess(
      household(
        [
          { name: "Everyday", subtype: "checking", balance: "5000.00" },
          { name: "Low", subtype: "savings", balance: "15000.00", apy: "1.0000" },
          { name: "High", subtype: "money_market", balance: "5000.00", apy: "5.0000" },
        ],
        { household: { profile: makeProfile({ benchmarkSavingsApy: "5.0000" }) } },
      ),
    );

    // (15,000 × 1% + 5,000 × 5%) / 20,000 = 2%.
    expect(excess.weightedApy).toBe("2");
  });

  it("reports no forgone yield when the household has set no benchmark", () => {
    const excess = cashExcess(household(FLUSH));

    // ADR-033 rejected fetching a market rate; without the user's own number
    // there is nothing honest to compare against.
    expect(excess.benchmarkApy).toBeNull();
    expect(excess.forgoneAnnualYield).toBeNull();
  });

  it("reports no forgone yield when a savings account has no APY on file", () => {
    const excess = cashExcess(
      household(
        [
          { name: "Everyday", subtype: "checking", balance: "5000.00" },
          { name: "Savings", subtype: "savings", balance: "25000.00", apy: null },
        ],
        { household: { profile: makeProfile({ benchmarkSavingsApy: "4.5000" }) } },
      ),
    );

    // Treating a blank APY as 0% would manufacture a dramatic number out of
    // missing data. The gap is reported as unknown, and the blank is counted.
    expect(excess.weightedApy).toBeNull();
    expect(excess.forgoneAnnualYield).toBeNull();
    expect(excess.accountsMissingApy).toBe(1);
  });

  it("reports no forgone yield when savings already beat the benchmark", () => {
    const excess = cashExcess(
      household(
        [
          { name: "Everyday", subtype: "checking", balance: "5000.00" },
          { name: "Savings", subtype: "savings", balance: "25000.00", apy: "5.0000" },
        ],
        { household: { profile: makeProfile({ benchmarkSavingsApy: "4.0000" }) } },
      ),
    );

    // A negative "forgone yield" is nonsense; earning more than your own
    // benchmark is not a problem to solve.
    expect(excess.forgoneAnnualYield).toBeNull();
  });

  it("returns null targets when there is no essential baseline", () => {
    const excess = cashExcess(
      household(FLUSH, { essentials: { baseline: null, trailingMedian: null } }),
    );

    expect(excess.excess).toBeNull();
    expect(excess.operatingTarget).toBeNull();
  });
});

describe("suggestLadder", () => {
  it("splits into equal rungs with staggered maturities", () => {
    const ladder = suggestLadder("18000.00", "2026-08-15");

    expect(ladder).toHaveLength(4);
    expect(ladder.map((r) => r.amount)).toEqual(["4500.00", "4500.00", "4500.00", "4500.00"]);
    expect(ladder.map((r) => r.maturityMonths)).toEqual([3, 6, 9, 12]);
    expect(ladder.map((r) => r.maturityDate)).toEqual([
      "2026-11-15",
      "2027-02-15",
      "2027-05-15",
      "2027-08-15",
    ]);
  });

  it("gives the rounding remainder to the final rung so the rungs sum exactly", () => {
    const ladder = suggestLadder("10000.01", "2026-08-15");
    const total = ladder.reduce(
      (acc, rung) => acc.add(Money.fromString(rung.amount, "USD")),
      Money.zero("USD"),
    );

    // Four independently-rounded quarters would lose or invent a cent.
    expect(total.toString()).toBe("10000.01");
    expect(ladder.at(-1)?.amount).toBe("2500.01");
  });

  it("clamps a month-end start date rather than rolling into the next month", () => {
    const ladder = suggestLadder("400.00", "2026-01-31", 2, 1);

    expect(ladder[0]?.maturityDate).toBe("2026-02-28");
    expect(ladder[1]?.maturityDate).toBe("2026-03-31");
  });

  it("degenerates to a single rung rather than dividing by zero", () => {
    const ladder = suggestLadder("500.00", "2026-08-15", 0);

    expect(ladder).toHaveLength(1);
    expect(ladder[0]?.amount).toBe("500.00");
  });
});

describe("cashDragRule", () => {
  it("recommends a ladder structure and an amount", () => {
    const [rec] = cashDragRule.evaluate(household(FLUSH));

    expect(rec?.status).toBe("action");
    expect(rec?.severity).toBe("info");
    expect(rec?.suggestedValue).toBe("18000.00");
    expect(rec?.rationale).toContain("4-rung ladder");
    expect(rec?.rationale).toContain("$4,500.00");
  });

  it("names no product, institution, or security (ADR-032 §4)", () => {
    const [rec] = cashDragRule.evaluate(
      household(FLUSH, {
        household: { profile: makeProfile({ benchmarkSavingsApy: "4.5000" }) },
      }),
    );
    const text = `${rec?.title} ${rec?.rationale} ${rec?.heuristic}`;

    // The rule recommends a shape and an amount. The moment it names a bank or a
    // ticker it has crossed from structure into advice.
    expect(text).not.toMatch(
      /vanguard|fidelity|schwab|ally|marcus|treasury|t-bill|VOO|SPY|money market fund/i,
    );
    expect(text).toContain("ladder");
  });

  it("ranks by forgone yield when it can be computed, and by amount when it cannot", () => {
    const withYield = cashDragRule.evaluate(
      household(FLUSH, {
        household: { profile: makeProfile({ benchmarkSavingsApy: "4.5000" }) },
      }),
    )[0];
    const withoutYield = cashDragRule.evaluate(household(FLUSH))[0];

    expect(withYield?.impact).toBe("720.00");
    expect(withYield?.rationale).toContain("$720.00 a year");
    expect(withoutYield?.impact).toBe("18000.00");
  });

  it("tells the user which input is missing when the yield gap is unknown", () => {
    const [noBenchmark] = cashDragRule.evaluate(household(FLUSH));
    expect(noBenchmark?.rationale).toContain("Record the yield you believe you could get");
    expect(
      noBenchmark?.inputsUsed.find((i) => i.label === "Your cash-yield benchmark")?.missing,
    ).toBe(true);

    const [noApy] = cashDragRule.evaluate(
      household(
        [
          { name: "Everyday", subtype: "checking", balance: "5000.00" },
          { name: "Savings", subtype: "savings", balance: "25000.00", apy: null },
        ],
        { household: { profile: makeProfile({ benchmarkSavingsApy: "4.5000" }) } },
      ),
    );
    expect(noApy?.rationale).toContain("Record an APY");
    expect(
      noApy?.inputsUsed.find((i) => i.label === "Current yield on your savings")?.source,
    ).toContain("1 savings account has");
  });

  it("stays quiet about an amount too small to be worth structuring", () => {
    const [rec] = cashDragRule.evaluate(
      household([
        { name: "Everyday", subtype: "checking", balance: "3000.00" },
        { name: "Savings", subtype: "savings", balance: "10500.00" },
      ]),
    );

    // $1,500 above target: four rungs of $375 is not worth anyone's afternoon.
    expect(rec?.status).toBe("ok");
    expect(rec?.impact).toBe("0.00");
    expect(rec?.rationale).toContain("too little to be worth structuring");
  });

  it("says the cash is right-sized when there is no excess at all", () => {
    const [rec] = cashDragRule.evaluate(
      household([
        { name: "Everyday", subtype: "checking", balance: "3000.00" },
        { name: "Savings", subtype: "savings", balance: "6000.00" },
      ]),
    );

    expect(rec?.status).toBe("ok");
    expect(rec?.rationale).toContain("none of it is idle");
  });

  it("declines to judge idle cash with no essential baseline", () => {
    const [rec] = cashDragRule.evaluate(
      household(FLUSH, { essentials: { baseline: null, trailingMedian: null } }),
    );

    expect(rec?.status).toBe("unknown_input");
    expect(rec?.impact).toBeNull();
    expect(rec?.inputsUsed.find((i) => i.missing)?.label).toBe("Essential monthly expenses");
  });

  it("ignores a CD when measuring liquidity", () => {
    const [rec] = cashDragRule.evaluate(
      household([
        { name: "Everyday", subtype: "checking", balance: "3000.00" },
        { name: "Savings", subtype: "savings", balance: "9000.00" },
        { name: "18-mo CD", subtype: "cd", balance: "40000.00" },
      ]),
    );

    // The CD is already the structure this rule recommends; counting it as idle
    // liquid cash would tell the user to ladder money that is already laddered.
    expect(rec?.status).toBe("ok");
  });
});
