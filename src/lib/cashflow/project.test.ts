// @vitest-environment node
import { Money } from "@/lib/money/money.ts";
import { describe, expect, it } from "vitest";
import { expandObligationEvents } from "./events.ts";
import { DISCRETIONARY_LABEL, type ProjectionInput, projectDailyBalance } from "./project.ts";
import type { ResidualRate } from "./residual.ts";
import type { ObligationEvent, PlannedExpenseEvent } from "./types.ts";

/**
 * P16-17 — the daily balance walk (ADR-038).
 *
 * This is the longest sequential money-arithmetic chain in the codebase. A
 * float here would not merely round — it would drift MONOTONICALLY across a
 * 365-day horizon into a number the household makes a spending decision on, and
 * it would look plausible the whole way down. The penny-exactness case at the
 * bottom is the one that would catch it.
 */

const CURRENCY = "USD";

const NO_RESIDUAL: ResidualRate = { dailyRate: "0.00", coverage: null, clampedAtZero: false };

function rate(dailyRate: string, coverage: string | null = "0.6000"): ResidualRate {
  return { dailyRate, coverage, clampedAtZero: false };
}

function input(over: Partial<ProjectionInput> = {}): ProjectionInput {
  return {
    from: "2026-03-01",
    to: "2026-03-31",
    openingBalance: "5000.00",
    events: [],
    residual: NO_RESIDUAL,
    cashFloor: "0.00",
    status: "ok",
    inputsUsed: [],
    ...over,
  };
}

function bill(date: string, amount: string, label = "Mortgage"): ObligationEvent {
  return {
    kind: "obligation",
    date,
    amount,
    direction: "outflow",
    label,
    obligationId: `ob-${label}`,
    amountMode: "fixed",
  };
}

function cost(date: string, amount: string, label = "New roof"): PlannedExpenseEvent {
  return {
    kind: "planned_expense",
    date,
    amount,
    direction: "outflow",
    label,
    plannedExpenseId: `pe-${label}`,
  };
}

