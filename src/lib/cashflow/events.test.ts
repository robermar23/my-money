// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  type IncomeSourceInput,
  type ObligationInput,
  type PlannedExpenseInput,
  expandIncomeEvents,
  expandObligationEvents,
  expandPlannedExpenseEvents,
} from "./events.ts";

/**
 * P16-14 — event expansion over the ONE occurrence expander.
 *
 * The interesting behaviour is not "monthly means every month" — that is
 * `occurrenceDatesBetween`'s job and it is tested there. It is the LIFECYCLE:
 * `active`, `start_date` and `end_date` decide which of those dates are real,
 * and getting any of the three wrong puts a bill on the calendar that the
 * household has already stopped paying.
 */

function obligation(over: Partial<ObligationInput> = {}): ObligationInput {
  return {
    id: "ob-1",
    label: "Mortgage",
    expectedAmount: "2150.00",
    direction: "outflow",
    amountMode: "fixed",
    cadence: "monthly",
    anchorDate: "2026-01-01",
    startDate: "2020-01-01",
    endDate: null,
    active: true,
    ...over,
  };
}

function cost(over: Partial<PlannedExpenseInput> = {}): PlannedExpenseInput {
  return {
    id: "pe-1",
    label: "New roof",
    amount: "4000.00",
    dueDate: "2026-02-15",
    status: "planned",
    ...over,
  };
}

function source(over: Partial<IncomeSourceInput> = {}): IncomeSourceInput {
  return {
    id: "inc-1",
    name: "Paycheck",
    cadence: "biweekly",
    anchorDate: "2026-01-02",
    startDate: "2020-01-01",
    endDate: null,
    active: true,
    ...over,
  };
}

describe("expandObligationEvents", () => {
  it("emits one event per occurrence, tagged with its obligation", () => {
    const events = expandObligationEvents([obligation()], "2026-01-01", "2026-03-31");

    expect(events.map((e) => e.date)).toEqual(["2026-01-01", "2026-02-01", "2026-03-01"]);
    expect(events[0]).toMatchObject({
      kind: "obligation",
      obligationId: "ob-1",
      label: "Mortgage",
      amount: "2150.00",
      direction: "outflow",
      amountMode: "fixed",
    });
  });

  it("carries an inflow obligation through as an inflow", () => {
    // A quarterly dividend or a lodger's rent — a receipt no income source
    // models. If direction were assumed, this would be projected as a bill.
    const events = expandObligationEvents(
      [
        obligation({
          id: "ob-rent",
          label: "Lodger rent",
          direction: "inflow",
          expectedAmount: "800.00",
          anchorDate: "2026-01-05",
        }),
      ],
      "2026-01-01",
      "2026-02-28",
    );

    expect(events).toHaveLength(2);
    expect(events.every((e) => e.direction === "inflow")).toBe(true);
  });

  it("stops at end_date mid-horizon", () => {
    const events = expandObligationEvents(
      [obligation({ endDate: "2026-02-15" })],
      "2026-01-01",
      "2026-04-30",
    );

    expect(events.map((e) => e.date)).toEqual(["2026-01-01", "2026-02-01"]);
  });

  it("includes an occurrence falling exactly on end_date", () => {
    // The column is 'last date occurrences may be materialized through'.
    const events = expandObligationEvents(
      [obligation({ endDate: "2026-02-01" })],
      "2026-01-01",
      "2026-04-30",
    );

    expect(events.map((e) => e.date)).toEqual(["2026-01-01", "2026-02-01"]);
  });

  it("does not start before start_date", () => {
    const events = expandObligationEvents(
      [obligation({ startDate: "2026-03-01" })],
      "2026-01-01",
      "2026-04-30",
    );

    expect(events.map((e) => e.date)).toEqual(["2026-03-01", "2026-04-01"]);
  });

  it("omits an inactive obligation entirely", () => {
    expect(
      expandObligationEvents([obligation({ active: false })], "2026-01-01", "2026-12-31"),
    ).toEqual([]);
  });

  it("returns nothing when the obligation's life does not meet the window", () => {
    const events = expandObligationEvents(
      [obligation({ startDate: "2027-01-01" })],
      "2026-01-01",
      "2026-12-31",
    );

    expect(events).toEqual([]);
  });

  it("merges several obligations into one ascending, deterministic sequence", () => {
    const events = expandObligationEvents(
      [
        obligation({
          id: "ob-net",
          label: "Netflix",
          expectedAmount: "22.99",
          anchorDate: "2026-01-15",
        }),
        obligation(),
        obligation({
          id: "ob-ins",
          label: "Auto insurance",
          expectedAmount: "410.00",
          cadence: "quarterly",
          anchorDate: "2026-01-15",
        }),
      ],
      "2026-01-01",
      "2026-02-28",
    );

    expect(events.map((e) => `${e.date} ${e.label}`)).toEqual([
      "2026-01-01 Mortgage",
      "2026-01-15 Auto insurance",
      "2026-01-15 Netflix",
      "2026-02-01 Mortgage",
      "2026-02-15 Netflix",
    ]);
  });

  it("expands the three long cadences obligations added", () => {
    const annual = expandObligationEvents(
      [obligation({ cadence: "annual", anchorDate: "2026-06-15" })],
      "2026-01-01",
      "2028-12-31",
    );

    expect(annual.map((e) => e.date)).toEqual(["2026-06-15", "2027-06-15", "2028-06-15"]);
  });

  it("does not mutate its inputs", () => {
    const input = [obligation()];
    const before = structuredClone(input);

    expandObligationEvents(input, "2026-01-01", "2026-06-30");

    expect(input).toEqual(before);
  });
});

