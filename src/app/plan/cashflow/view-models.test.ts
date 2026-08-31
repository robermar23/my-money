// @vitest-environment node

import type { DailyProjectionPoint } from "@/lib/cashflow/types.ts";
import { describe, expect, it } from "vitest";
import {
  type OccurrenceInput,
  cashFlowNotice,
  groupOccurrencesByWeek,
  longDate,
  startOfWeek,
  toProjectionPoints,
} from "./view-models.ts";

/**
 * P16-31/P16-33/P16-34 — the derivations behind the projection page.
 *
 * The page itself is markup and is covered by the Playwright flow in Batch 8;
 * what is tested here is everything on it that could be WRONG rather than ugly:
 * the week bucketing (date math, which §Testing Philosophy names as an
 * always-test surface when it drives a spending decision), the chart's event
 * filter (a discretionary residual leaking into the calendar would double-count
 * it to the reader's eye), and the degradation notice — P16-33's rule is that
 * every degraded state names its missing input and links to the fix, which is
 * worth asserting rather than reviewing.
 */

const TODAY = "2026-03-11"; // a Wednesday
const MONDAY = "2026-03-09";

function occurrence(over: Partial<OccurrenceInput> = {}): OccurrenceInput {
  return {
    id: "occ-1",
    obligationId: "obl-1",
    label: "Mortgage",
    dueDate: TODAY,
    expectedAmount: "2150.00",
    direction: "outflow",
    amountMode: "fixed",
    status: "scheduled",
    matchedAmount: null,
    source: "detected",
    ...over,
  };
}

function point(over: Partial<DailyProjectionPoint> = {}): DailyProjectionPoint {
  return {
    date: TODAY,
    opening: "1000.00",
    inflow: "0.00",
    outflow: "0.00",
    closing: "1000.00",
    events: [],
    ...over,
  };
}

/** The page passes `Money.format`; tests pass something obviously distinguishable. */
const fmt = (amount: string): string => `<${amount}>`;

describe("startOfWeek", () => {
  it("returns the Monday of the week a date falls in", () => {
    expect(startOfWeek("2026-03-11")).toBe(MONDAY); // Wednesday
    expect(startOfWeek("2026-03-09")).toBe(MONDAY); // the Monday itself
    expect(startOfWeek("2026-03-15")).toBe(MONDAY); // Sunday closes the week
  });

  it("rolls back across a month boundary", () => {
    // 2026-03-01 is a Sunday, so its week began in February.
    expect(startOfWeek("2026-03-01")).toBe("2026-02-23");
  });

  it("does not shift the date by a timezone", () => {
    // A local-clock implementation moves this by a day west of UTC. The whole
    // app treats a `date` column as a calendar date, never an instant.
    expect(startOfWeek("2026-01-01")).toBe("2025-12-29");
  });
});

describe("longDate", () => {
  it("renders a calendar date as a sentence fragment", () => {
    expect(longDate("2026-03-14")).toBe("March 14");
  });

  it("does not drift a day west of UTC", () => {
    expect(longDate("2026-01-01")).toBe("January 1");
  });
});

describe("groupOccurrencesByWeek", () => {
  it("labels the current and following weeks in words, then by date", () => {
    const grouped = groupOccurrencesByWeek(
      [
        occurrence({ id: "a", dueDate: "2026-03-12" }),
        occurrence({ id: "b", dueDate: "2026-03-17" }),
        occurrence({ id: "c", dueDate: "2026-03-24" }),
      ],
      TODAY,
      { maxWeeks: 6, format: fmt },
    );

    expect(grouped.groups.map((g) => g.heading)).toEqual([
      "This week",
      "Next week",
      "Week of March 23",
    ]);
  });

  it("keeps several bills in one week together, in due-date order", () => {
    const grouped = groupOccurrencesByWeek(
      [
        occurrence({ id: "a", dueDate: "2026-03-13", label: "Power" }),
        occurrence({ id: "b", dueDate: "2026-03-11", label: "Mortgage" }),
      ],
      TODAY,
      { maxWeeks: 6, format: fmt },
    );

    expect(grouped.groups).toHaveLength(1);
    expect(grouped.groups[0]?.items.map((i) => i.label)).toEqual(["Mortgage", "Power"]);
  });

  it("formats every amount through the injected formatter, never in the browser", () => {
    const grouped = groupOccurrencesByWeek([occurrence({ expectedAmount: "2150.00" })], TODAY, {
      maxWeeks: 6,
      format: fmt,
    });

    expect(grouped.groups[0]?.items[0]?.amountDisplay).toBe("<2150.00>");
  });

  it("shows a matched occurrence at what actually posted, not at its expectation", () => {
    // ADR-037 §5 snapshots the expectation and the match records reality. A list
    // that showed the expectation for a bill which already posted for a
    // different amount would contradict the transactions page.
    const grouped = groupOccurrencesByWeek(
      [occurrence({ status: "matched", expectedAmount: "2150.00", matchedAmount: "-2400.00" })],
      TODAY,
      { maxWeeks: 6, format: fmt },
    );

    expect(grouped.groups[0]?.items[0]?.amountDisplay).toBe("<-2400.00>");
  });

  it("caps the list at the requested number of weeks and counts what it hid", () => {
    const rows = [
      occurrence({ id: "a", dueDate: "2026-03-12" }),
      occurrence({ id: "b", dueDate: "2026-03-19" }),
      occurrence({ id: "c", dueDate: "2026-03-26" }),
      occurrence({ id: "d", dueDate: "2026-04-02" }),
      occurrence({ id: "e", dueDate: "2026-04-03" }),
    ];

    const grouped = groupOccurrencesByWeek(rows, TODAY, { maxWeeks: 2, format: fmt });

    expect(grouped.groups).toHaveLength(2);
    // Three bills fall outside the two rendered weeks and are counted, not lost.
    expect(grouped.hiddenCount).toBe(3);
  });

  it("reports nothing hidden when everything fits", () => {
    const grouped = groupOccurrencesByWeek([occurrence()], TODAY, { maxWeeks: 6, format: fmt });
    expect(grouped.hiddenCount).toBe(0);
  });

  it("returns no groups at all for a household with no confirmed bills", () => {
    const grouped = groupOccurrencesByWeek([], TODAY, { maxWeeks: 6, format: fmt });
    expect(grouped.groups).toEqual([]);
    expect(grouped.hiddenCount).toBe(0);
  });
});

