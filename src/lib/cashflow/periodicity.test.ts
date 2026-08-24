// @vitest-environment node
import { OBLIGATION_CADENCES } from "@/lib/schedule/cadence.ts";
import { occurrenceDatesBetween } from "@/lib/schedule/occurrences.ts";
import { describe, expect, it } from "vitest";
import { detectPeriodicity } from "./periodicity.ts";

describe("detectPeriodicity — monthly", () => {
  it("reads a clean monthly series", () => {
    const result = detectPeriodicity([
      "2026-01-15",
      "2026-02-15",
      "2026-03-15",
      "2026-04-15",
      "2026-05-15",
      "2026-06-15",
    ]);
    expect(result).toEqual({
      cadence: "monthly",
      anchorDate: "2026-06-15",
      confidence: "high",
    });
  });

  it("still reads monthly when one month is skipped", () => {
    // The median gap is the point of using a median: the 61-day hole must not
    // drag the verdict toward quarterly the way a mean would.
    const result = detectPeriodicity([
      "2026-01-15",
      "2026-02-15",
      "2026-03-15",
      // April missing
      "2026-05-15",
      "2026-06-15",
      "2026-07-15",
    ]);
    expect(result?.cadence).toBe("monthly");
    // A hole is real evidence of a less reliable series, so it is graded down.
    expect(result?.confidence).toBe("medium");
  });

  it("reads a month-end series that clamps 31 to 28 and back as monthly, not irregular", () => {
    const result = detectPeriodicity([
      "2026-01-31",
      "2026-02-28",
      "2026-03-31",
      "2026-04-30",
      "2026-05-31",
      "2026-06-30",
    ]);
    expect(result?.cadence).toBe("monthly");
    expect(result?.confidence).toBe("high");
  });

  it("anchors a clamped month-end series on the largest observed day", () => {
    // Month-length clamping only ever REDUCES the day, so the true schedule day
    // is at least the largest day observed. Anchoring on the most recent date
    // (the 30th) would move every future long-month bill a day early.
    const result = detectPeriodicity([
      "2026-01-31",
      "2026-02-28",
      "2026-03-31",
      "2026-04-30",
      "2026-05-31",
      "2026-06-30",
    ]);
    expect(result?.anchorDate).toBe("2026-05-31");
  });
});

describe("detectPeriodicity — weekly and the biweekly/semimonthly confusion", () => {
  it("reads a weekly series", () => {
    const result = detectPeriodicity([
      "2026-01-05",
      "2026-01-12",
      "2026-01-19",
      "2026-01-26",
      "2026-02-02",
      "2026-02-09",
    ]);
    expect(result).toEqual({
      cadence: "weekly",
      anchorDate: "2026-02-09",
      confidence: "high",
    });
  });

  it("reads an every-other-Friday series as biweekly (26/yr)", () => {
    const result = detectPeriodicity([
      "2026-01-02",
      "2026-01-16",
      "2026-01-30",
      "2026-02-13",
      "2026-02-27",
      "2026-03-13",
    ]);
    expect(result?.cadence).toBe("biweekly");
    expect(result?.anchorDate).toBe("2026-03-13");
  });

  it("reads a 15th-and-month-end series as semimonthly (24/yr)", () => {
    // The classic confusion. The median gap is ~15 for BOTH, so the median
    // alone cannot decide it — biweekly gaps are exactly 14, while semimonthly
    // gaps alternate around 15 and land twice in every calendar month.
    const result = detectPeriodicity([
      "2026-01-15",
      "2026-01-31",
      "2026-02-15",
      "2026-02-28",
      "2026-03-15",
      "2026-03-31",
    ]);
    expect(result?.cadence).toBe("semimonthly");
  });

  it("reads a 1st-and-15th series as semimonthly", () => {
    const result = detectPeriodicity([
      "2026-01-01",
      "2026-01-15",
      "2026-02-01",
      "2026-02-15",
      "2026-03-01",
      "2026-03-15",
    ]);
    expect(result?.cadence).toBe("semimonthly");
  });

  it("anchors semimonthly on the earlier half of the month", () => {
    // `occurrenceDatesBetween` derives the second date as anchorDay + 15, so
    // only the earlier of the two days is recoverable from the anchor.
    const result = detectPeriodicity([
      "2026-01-15",
      "2026-01-31",
      "2026-02-15",
      "2026-02-28",
      "2026-03-15",
      "2026-03-31",
    ]);
    expect(result?.anchorDate).toBe("2026-03-15");
  });

  it("still reads biweekly when a payment is skipped (a 28-day hole)", () => {
    const result = detectPeriodicity([
      "2026-01-02",
      "2026-01-16",
      // 2026-01-30 missing
      "2026-02-13",
      "2026-02-27",
      "2026-03-13",
    ]);
    expect(result?.cadence).toBe("biweekly");
  });
});

