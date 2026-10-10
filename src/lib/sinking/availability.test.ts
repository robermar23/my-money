// @vitest-environment node
import { makeCash, makeMember, makeProfile } from "@/lib/advice/advice-input.fixture.ts";
import { Money } from "@/lib/money/money.ts";
import { describe, expect, it } from "vitest";
import { sinkingAvailability } from "./availability.ts";
import { sinkingRequirement } from "./requirement.ts";
import { ROUND12_HORIZON, ROUND12_TODAY, round12Costs, round12Input } from "./round12.fixture.ts";

/**
 * P18-16 — what the household actually has against the requirement (P18-15,
 * ADR-046 §1/§2). Written before the implementation.
 *
 * The arithmetic is two subtractions. Everything that can go wrong here is a
 * judgement call about **which balance** and **what to say when a figure cannot
 * be computed**, so that is what these tests are about:
 *
 *   - **The reserve tier only** (ADR-046 §2), and the tier **above** the
 *     emergency-fund target. One pot cannot do two jobs and be called funded
 *     twice. The last group adds operating cash and a CD and asserts the answer
 *     does not move — the failure mode is a household told it has $40,000
 *     available because its checking account was counted.
 *   - **`null` is not `"0.00"`.** With no essential baseline there is no target,
 *     and with no target there is no available figure. `"0.00"` would render as
 *     *"you have nothing spare"*, which is a confident claim about a household
 *     we know nothing about; `null` renders as the named degradation with a link
 *     to fix it (the rule [advice/statistics.ts](../advice/statistics.ts)
 *     carries the whole advice phase on).
 *   - **`gap` and `surplus` are mutually exclusive and never negative**, so no
 *     consumer has to read a sign to know which way round it is.
 */

const requirementOf = (costs = round12Costs()) =>
  sinkingRequirement(costs, ROUND12_TODAY, ROUND12_HORIZON);

describe("sinkingAvailability — Round 12's own sentence", () => {
  const availability = sinkingAvailability(round12Input(), requirementOf());

  it("reports $600 of reserve above the emergency-fund target", () => {
    // PLAN18's deliverable, verbatim: "Your reserve above your emergency-fund
    // target is $600." $9,600 of savings, $3,000/month of essentials, the
    // default 3-month target.
    expect(availability.reserveTotal).toBe("9600.00");
    expect(availability.emergencyTarget).toBe("9000.00");
    expect(availability.available).toBe("600.00");
  });

  it("states the shortfall against the requirement as a gap", () => {
    // $2,180 required, $600 available.
    expect(availability.gap).toBe("1580.00");
    expect(availability.surplus).toBe("0.00");
  });
});

describe("sinkingAvailability — the emergency fund comes first", () => {
  it("clamps available at zero when the reserve is below target", () => {
    // Six months for a household with a dependent: an $18,000 target against a
    // $9,600 reserve. There is no negative availability — the honest statement
    // is "nothing is spare", and the emergency-fund rule is the one that reports
    // the reserve shortfall (ADR-046 §3 keeps this rule from re-reporting it).
    const input = round12Input({
      household: { members: [makeMember({ id: "kid", isDependent: true })] },
    });
    const availability = sinkingAvailability(input, requirementOf());

    expect(availability.emergencyTarget).toBe("18000.00");
    expect(availability.available).toBe("0.00");
    expect(availability.gap).toBe("2180.00");
    expect(availability.surplus).toBe("0.00");
  });

  it("sizes the target with the shipped reserveMonthsFor, override included", () => {
    // ADR-046 §1: the fourth caller of the one exported helper, not a second
    // implementation. A household that set a 4-month target gets $12,000 here
    // and $12,000 on the emergency-fund card, because it is the same function.
    const input = round12Input({
      household: { profile: makeProfile({ reserveMonthsOverride: 4 }) },
    });
    expect(sinkingAvailability(input, requirementOf()).emergencyTarget).toBe("12000.00");
  });
});

