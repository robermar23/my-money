// @vitest-environment node
import { Money } from "@/lib/money/money.ts";
import { describe, expect, it } from "vitest";
import { sinkingRequirement } from "./requirement.ts";
import { ROUND12_HORIZON, ROUND12_TODAY, round12Costs } from "./round12.fixture.ts";
import type { KnownFutureCost } from "./types.ts";

/**
 * P18-16 — the household requirement (P18-14, ADR-045 §5). Written before the
 * implementation.
 *
 * Two things are being pinned here, and only one of them is arithmetic:
 *
 *   1. **The total is the sum of the rows shown beneath it.** `/plan/sinking`
 *      prints a headline figure over an itemized table, and a reader who adds
 *      the column up must get the headline — PLAN17's "a waterfall that does not
 *      add up is not a waterfall", applied to a table. The last test in the
 *      first group re-adds the column with `Money.sum` and compares, so a future
 *      "optimization" that totals the amounts a second way fails here.
 *   2. **Nothing is invented when there is nothing to total.** An empty stream
 *      is `"0.00"` and `costCount === 0` — which is a *true* statement about the
 *      arithmetic and a **misleading** one about the household, which is exactly
 *      why [status.ts](./status.ts) exists and why ADR-046 §5 makes the rule
 *      emit `unknown_input` rather than `ok` for this case. The requirement's
 *      job is to be honest about the sum; the status's job is to be honest about
 *      the sum's meaning.
 */

const cost = (overrides: Partial<KnownFutureCost> = {}): KnownFutureCost => ({
  source: "planned_expense",
  sourceId: "pe-1",
  label: "Roof repair",
  amount: "1200.00",
  currency: "USD",
  dueDate: "2027-04-04",
  fundingStart: "2026-04-04",
  status: "planned",
  categoryId: null,
  ...overrides,
});

describe("sinkingRequirement — Round 12's own sentence", () => {
  const requirement = sinkingRequirement(round12Costs(), ROUND12_TODAY, ROUND12_HORIZON);

  it("totals $2,180 against four known costs", () => {
    // PLAN18's deliverable, verbatim: "You should be holding $2,180 against the
    // four known costs in the next 12 months." Both literals are typed out by
    // hand rather than imported from the fixture.
    expect(requirement.requiredToday).toBe("2180.00");
    expect(requirement.costCount).toBe(4);
  });

  it("spans both sources, so the annual premium is in the total", () => {
    // ADR-045's whole argument. A requirement over `planned_expenses` alone
    // would omit the car insurance the round opens with and report $1,200.
    expect(requirement.costs.map((accrued) => accrued.cost.source)).toEqual([
      "obligation",
      "obligation",
      "planned_expense",
      "planned_expense",
    ]);
    expect(requirement.costs.map((accrued) => accrued.cost.label)).toContain("Car insurance");
  });

  it("totals the monthly set-aside too", () => {
    expect(requirement.perMonth).toBe("580.00");
  });

  it("itemizes every cost with its own accrual resolved", () => {
    expect(
      requirement.costs.map((accrued) => [
        accrued.cost.label,
        accrued.totalMonths,
        accrued.elapsedMonths,
        accrued.perMonth,
        accrued.requiredToday,
      ]),
    ).toEqual([
      ["Water bill", 3, 1, "80.00", "80.00"],
      ["Car insurance", 12, 9, "100.00", "900.00"],
      ["Dental work", 6, 2, "300.00", "600.00"],
      ["Roof repair", 18, 6, "100.00", "600.00"],
    ]);
  });

  it("adds up: the itemized column re-summed IS the header", () => {
    // The property the page's credibility rests on, asserted by doing what a
    // suspicious reader does — adding the column up again.
    const resummed = Money.sum(
      requirement.costs.map((accrued) => Money.fromString(accrued.requiredToday, "USD")),
      "USD",
    );
    expect(resummed.toString()).toBe(requirement.requiredToday);

    const resummedPerMonth = Money.sum(
      requirement.costs.map((accrued) => Money.fromString(accrued.perMonth, "USD")),
      "USD",
    );
    expect(resummedPerMonth.toString()).toBe(requirement.perMonth);
  });

  it("echoes the horizon it was computed over", () => {
    // Stated rather than re-derived from `today`: the page's copy says "the next
    // 12 months" and must name the same edges the stream was filtered on.
    expect(requirement.horizonFrom).toBe("2026-10-04");
    expect(requirement.horizonTo).toBe("2027-10-04");
  });

  it("echoes the horizon even when its start is NOT today", () => {
    // The two are normally the same date, which is exactly why this case is
    // written out: with `from === today` every assertion above passes equally
    // well against a `horizonFrom: today` that re-derives the edge instead of
    // reporting it, and the day a caller evaluates a window that does not begin
    // today the page would name a window the stream was never filtered on.
    const shifted = sinkingRequirement(round12Costs(), ROUND12_TODAY, {
      ...ROUND12_HORIZON,
      from: "2026-10-01",
    });
    expect(shifted.horizonFrom).toBe("2026-10-01");
    expect(shifted.requiredToday).toBe("2180.00");
  });
});

