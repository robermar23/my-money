import { makeCash } from "@/lib/advice/advice-input.fixture.ts";
import { sinkingAvailability } from "@/lib/sinking/availability.ts";
import { sinkingHorizon, sinkingRequirement } from "@/lib/sinking/requirement.ts";
import { ROUND12_TODAY, round12Costs, round12Input } from "@/lib/sinking/round12.fixture.ts";
import { describe, expect, it } from "vitest";
import { costRows, sinkingHeadline, sinkingVerdict, sourceLabel } from "./view-models.ts";

/**
 * The sentence Phase 18 was commissioned to produce (P18-23).
 *
 * PLAN18 states the deliverable as one sentence, and this is the file that
 * asserts the app actually says it — with the two figures spelled out as string
 * literals typed by hand, not imported from the fixture that produced them.
 *
 * Everything else here guards the modelling decision `/plan/sinking` is most
 * likely to lose over time: **no per-cost funding state.** A row says what is
 * true of the cost and nothing about where money is.
 */

function round12() {
  const input = round12Input({ knownFutureCosts: round12Costs() });
  const requirement = sinkingRequirement(
    input.knownFutureCosts,
    input.today,
    sinkingHorizon(input.today, input.currency),
  );
  return { input, requirement, availability: sinkingAvailability(input, requirement) };
}

describe("sinkingHeadline — the deliverable sentence", () => {
  it("says Round 12's sentence, both figures, in that order", () => {
    const { requirement, availability } = round12();

    expect(sinkingHeadline(requirement, availability, "USD")).toBe(
      "You should be holding $2,180.00 against the 4 known costs in the next 12 months. Your reserve above your emergency-fund target is $600.00.",
    );
  });

  it("names the horizon, so a reader knows which window was searched", () => {
    const { requirement, availability } = round12();

    expect(sinkingHeadline(requirement, availability, "USD")).toContain("next 12 months");
  });

  it("says cost, not costs, for a single recorded cost", () => {
    const { input } = round12();
    const one = [round12Costs()[0]].filter((cost) => cost !== undefined);
    const requirement = sinkingRequirement(
      one,
      input.today,
      sinkingHorizon(input.today, input.currency),
    );

    expect(sinkingHeadline(requirement, sinkingAvailability(input, requirement), "USD")).toContain(
      "the 1 known cost in",
    );
  });
});

describe("sinkingVerdict", () => {
  it("leads with Round 12's $1,580 gap and what closes it", () => {
    const { requirement, availability } = round12();

    const verdict = sinkingVerdict(requirement, availability, "USD");

    expect(verdict.position).toBe("gap");
    expect(verdict.amountDisplay).toBe("$1,580.00");
    // The per-month figure is the actionable half — a gap with no rate beside it
    // is a number to feel bad about.
    expect(verdict.sentence).toContain("a month");
  });

  it("reports a surplus without calling it spare money", () => {
    const { input } = round12();
    const rich = round12Input({
      knownFutureCosts: round12Costs(),
      // Through the shipped classifier, not a hand-built rollup: ADR-046 §2's
      // "reserve tier only" has to be decided by the one classifier.
      cash: makeCash(
        [{ name: "Ally Savings", subtype: "savings", balance: "20000.00" }],
        "3000.00",
      ),
    });
    const requirement = sinkingRequirement(
      rich.knownFutureCosts,
      rich.today,
      sinkingHorizon(rich.today, input.currency),
    );

    const verdict = sinkingVerdict(requirement, sinkingAvailability(rich, requirement), "USD");

    expect(verdict.position).toBe("surplus");
    expect(verdict.sentence).toContain("still coming");
    expect(verdict.sentence).not.toMatch(/spare money|spend it|free to spend/i);
  });

  it("reads which field is non-zero rather than a sign", () => {
    const { requirement } = round12();

    const level = sinkingVerdict(
      requirement,
      {
        reserveTotal: "12000.00",
        emergencyTarget: "9000.00",
        available: "2180.00",
        gap: "0.00",
        surplus: "0.00",
      },
      "USD",
    );

    expect(level.position).toBe("level");
    expect(level.amountDisplay).toBe("$0.00");
  });
});