describe("detectPeriodicity — the long cadences", () => {
  it("reads a quarterly series", () => {
    const result = detectPeriodicity([
      "2026-01-15",
      "2026-04-15",
      "2026-07-15",
      "2026-10-15",
      "2027-01-15",
    ]);
    expect(result?.cadence).toBe("quarterly");
    expect(result?.anchorDate).toBe("2027-01-15");
  });

  it("reads a semiannual series", () => {
    const result = detectPeriodicity(["2026-01-15", "2026-07-15", "2027-01-15", "2027-07-15"]);
    expect(result?.cadence).toBe("semiannual");
  });

  it("reads an annual series across a leap year", () => {
    const result = detectPeriodicity(["2026-01-15", "2027-01-15", "2028-01-15", "2029-01-15"]);
    expect(result?.cadence).toBe("annual");
  });
});

describe("detectPeriodicity — refusing to guess", () => {
  it("returns null for two occurrences", () => {
    // One gap is not a cadence. Three occurrences is the stated minimum because
    // two gaps are the fewest that can disagree with each other.
    expect(detectPeriodicity(["2026-01-15", "2026-02-15"])).toBeNull();
  });

  it("returns null for one occurrence and for none", () => {
    expect(detectPeriodicity(["2026-01-15"])).toBeNull();
    expect(detectPeriodicity([])).toBeNull();
  });

  it("returns null for a random series whose median gap fits no bucket", () => {
    expect(
      detectPeriodicity([
        "2026-01-03",
        "2026-01-19",
        "2026-03-02",
        "2026-03-05",
        "2026-06-11",
        "2026-06-30",
      ]),
    ).toBeNull();
  });

  it("returns null when the median lands in a bucket but most gaps do not", () => {
    // Gaps 30, 5, 70, 44, 30 — the median is a clean 30, which is exactly the
    // trap. Two of five gaps fit; a majority must fit before this is a series.
    expect(
      detectPeriodicity([
        "2026-01-01",
        "2026-01-31",
        "2026-02-05",
        "2026-04-16",
        "2026-05-30",
        "2026-06-29",
      ]),
    ).toBeNull();
  });

  it("accepts the minimum of three occurrences, graded low", () => {
    const result = detectPeriodicity(["2026-01-15", "2026-02-15", "2026-03-15"]);
    expect(result?.cadence).toBe("monthly");
    expect(result?.confidence).toBe("low");
  });
});

describe("detectPeriodicity — input handling", () => {
  it("does not require sorted input", () => {
    const sorted = detectPeriodicity(["2026-01-15", "2026-02-15", "2026-03-15", "2026-04-15"]);
    const shuffled = detectPeriodicity(["2026-03-15", "2026-01-15", "2026-04-15", "2026-02-15"]);
    expect(shuffled).toEqual(sorted);
  });

  it("collapses same-day duplicates rather than reading a zero-day gap", () => {
    // Two charges from one merchant on one day is one occurrence, not a
    // zero-day cadence.
    const result = detectPeriodicity([
      "2026-01-15",
      "2026-01-15",
      "2026-02-15",
      "2026-03-15",
      "2026-04-15",
    ]);
    expect(result?.cadence).toBe("monthly");
  });

  it("throws on a malformed date rather than silently dropping it", () => {
    expect(() => detectPeriodicity(["2026-01-15", "not-a-date", "2026-03-15"])).toThrow();
    expect(() => detectPeriodicity(["2026-01-15", "2026-02-30", "2026-03-15"])).toThrow();
  });
});

describe("detectPeriodicity — round-trips through the shared expander", () => {
  it("returns a cadence and anchor the one expander can reproduce", () => {
    // The point of ADR-036 §5: whatever detection proposes must be expandable
    // by `occurrenceDatesBetween`, because that is what materialization walks.
    for (const cadence of OBLIGATION_CADENCES) {
      const generated = occurrenceDatesBetween(cadence, "2026-03-11", "2026-01-01", "2031-12-31");
      const sample = generated.slice(0, 8);
      if (sample.length < 3) continue;
      const result = detectPeriodicity(sample);
      expect(result, `cadence ${cadence}`).not.toBeNull();
      expect(result?.cadence, `cadence ${cadence}`).toBe(cadence);
      // Re-expanding from the detected anchor reproduces the observed dates.
      const first = sample[0] as string;
      const last = sample[sample.length - 1] as string;
      const reexpanded = occurrenceDatesBetween(
        result?.cadence as (typeof OBLIGATION_CADENCES)[number],
        result?.anchorDate as string,
        first,
        last,
      );
      expect(reexpanded, `cadence ${cadence}`).toEqual(sample);
    }
  });
});
