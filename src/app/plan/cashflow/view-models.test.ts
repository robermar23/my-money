// @vitest-environment node

import type { DailyProjectionPoint } from "@/lib/cashflow/types.ts";
import { sinkingRequirement } from "@/lib/sinking/requirement.ts";
import { ROUND12_TODAY, round12Costs } from "@/lib/sinking/round12.fixture.ts";
import { describe, expect, it } from "vitest";
import {
  type OccurrenceInput,
  cashFlowNotice,
  groupOccurrencesByWeek,
  longDate,
  sinkingNoteSentence,
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

  it("marks a recorded one-off cost as what it is, beside a bill that looks the same", () => {
    // P18-29. The compiler cannot catch this: a `planned_expense` event
    // satisfies every field the tooltip reads, so without `kind` a $4,000 roof
    // renders identically to a recurring bill. A cliff in the line that is a
    // roof is a decision the household already made; a cliff that is the
    // mortgage is not, and those are different things to be told.
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
              kind: "planned_expense",
              date: TODAY,
              amount: "4000.00",
              direction: "outflow",
              label: "New roof",
              plannedExpenseId: "pe-1",
            },
          ],
        }),
      ],
      fmt,
    );

    expect(view?.events.map((e) => [e.label, e.kind])).toEqual([
      ["Mortgage", "obligation"],
      ["New roof", "planned_expense"],
    ]);
  });

  it("carries the closing balance through unrounded and signed", () => {
    const [view] = toProjectionPoints([point({ closing: "-312.45" })], fmt);
    expect(view?.closing).toBe("-312.45");
  });
});

/**
 * P18-27 / P18-29 — the sinking-fund sentence.
 *
 * Asserted as string literals typed out by hand, the same standard
 * `/plan/sinking`'s headline is held to: a sentence a household reads a dollar
 * figure out of is a deliverable, and a test that rebuilds it from the same
 * template proves nothing. The reason it is tested at all is that the P18-27
 * version was WRONG after P18-29 — it opened "Beyond this window" while the
 * costs inside the window had just been added to the line above it.
 */
describe("sinkingNoteSentence (P18-27, corrected by P18-29)", () => {
  const plain = (amount: string) => `$${amount}`;

  function requirementOf(costs: readonly ReturnType<typeof round12Costs>[number][]) {
    return sinkingRequirement(costs, ROUND12_TODAY, {
      from: ROUND12_TODAY,
      to: "2027-10-04",
      currency: "USD",
    });
  }

  it("says how many of the four are already on the line, when some are", () => {
    // A 60-day-ish window that reaches the water bill (2026-12-04) and stops
    // short of the car insurance, the dental work and the roof.
    expect(sinkingNoteSentence(requirementOf(round12Costs()), "2026-12-04", plain)).toBe(
      "Over the next 12 months, 4 known costs mean you should already be holding $2180.00 for them. 1 of them lands inside the window above and is already on the line.",
    );
  });

  it("says none are on the line when the window stops before the first one", () => {
    expect(sinkingNoteSentence(requirementOf(round12Costs()), "2026-11-30", plain)).toBe(
      "Over the next 12 months, 4 known costs mean you should already be holding $2180.00 for them. None of them land inside the window above.",
    );
  });

  it("says all of them when the window covers every cost", () => {
    expect(sinkingNoteSentence(requirementOf(round12Costs()), "2027-10-04", plain)).toBe(
      "Over the next 12 months, 4 known costs mean you should already be holding $2180.00 for them. All of them land inside the window above and are already on the line.",
    );
  });

  it("reads as English for a household with exactly one cost", () => {
    const one = [round12Costs()[0] as ReturnType<typeof round12Costs>[number]];

    expect(sinkingNoteSentence(requirementOf(one), "2026-12-04", plain)).toBe(
      "Over the next 12 months, 1 known cost means you should already be holding $80.00 for it. It lands inside the window above and is already on the line.",
    );
    expect(sinkingNoteSentence(requirementOf(one), "2026-11-30", plain)).toBe(
      "Over the next 12 months, 1 known cost means you should already be holding $80.00 for it. It falls beyond the window above.",
    );
  });

  it("says nothing at all when no cost is recorded", () => {
    // Not "$0.00 required", which reads as a verdict on a household that has
    // simply not told the app anything yet (ADR-046 §5). `/plan` is where the
    // empty list is named as a missing input.
    expect(sinkingNoteSentence(requirementOf([]), "2026-12-04", plain)).toBeNull();
  });

  it("never states the emergency-fund target or what is available", () => {
    // ADR-046 §9 / ADR-048 §5. The page cannot compute either figure, and this
    // sentence is not given them — but the copy is where a well-meaning edit
    // would reach for them, so the prohibition is asserted on the output.
    const sentence = sinkingNoteSentence(requirementOf(round12Costs()), "2026-12-04", plain) ?? "";

    expect(sentence).not.toMatch(/emergency|available|reserve|surplus|short/i);
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