describe("costRows", () => {
  it("formats every figure on the server and keeps the stream's order", () => {
    const { requirement } = round12();

    const rows = costRows(requirement, "USD");

    expect(rows).toHaveLength(4);
    expect(rows.map((row) => row.label)).toEqual(requirement.costs.map((cost) => cost.cost.label));
    for (const row of rows) {
      expect(row.amountDisplay).toMatch(/^\$[\d,]+\.\d\d$/);
      expect(row.requiredTodayDisplay).toMatch(/^\$[\d,]+\.\d\d$/);
      expect(row.perMonthDisplay).toMatch(/^\$[\d,]+\.\d\d$/);
    }
  });

  it("carries no funding state on a row — the boundary P18-00 drew", () => {
    const { requirement } = round12();

    const [row] = costRows(requirement, "USD");

    // The gap and the surplus are household-level aggregates over one undivided
    // reserve. There is no fact about an individual cost's funding to render,
    // and a field here would be the envelope rebuilt in copy.
    for (const key of Object.keys(row ?? {})) {
      expect(key).not.toMatch(/funded|funding|progress|percent|allocated|reserved/i);
    }
  });

  it("adds up to the header it sits under", () => {
    const { requirement } = round12();

    const total = costRows(requirement, "USD").reduce(
      (sum, row) => sum + Number(row.requiredTodayDisplay.replace(/[$,]/g, "")),
      0,
    );

    // Display-string arithmetic, in a test, purely to prove the table a reader
    // can add up actually adds up — never in product code (CLAUDE.md §Money).
    expect(total.toFixed(2)).toBe("2180.00");
  });

  it("marks only planned expenses editable, since only they have the actions", () => {
    const { requirement } = round12();

    const rows = costRows(requirement, "USD");

    for (const row of rows) {
      expect(row.editable).toBe(row.sourceLabel === sourceLabel("planned_expense"));
    }
  });

  it("counts months LEFT, not the whole term", () => {
    const { requirement } = round12();

    const rows = costRows(requirement, "USD");

    // The subtraction is the column's whole meaning: a cost three months into a
    // seven-month term has four left, and showing seven would tell a household
    // it has longer than it does on every row it is already part-way through.
    for (const [index, row] of rows.entries()) {
      const accrued = requirement.costs[index];
      expect(row.monthsRemaining).toBe((accrued?.totalMonths ?? 0) - (accrued?.elapsedMonths ?? 0));
      expect(row.monthsRemaining).toBeGreaterThanOrEqual(0);
    }
    // At least one Round 12 cost is genuinely part-way through, so the two
    // figures differ and the assertion above is not vacuous.
    expect(rows.some((row, i) => row.monthsRemaining !== requirement.costs[i]?.totalMonths)).toBe(
      true,
    );
  });

  it("names where a row came from, so an unfamiliar one is explainable", () => {
    expect(sourceLabel("planned_expense")).toBe("Recorded here");
    expect(sourceLabel("obligation")).toContain("bill calendar");
  });

  it("renders a due date in UTC, not the server's zone", () => {
    const { requirement } = round12();
    const first = requirement.costs[0];
    const rows = costRows(requirement, "USD");

    // A `date` column is a calendar date. The day in the string must be the day
    // in the column, west of Greenwich included.
    expect(rows[0]?.dueDateDisplay).toContain(String(Number(first?.cost.dueDate.slice(8, 10))));
    expect(rows[0]?.dueDateDisplay).toContain(first?.cost.dueDate.slice(0, 4) ?? "");
  });

  it("is empty, not throwing, on an empty requirement", () => {
    const input = round12Input({ knownFutureCosts: [] });
    const requirement = sinkingRequirement(
      [],
      ROUND12_TODAY,
      sinkingHorizon(input.today, input.currency),
    );

    expect(costRows(requirement, "USD")).toEqual([]);
  });
});
