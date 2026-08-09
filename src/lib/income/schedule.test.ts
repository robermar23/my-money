// @vitest-environment node
import { describe, expect, it } from "vitest";
import { payDatesBetween, periodsPerYear } from "./schedule.ts";

describe("payDatesBetween — weekly", () => {
  it("steps exactly 7 days from the anchor", () => {
    expect(payDatesBetween("weekly", "2026-01-02", "2026-01-02", "2026-01-30")).toEqual([
      "2026-01-02",
      "2026-01-09",
      "2026-01-16",
      "2026-01-23",
      "2026-01-30",
    ]);
  });

  it("keeps the anchor's phase when the window starts BEFORE the anchor", () => {
    // The anchor phases the schedule; start_date is the backfill floor. A user who
    // anchors on their most recent payday must still get correct historical dates.
    expect(payDatesBetween("weekly", "2026-02-06", "2026-01-09", "2026-02-06")).toEqual([
      "2026-01-09",
      "2026-01-16",
      "2026-01-23",
      "2026-01-30",
      "2026-02-06",
    ]);
  });

  it("does not drift across a DST transition (US spring-forward 2026-03-08)", () => {
    // All math is UTC-midnight, so local-clock shifts cannot move a pay date.
    expect(payDatesBetween("weekly", "2026-03-06", "2026-03-06", "2026-03-20")).toEqual([
      "2026-03-06",
      "2026-03-13",
      "2026-03-20",
    ]);
  });
});

describe("payDatesBetween — biweekly", () => {
  it("steps exactly 14 days and yields 26 pay dates in a 364-day window", () => {
    const dates = payDatesBetween("biweekly", "2026-01-02", "2026-01-02", "2026-12-31");
    expect(dates.length).toBe(26);
    expect(dates[0]).toBe("2026-01-02");
    expect(dates[1]).toBe("2026-01-16");
    expect(dates.at(-1)).toBe("2026-12-18");
  });

  it("preserves phase backward across a year boundary", () => {
    const dates = payDatesBetween("biweekly", "2026-06-05", "2025-12-01", "2026-01-10");
    expect(dates).toEqual(["2025-12-05", "2025-12-19", "2026-01-02"]);
  });
});

describe("payDatesBetween — semimonthly", () => {
  it("pays twice a month on the anchor day and 15 days later", () => {
    expect(payDatesBetween("semimonthly", "2026-01-15", "2026-01-01", "2026-03-31")).toEqual([
      "2026-01-15",
      "2026-01-30",
      "2026-02-15",
      "2026-02-28", // clamped: February has no 30th
      "2026-03-15",
      "2026-03-30",
    ]);
  });

  it("normalises a late anchor into the same day pair", () => {
    // Anchoring on the 30th describes the SAME schedule as anchoring on the 15th.
    expect(payDatesBetween("semimonthly", "2026-01-30", "2026-01-01", "2026-02-28")).toEqual(
      payDatesBetween("semimonthly", "2026-01-15", "2026-01-01", "2026-02-28"),
    );
  });

  it("treats a 31st anchor as the 16th + last day of month", () => {
    expect(payDatesBetween("semimonthly", "2026-01-31", "2026-01-01", "2026-04-30")).toEqual([
      "2026-01-16",
      "2026-01-31",
      "2026-02-16",
      "2026-02-28",
      "2026-03-16",
      "2026-03-31",
      "2026-04-16",
      "2026-04-30",
    ]);
  });

  it("pays on the 1st and 16th when anchored on the 1st", () => {
    expect(payDatesBetween("semimonthly", "2026-05-01", "2026-05-01", "2026-06-16")).toEqual([
      "2026-05-01",
      "2026-05-16",
      "2026-06-01",
      "2026-06-16",
    ]);
  });
});

describe("payDatesBetween — monthly", () => {
  it("clamps to month end without drifting in later months", () => {
    // Jan 31 → Feb 28 → Mar 31 (NOT Mar 28): the day-of-month comes from the
    // anchor every month, never from the previous clamped result.
    expect(payDatesBetween("monthly", "2026-01-31", "2026-01-01", "2026-04-30")).toEqual([
      "2026-01-31",
      "2026-02-28",
      "2026-03-31",
      "2026-04-30",
    ]);
  });

  it("uses Feb 29 in a leap year", () => {
    expect(payDatesBetween("monthly", "2028-01-31", "2028-02-01", "2028-02-29")).toEqual([
      "2028-02-29",
    ]);
  });

  it("keeps a mid-month day stable", () => {
    expect(payDatesBetween("monthly", "2026-03-15", "2026-01-01", "2026-05-31")).toEqual([
      "2026-01-15",
      "2026-02-15",
      "2026-03-15",
      "2026-04-15",
      "2026-05-15",
    ]);
  });
});

describe("payDatesBetween — window handling", () => {
  it("is inclusive of both endpoints", () => {
    expect(payDatesBetween("weekly", "2026-01-02", "2026-01-09", "2026-01-16")).toEqual([
      "2026-01-09",
      "2026-01-16",
    ]);
  });

  it("returns an empty list when the window is inverted", () => {
    expect(payDatesBetween("weekly", "2026-01-02", "2026-02-01", "2026-01-01")).toEqual([]);
  });

  it("returns an empty list when no pay date falls inside the window", () => {
    expect(payDatesBetween("monthly", "2026-01-15", "2026-01-16", "2026-02-14")).toEqual([]);
  });

  it("rejects malformed dates rather than guessing", () => {
    expect(() => payDatesBetween("weekly", "01/02/2026", "2026-01-01", "2026-02-01")).toThrow(
      /YYYY-MM-DD/,
    );
    expect(() => payDatesBetween("weekly", "2026-02-30", "2026-01-01", "2026-02-01")).toThrow(
      /not a real date/,
    );
    expect(() => payDatesBetween("weekly", "2026-01-02", "nope", "2026-02-01")).toThrow();
  });

  it("rejects an unknown cadence", () => {
    expect(() =>
      // biome-ignore lint/suspicious/noExplicitAny: exercising the runtime guard on a text column
      payDatesBetween("fortnightly" as any, "2026-01-02", "2026-01-01", "2026-02-01"),
    ).toThrow(/Unknown income cadence/);
  });
});

describe("periodsPerYear", () => {
  it("maps each cadence to its conventional period count", () => {
    expect(periodsPerYear("weekly")).toBe(52);
    expect(periodsPerYear("biweekly")).toBe(26);
    expect(periodsPerYear("semimonthly")).toBe(24);
    expect(periodsPerYear("monthly")).toBe(12);
  });
});