describe("sinkingAvailability — a surplus", () => {
  it("reports neither when the requirement is met exactly", () => {
    const small = requirementOf([
      {
        source: "planned_expense",
        sourceId: "pe-tires",
        label: "Tires",
        amount: "1200.00",
        currency: "USD",
        dueDate: "2027-04-04",
        fundingStart: "2026-04-04",
        status: "planned",
        categoryId: null,
      },
    ]);
    // $1,200 over 12 months, 6 elapsed → exactly the $600 available. Both
    // figures are zero, and the page says "you are on track" from the status
    // rather than by reading a sign off one of them.
    expect(small.requiredToday).toBe("600.00");

    const availability = sinkingAvailability(round12Input(), small);
    expect(availability.gap).toBe("0.00");
    expect(availability.surplus).toBe("0.00");
  });

  it("reports the excess when there is one", () => {
    const input = round12Input({
      cash: makeCash(
        [{ name: "Ally Savings", subtype: "savings", balance: "12000.00" }],
        "3000.00",
      ),
    });
    const availability = sinkingAvailability(input, requirementOf());

    expect(availability.available).toBe("3000.00");
    expect(availability.surplus).toBe("820.00");
    expect(availability.gap).toBe("0.00");
  });

  it("never reports a gap and a surplus at the same time", () => {
    // Exactly one of the two is non-zero, whichever side of the requirement the
    // household is on. The page leads with the one that is.
    for (const balance of ["0.00", "9000.00", "9600.00", "20000.00"]) {
      const input = round12Input({
        cash: makeCash([{ name: "Ally Savings", subtype: "savings", balance }], "3000.00"),
      });
      const { gap, surplus } = sinkingAvailability(input, requirementOf());
      if (gap === null || surplus === null) throw new Error("both are computable here");
      // Compared through `Money` rather than `Number`, because a test that
      // reaches for `Number()` on a money string is rehearsing the bug
      // CLAUDE.md §Money forbids.
      const gapMoney = Money.fromString(gap, "USD");
      const surplusMoney = Money.fromString(surplus, "USD");
      expect(gapMoney.isNegative(), balance).toBe(false);
      expect(surplusMoney.isNegative(), balance).toBe(false);
      expect(gapMoney.isZero() || surplusMoney.isZero(), balance).toBe(true);
    }
  });
});

describe("sinkingAvailability — no essential baseline (ADR-046 §4)", () => {
  const availability = sinkingAvailability(
    round12Input({ essentials: { baseline: null, trailingMedian: null } }),
    requirementOf(),
  );

  it("returns null for every figure that depends on the target", () => {
    expect(availability.emergencyTarget).toBeNull();
    expect(availability.available).toBeNull();
    expect(availability.gap).toBeNull();
    expect(availability.surplus).toBeNull();
  });

  it("never substitutes zero for unknown", () => {
    // The one assertion that would survive the laziest possible implementation
    // of this module, and the one that matters most: "0.00" here would tell a
    // household with an unclassified budget that it has nothing spare and a
    // $2,180 gap, which is a number we have no basis for.
    expect(availability.available).not.toBe("0.00");
    expect(availability.gap).not.toBe("0.00");
  });

  it("still reports the reserve balance, which IS known", () => {
    // Declining to answer the question we cannot answer is not the same as
    // declining to show the balance sitting in the account.
    expect(availability.reserveTotal).toBe("9600.00");
  });
});

describe("sinkingAvailability — the reserve tier only (ADR-046 §2)", () => {
  it("ignores operating cash and medium-term CDs", () => {
    // Operating cash is committed to this month's bills and a CD costs a penalty
    // to break. Counting either reports a fund the household cannot spend when
    // the premium lands, which is the one circumstance the figure exists for.
    const input = round12Input({
      cash: makeCash(
        [
          { name: "Checking", subtype: "checking", balance: "40000.00" },
          { name: "Ally Savings", subtype: "savings", balance: "9600.00" },
          { name: "18-month CD", subtype: "cd", balance: "25000.00" },
          { name: "Brokerage sweep", subtype: null, balance: "5000.00" },
        ],
        "3000.00",
      ),
    });
    const availability = sinkingAvailability(input, requirementOf());

    expect(availability.reserveTotal).toBe("9600.00");
    expect(availability.available).toBe("600.00");
  });

  it("counts money market alongside savings", () => {
    const input = round12Input({
      cash: makeCash(
        [
          { name: "Ally Savings", subtype: "savings", balance: "9600.00" },
          { name: "Vanguard MM", subtype: "money_market", balance: "400.00" },
        ],
        "3000.00",
      ),
    });
    expect(sinkingAvailability(input, requirementOf()).available).toBe("1000.00");
  });
});

describe("sinkingAvailability — purity", () => {
  it("does not mutate the snapshot", () => {
    const input = round12Input();
    const before = JSON.stringify(input);
    sinkingAvailability(input, requirementOf());
    expect(JSON.stringify(input)).toBe(before);
  });
});