describe("toProjectionPoints", () => {
  it("keeps the dated events a reader can act on", () => {
    const [view] = toProjectionPoints(
      [
        point({
          events: [
            {
              kind: "obligation",
              date: TODAY,
              amount: "2150.00",
              direction: "outflow",
              label: "Mortgage",
              obligationId: "obl-1",
              amountMode: "fixed",
            },
            {
              kind: "income",
              date: TODAY,
              amount: "3100.00",
              direction: "inflow",
              label: "Paycheck",
              incomeSourceId: "inc-1",
            },
          ],
        }),
      ],
      fmt,
    );

    expect(view?.events.map((e) => e.label)).toEqual(["Mortgage", "Paycheck"]);
    expect(view?.events[0]?.amountDisplay).toBe("<2150.00>");
  });

  it("drops the discretionary residual from the tooltip", () => {
    // It is on EVERY day by construction (ADR-038 §2). Listing it beside the
    // mortgage would read as a second bill and bury the dated events under
    // sixty identical rows; the chart states it once, in prose, instead.
    const [view] = toProjectionPoints(
      [
        point({
          events: [
            {
              kind: "discretionary",
              date: TODAY,
              amount: "42.31",
              direction: "outflow",
              label: "Everyday spending",
            },
          ],
        }),
      ],
      fmt,
    );

    expect(view?.events).toEqual([]);
  });

  it("carries the closing balance through unrounded and signed", () => {
    const [view] = toProjectionPoints([point({ closing: "-312.45" })], fmt);
    expect(view?.closing).toBe("-312.45");
  });
});

describe("cashFlowNotice (P16-33)", () => {
  it("says nothing when the projection is fully honest", () => {
    expect(cashFlowNotice("ok", { candidateCount: 0, historyMonths: 14 })).toBeNull();
  });

  it("blocks the projection when no operating account is classified", () => {
    const notice = cashFlowNotice("no_operating_account", { candidateCount: 0, historyMonths: 14 });

    expect(notice?.tone).toBe("blocking");
    expect(notice?.href).toBe("/accounts");
  });

  it("names the months it has when history is short, and still draws the calendar", () => {
    const notice = cashFlowNotice("insufficient_history", {
      candidateCount: 0,
      historyMonths: 2,
    });

    expect(notice?.tone).toBe("degraded");
    // The count is the actionable part: "2 of 3" tells the user how close they
    // are, where "not enough history" tells them nothing.
    expect(notice?.body).toContain("2 months");
  });

  it("sends a run-rate-only household to the suggestions waiting for it", () => {
    const notice = cashFlowNotice("run_rate_only", { candidateCount: 4, historyMonths: 14 });

    expect(notice?.tone).toBe("degraded");
    expect(notice?.href).toBe("/plan/cashflow/review");
    expect(notice?.body).toContain("4");
  });

  it("still links to review when the detector found nothing, without claiming it did", () => {
    const notice = cashFlowNotice("run_rate_only", { candidateCount: 0, historyMonths: 14 });

    expect(notice?.href).toBe("/plan/cashflow/review");
    expect(notice?.body).not.toContain("0 suggestion");
  });

  it("names an input and a fix on every degraded state — no bare 'no data'", () => {
    // P16-33's actual rule, asserted over the whole ladder rather than one rung.
    const ladder = ["no_operating_account", "insufficient_history", "run_rate_only"] as const;
    for (const status of ladder) {
      const notice = cashFlowNotice(status, { candidateCount: 1, historyMonths: 1 });
      expect(notice, status).not.toBeNull();
      expect(notice?.title.length, status).toBeGreaterThan(0);
      expect(notice?.href.length, status).toBeGreaterThan(1);
      expect(notice?.linkLabel.length, status).toBeGreaterThan(0);
    }
  });
});