describe("projectDailyBalance", () => {
  it("charges a recorded one-off cost on its own day (P18-28)", () => {
    // The fourth event kind reaching the walk, which is the whole reason the
    // union was changed: a $4,000 cost inside the horizon has to be able to
    // move the balance, and before P18-28 the input type could not hold one.
    const result = projectDailyBalance(
      input({ events: [cost("2026-03-10", "4000.00")], openingBalance: "5000.00" }),
    );

    const day = result.points.find((point) => point.date === "2026-03-10");
    expect(day?.outflow).toBe("4000.00");
    expect(day?.closing).toBe("1000.00");
    // And it is the LOW point of an otherwise flat horizon, with its own date.
    expect(result.lowWaterMark).toEqual({ date: "2026-03-10", balance: "1000.00" });
  });

  it("adds a cost and a bill landing on the same day rather than choosing one", () => {
    // ADR-045 §4 warns about a possible duplicate at ENTRY and never merges,
    // because only the household knows whether the roof and the roof-shaped
    // bill are the same roof. The walk must therefore charge both.
    const result = projectDailyBalance(
      input({
        events: [bill("2026-03-10", "2150.00"), cost("2026-03-10", "4000.00")],
        openingBalance: "10000.00",
      }),
    );

    const day = result.points.find((point) => point.date === "2026-03-10");
    expect(day?.outflow).toBe("6150.00");
    expect(day?.events).toHaveLength(2);
  });

  it("walks a flat horizon with no events and no rate", () => {
    const result = projectDailyBalance(input());

    expect(result.points).toHaveLength(31);
    expect(result.horizonDays).toBe(31);
    expect(result.points[0]).toEqual({
      date: "2026-03-01",
      opening: "5000.00",
      inflow: "0.00",
      outflow: "0.00",
      closing: "5000.00",
      events: [],
    });
    expect(result.points.at(-1)?.closing).toBe("5000.00");
  });

  it("emits one gapless point per day, each opening on the previous closing", () => {
    const result = projectDailyBalance(
      input({ residual: rate("10.00"), events: [bill("2026-03-10", "500.00")] }),
    );

    expect(result.points.map((p) => p.date)).toEqual(
      Array.from({ length: 31 }, (_, i) => `2026-03-${String(i + 1).padStart(2, "0")}`),
    );
    for (let i = 1; i < result.points.length; i += 1) {
      expect(result.points[i]?.opening).toBe(result.points[i - 1]?.closing);
    }
  });

  it("spreads the residual rate as a visible event, not a hidden subtraction", () => {
    // A day's events[] must explain its own outflow in full. A user who adds up
    // the day and gets a different number has found a bug, and should be able to.
    const result = projectDailyBalance(input({ residual: rate("42.50") }));
    const day = result.points[0];

    expect(day?.outflow).toBe("42.50");
    expect(day?.events).toEqual([
      {
        kind: "discretionary",
        date: "2026-03-01",
        amount: "42.50",
        direction: "outflow",
        label: DISCRETIONARY_LABEL,
      },
    ]);
  });

  it("omits the discretionary event entirely when the rate is zero", () => {
    // A "$0.00 everyday spending" row on every day of the calendar is noise
    // that makes the real events harder to see.
    const result = projectDailyBalance(input());

    expect(result.points.every((p) => p.events.length === 0)).toBe(true);
  });

  it("carries a single large obligation across zero and records the crossing", () => {
    const result = projectDailyBalance(
      input({ openingBalance: "1200.00", events: [bill("2026-03-10", "2150.00")] }),
    );

    expect(result.points[8]?.closing).toBe("1200.00");
    expect(result.points[9]?.closing).toBe("-950.00");
    expect(result.lowWaterMark).toEqual({ date: "2026-03-10", balance: "-950.00" });
    expect(result.safeToSpend).toMatchObject({
      amount: "0.00",
      clampedAtZero: true,
      shortfall: "950.00",
      bindingDate: "2026-03-10",
    });
  });

  it("takes the EARLIEST date when the low balance repeats", () => {
    // The family needs to know when it FIRST gets tight, not the last day it
    // stays tight. A `<=` in the running-minimum comparison would report the
    // last date and read as a different, later problem.
    const result = projectDailyBalance(
      input({
        openingBalance: "1000.00",
        events: [bill("2026-03-05", "600.00"), bill("2026-03-20", "600.00", "Rent")],
      }),
    );

    // Flat at 400 from the 5th, then 400 again... the minimum is -200 from the
    // 20th onward; the first date it is reached is the 20th.
    expect(result.lowWaterMark).toEqual({ date: "2026-03-20", balance: "-200.00" });

    // And with a genuinely repeated minimum and no further movement, the first
    // day of the plateau wins.
    const flat = projectDailyBalance(input({ openingBalance: "750.00" }));
    expect(flat.lowWaterMark).toEqual({ date: "2026-03-01", balance: "750.00" });
  });

  it("does not let income arriving the day AFTER the low point rescue it", () => {
    // The classic near-miss: rent clears on the 13th, payday is the 14th. The
    // household is briefly overdrawn and the projection must say so, even
    // though the month ends comfortably.
    const result = projectDailyBalance(
      input({
        openingBalance: "900.00",
        events: [
          bill("2026-03-13", "1400.00", "Rent"),
          {
            kind: "income",
            date: "2026-03-14",
            amount: "2480.00",
            direction: "inflow",
            label: "Paycheck",
            incomeSourceId: "inc-1",
          },
        ],
      }),
    );

    expect(result.lowWaterMark).toEqual({ date: "2026-03-13", balance: "-500.00" });
    expect(result.points.at(-1)?.closing).toBe("1980.00");
    expect(result.safeToSpend.clampedAtZero).toBe(true);
  });

  it("nets an inflow and an outflow landing on the same day", () => {
    const result = projectDailyBalance(
      input({
        openingBalance: "1000.00",
        events: [
          bill("2026-03-05", "300.00"),
          {
            kind: "income",
            date: "2026-03-05",
            amount: "200.00",
            direction: "inflow",
            label: "Paycheck",
            incomeSourceId: "inc-1",
          },
        ],
      }),
    );
    const day = result.points[4];

    expect(day).toMatchObject({ inflow: "200.00", outflow: "300.00", closing: "900.00" });
    expect(day?.events).toHaveLength(2);
  });

  it("handles the run-rate-only case: a rate and no obligations at all", () => {
    const result = projectDailyBalance(
      input({ openingBalance: "3100.00", residual: rate("100.00"), status: "run_rate_only" }),
    );

    expect(result.status).toBe("run_rate_only");
    expect(result.points.at(-1)?.closing).toBe("0.00");
    expect(result.lowWaterMark).toEqual({ date: "2026-03-31", balance: "0.00" });
  });

  it("handles a one-day horizon", () => {
    const result = projectDailyBalance(
      input({
        from: "2026-03-01",
        to: "2026-03-01",
        residual: rate("25.00"),
        events: [bill("2026-03-01", "100.00")],
      }),
    );

    expect(result.horizonDays).toBe(1);
    expect(result.points).toHaveLength(1);
    expect(result.points[0]).toMatchObject({ outflow: "125.00", closing: "4875.00" });
  });

  it("reports the residual's coverage rather than a second, drifting copy", () => {
    const result = projectDailyBalance(input({ residual: rate("10.00", "0.7350") }));

    expect(result.coverage).toBe("0.7350");
  });

  it("echoes the floor, status and audit trail it was handed", () => {
    const inputsUsed = [
      {
        label: "Operating balance",
        value: "5000.00",
        kind: "money" as const,
        source: "Latest snapshot",
      },
    ];
    const result = projectDailyBalance(input({ cashFloor: "750.00", inputsUsed }));

    expect(result.cashFloor).toBe("750.00");
    expect(result.status).toBe("ok");
    expect(result.inputsUsed).toEqual(inputsUsed);
    expect(result.safeToSpend.floor).toBe("750.00");
  });

  it("ignores an event outside the horizon rather than silently applying it", () => {
    const result = projectDailyBalance(
      input({ events: [bill("2026-02-28", "500.00"), bill("2026-04-01", "500.00")] }),
    );

    expect(result.points.every((p) => p.outflow === "0.00")).toBe(true);
    expect(result.points.at(-1)?.closing).toBe("5000.00");
  });

  it("is penny-exact across a 365-day horizon where a float would drift", () => {
    // 0.07 a day is unrepresentable in binary. Summed 365 times with IEEE 754
    // doubles the error is visible in cents; through Decimal it is exactly zero.
    const result = projectDailyBalance(
      input({
        from: "2026-01-01",
        to: "2026-12-31",
        openingBalance: "10000.00",
        residual: rate("0.07"),
      }),
    );

    expect(result.horizonDays).toBe(365);
    expect(result.points.at(-1)?.closing).toBe("9974.45");

    // Independently: opening − 365 × 0.07, computed through Money.
    const expected = Money.fromString("10000.00", CURRENCY).sub(
      Money.fromString("0.07", CURRENCY).mul(365),
    );
    expect(result.points.at(-1)?.closing).toBe(expected.toString());

    // And the float version really is wrong. At 365 steps the error is ~1e-7 —
    // it still rounds back to the right cents, which is exactly why this is
    // dangerous rather than reassuring: the guarantee below is EXACTNESS, not
    // "it happened to round back". The error only ever accumulates in one
    // direction, and nothing about a longer chain or a different rate keeps it
    // under half a cent.
    let drifted = 10000;
    for (let i = 0; i < 365; i += 1) drifted -= 0.07;
    expect(drifted).not.toBe(9974.45);
    expect(Number(result.points.at(-1)?.closing)).toBe(9974.45);
  });

  it("stays exact over a year of real obligations and paychecks", () => {
    const events = expandObligationEvents(
      [
        {
          id: "ob-mortgage",
          label: "Mortgage",
          expectedAmount: "2150.33",
          direction: "outflow",
          amountMode: "fixed",
          cadence: "monthly",
          anchorDate: "2026-01-01",
          startDate: "2020-01-01",
          endDate: null,
          active: true,
        },
      ],
      "2026-01-01",
      "2026-12-31",
    );
    const result = projectDailyBalance(
      input({
        from: "2026-01-01",
        to: "2026-12-31",
        openingBalance: "40000.00",
        events,
        residual: rate("13.37"),
      }),
    );

    const expected = Money.fromString("40000.00", CURRENCY)
      .sub(Money.fromString("13.37", CURRENCY).mul(365))
      .sub(Money.fromString("2150.33", CURRENCY).mul(12));
    expect(result.points.at(-1)?.closing).toBe(expected.toString());
  });

  it("refuses an inverted horizon rather than returning an empty projection", () => {
    // An empty projection would report safe-to-spend zero, which reads as a
    // shortfall rather than as the caller bug it is.
    expect(() => projectDailyBalance(input({ from: "2026-03-31", to: "2026-03-01" }))).toThrow(
      /horizon/i,
    );
  });

  it("refuses a negative residual rate", () => {
    expect(() =>
      projectDailyBalance(input({ residual: { ...NO_RESIDUAL, dailyRate: "-10.00" } })),
    ).toThrow(/rate/i);
  });

  it("does not mutate its input", () => {
    const events = [bill("2026-03-10", "500.00")];
    const original = structuredClone(events);

    projectDailyBalance(input({ events }));

    expect(events).toEqual(original);
  });
});