describe("sinkingRequirement — an empty stream", () => {
  const requirement = sinkingRequirement([], ROUND12_TODAY, ROUND12_HORIZON);

  it("is zero and says so, without inventing a currency", () => {
    expect(requirement.requiredToday).toBe("0.00");
    expect(requirement.perMonth).toBe("0.00");
    expect(requirement.costCount).toBe(0);
    expect(requirement.pastDueCount).toBe(0);
    expect(requirement.costs).toEqual([]);
  });

  it("still echoes its horizon, so the page can say what it looked at", () => {
    // A household that has recorded nothing still gets "no costs due in the next
    // 12 months" rather than a page with no dates on it.
    expect(requirement.horizonFrom).toBe("2026-10-04");
    expect(requirement.horizonTo).toBe("2027-10-04");
  });
});

describe("sinkingRequirement — past-due costs", () => {
  it("counts them, and requires their full amount", () => {
    // ADR-044 §5 / ADR-043 §6: a still-`planned` cost whose date has passed is
    // overdue, not out of horizon. `pastDueCount` drives the copy that tells the
    // household to mark it paid, and would be permanently zero if the stream or
    // this function quietly dropped the row.
    const requirement = sinkingRequirement(
      [
        cost({ sourceId: "pe-overdue", dueDate: "2026-09-01", amount: "400.00" }),
        cost({ sourceId: "pe-future", dueDate: "2027-04-04" }),
      ],
      ROUND12_TODAY,
      ROUND12_HORIZON,
    );

    expect(requirement.pastDueCount).toBe(1);
    expect(requirement.costs[0]?.requiredToday).toBe("400.00");
    expect(requirement.costCount).toBe(2);
  });

  it("does not count a cost due today as past due", () => {
    // Due today means due today — the requirement is the full amount (the
    // accrual's own clamp) but nobody is late yet.
    const requirement = sinkingRequirement(
      [cost({ dueDate: ROUND12_TODAY, fundingStart: "2026-04-04" })],
      ROUND12_TODAY,
      ROUND12_HORIZON,
    );
    expect(requirement.pastDueCount).toBe(0);
    expect(requirement.requiredToday).toBe("1200.00");
  });
});

describe("sinkingRequirement — settled costs", () => {
  it("excludes a paid or cancelled cost from the totals and from the count", () => {
    // ADR-044 §7. `buildCostStream` admits only `planned` rows, so this is
    // belt-and-braces — but a count that promised "3 known costs" behind a total
    // built from one would be the itemization claim broken at the header, which
    // is the one thing this module is for.
    const requirement = sinkingRequirement(
      [
        cost({ sourceId: "pe-paid", status: "paid" }),
        cost({ sourceId: "pe-cancelled", status: "cancelled" }),
        cost({ sourceId: "pe-live", amount: "600.00", fundingStart: "2026-10-04" }),
      ],
      ROUND12_TODAY,
      ROUND12_HORIZON,
    );

    expect(requirement.requiredToday).toBe("0.00");
    expect(requirement.costCount).toBe(1);
    // Still itemized, with their own history — deactivate, never delete.
    expect(requirement.costs).toHaveLength(3);
    expect(requirement.costs.map((accrued) => accrued.requiredToday)).toEqual([
      "0.00",
      "0.00",
      "0.00",
    ]);
  });
});

describe("sinkingRequirement — purity and currency", () => {
  it("does not mutate or reorder its input", () => {
    const costs = round12Costs();
    const before = JSON.stringify(costs);
    sinkingRequirement(costs, ROUND12_TODAY, ROUND12_HORIZON);
    expect(JSON.stringify(costs)).toBe(before);
  });

  it("preserves the stream's order rather than sorting again", () => {
    // `buildCostStream` already sorts deterministically; a second sort here
    // would be a second opinion about row order, and the page would show one of
    // them while the rule explained the other.
    const costs = [
      cost({ sourceId: "b", label: "Zebra", dueDate: "2027-05-04" }),
      cost({ sourceId: "a", label: "Alpha", dueDate: "2027-06-04" }),
    ];
    expect(
      sinkingRequirement(costs, ROUND12_TODAY, ROUND12_HORIZON).costs.map((a) => a.cost.label),
    ).toEqual(["Zebra", "Alpha"]);
  });

  it("refuses to add two currencies together", () => {
    // CLAUDE.md §Money: cross-currency arithmetic goes through `fx_rates` at the
    // relevant date, and this phase has no rate lookup. Summing the magnitudes
    // would report €1,000 + $1,000 as $2,000 — a wrong number with no symptom.
    // Failing loudly is the honest option, and `Money.sum` is what enforces it.
    expect(() =>
      sinkingRequirement(
        [cost(), cost({ sourceId: "pe-eur", currency: "EUR" })],
        ROUND12_TODAY,
        ROUND12_HORIZON,
      ),
    ).toThrow(/currency/i);
  });

  it("states the totals in the horizon's currency", () => {
    const horizon = { ...ROUND12_HORIZON, currency: "EUR" };
    const requirement = sinkingRequirement(
      [cost({ currency: "EUR", amount: "1200.00", fundingStart: "2026-10-04" })],
      ROUND12_TODAY,
      horizon,
    );
    expect(requirement.requiredToday).toBe("0.00");
    expect(requirement.perMonth).toBe("200.00");
  });
});