describe("expandIncomeEvents", () => {
  const net = new Map([["inc-1", "2480.00"]]);

  it("prices a paycheck from observed take-home, not from gross", () => {
    const events = expandIncomeEvents([source()], net, "2026-01-01", "2026-02-28");

    expect(events.map((e) => e.date)).toEqual([
      "2026-01-02",
      "2026-01-16",
      "2026-01-30",
      "2026-02-13",
      "2026-02-27",
    ]);
    expect(events[0]).toMatchObject({
      kind: "income",
      incomeSourceId: "inc-1",
      direction: "inflow",
      amount: "2480.00",
      label: "Paycheck",
    });
  });

  it("skips a source with no observed net rather than projecting a zero", () => {
    // A source that has never deposited has no honest per-period figure. A
    // "0.00" paycheck would be indistinguishable on the calendar from a real
    // one that happened to be zero.
    const events = expandIncomeEvents([source({ id: "inc-new" })], net, "2026-01-01", "2026-02-28");

    expect(events).toEqual([]);
  });

  it("honors active, start_date and end_date the same way obligations do", () => {
    expect(
      expandIncomeEvents([source({ active: false })], net, "2026-01-01", "2026-12-31"),
    ).toEqual([]);

    const ended = expandIncomeEvents(
      [source({ endDate: "2026-01-20" })],
      net,
      "2026-01-01",
      "2026-02-28",
    );
    expect(ended.map((e) => e.date)).toEqual(["2026-01-02", "2026-01-16"]);
  });

  it("merges multiple sources into one ascending sequence", () => {
    const twoNets = new Map([
      ["inc-1", "2480.00"],
      ["inc-2", "1100.00"],
    ]);
    const events = expandIncomeEvents(
      [
        source(),
        source({
          id: "inc-2",
          name: "Contract work",
          cadence: "monthly",
          anchorDate: "2026-01-10",
        }),
      ],
      twoNets,
      "2026-01-01",
      "2026-01-31",
    );

    expect(events.map((e) => `${e.date} ${e.label}`)).toEqual([
      "2026-01-02 Paycheck",
      "2026-01-10 Contract work",
      "2026-01-16 Paycheck",
      "2026-01-30 Paycheck",
    ]);
  });

  it("rejects a negative per-period figure instead of projecting an inflow that drains", () => {
    expect(() =>
      expandIncomeEvents([source()], new Map([["inc-1", "-2480.00"]]), "2026-01-01", "2026-01-31"),
    ).toThrow(/negative/i);
  });
});

/**
 * P18-29 — the fourth event kind.
 *
 * There is no cadence here and no lifecycle, so almost nothing in the
 * obligation expander's behaviour carries over. What is left is the one
 * question that matters: **which recorded costs are real charges against a
 * future day?** Getting it wrong in the permissive direction puts a cost the
 * household has already paid back onto the calendar; getting it wrong in the
 * restrictive direction hides a $4,000 charge from the low-water mark, which
 * ADR-038 §3 names as the dangerous one.
 */
describe("expandPlannedExpenseEvents", () => {
  it("emits one outflow per recorded cost inside the window", () => {
    const events = expandPlannedExpenseEvents([cost()], "2026-01-01", "2026-03-01");

    expect(events).toEqual([
      {
        kind: "planned_expense",
        date: "2026-02-15",
        amount: "4000.00",
        direction: "outflow",
        label: "New roof",
        plannedExpenseId: "pe-1",
      },
    ]);
  });

  it("includes a cost falling on either edge of the inclusive window", () => {
    const events = expandPlannedExpenseEvents(
      [cost({ id: "a", dueDate: "2026-01-01" }), cost({ id: "b", dueDate: "2026-03-01" })],
      "2026-01-01",
      "2026-03-01",
    );

    expect(events.map((e) => e.date)).toEqual(["2026-01-01", "2026-03-01"]);
  });

  it("emits nothing for a cost dated past the horizon", () => {
    expect(
      expandPlannedExpenseEvents([cost({ dueDate: "2026-09-01" })], "2026-01-01", "2026-03-01"),
    ).toEqual([]);
  });

  it("emits nothing for a paid cost", () => {
    expect(
      expandPlannedExpenseEvents([cost({ status: "paid" })], "2026-01-01", "2026-03-01"),
    ).toEqual([]);
  });

  it("emits nothing for a cancelled cost", () => {
    expect(
      expandPlannedExpenseEvents([cost({ status: "cancelled" })], "2026-01-01", "2026-03-01"),
    ).toEqual([]);
  });

  it("emits nothing for a past-due cost, because the window starts today", () => {
    // ADR-043 §6 built no matcher, so nothing ever settles a planned expense
    // automatically and an overdue row sits there `planned` indefinitely. It
    // must not be charged to a future day: the money either already left or
    // never will, and the projection cannot tell which. The horizon's own start
    // date is what excludes it — there is no second past-due rule in this file,
    // because a projection always walks forward from today.
    expect(
      expandPlannedExpenseEvents([cost({ dueDate: "2025-12-20" })], "2026-01-01", "2026-03-01"),
    ).toEqual([]);
  });

  it("normalizes an unpadded amount the way the obligation path does", () => {
    const events = expandPlannedExpenseEvents(
      [cost({ amount: "4000" })],
      "2026-01-01",
      "2026-03-01",
    );

    expect(events[0]?.amount).toBe("4000.00");
  });

  it("reads a negative amount as the magnitude it is", () => {
    // The column is a magnitude and the form cannot submit a negative, but a
    // sign that reached here would otherwise become an INFLOW on the walk —
    // a $4,000 cost that pays the household, moving the low-water mark in the
    // direction nobody would think to question.
    const events = expandPlannedExpenseEvents(
      [cost({ amount: "-4000.00" })],
      "2026-01-01",
      "2026-03-01",
    );

    expect(events[0]).toMatchObject({ amount: "4000.00", direction: "outflow" });
  });

  it("orders several costs on the same day deterministically", () => {
    const events = expandPlannedExpenseEvents(
      [
        cost({ id: "z", label: "Wedding", dueDate: "2026-02-15" }),
        cost({ id: "a", label: "Wedding", dueDate: "2026-02-15" }),
        cost({ id: "m", label: "Dental", dueDate: "2026-02-15" }),
      ],
      "2026-01-01",
      "2026-03-01",
    );

    expect(events.map((e) => [e.label, e.plannedExpenseId])).toEqual([
      ["Dental", "m"],
      ["Wedding", "a"],
      ["Wedding", "z"],
    ]);
  });

  it("rejects a due date that is not a real calendar date", () => {
    expect(() =>
      expandPlannedExpenseEvents([cost({ dueDate: "2026-02-30" })], "2026-01-01", "2026-03-01"),
    ).toThrow();
  });

  it("returns nothing on an inverted window rather than everything", () => {
    expect(expandPlannedExpenseEvents([cost()], "2026-03-01", "2026-01-01")).toEqual([]);
  });

  it("does not mutate its inputs", () => {
    const rows = [cost()];
    const snapshot = structuredClone(rows);

    expandPlannedExpenseEvents(rows, "2026-01-01", "2026-03-01");

    expect(rows).toEqual(snapshot);
  });
});
