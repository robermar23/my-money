import { INCOME_CADENCES } from "@/db/schema/income-sources.ts";
import { payDatesBetween } from "@/lib/income/schedule.ts";
// @vitest-environment node
import { describe, expect, it } from "vitest";
import { occurrenceDatesBetween } from "./occurrences.ts";

describe("occurrenceDatesBetween — parity with the income cadences", () => {
  // ADR-036 §5: there is exactly ONE occurrence-expansion implementation.
  // `payDatesBetween` delegates here, so for the income four the two must be
  // indistinguishable. If this ever fails, a second implementation has appeared.
  const windows: ReadonlyArray<readonly [string, string, string]> = [
    ["2026-01-02", "2025-06-01", "2026-12-31"],
    ["2026-01-15", "2026-01-01", "2026-06-30"],
    ["2026-01-31", "2025-11-01", "2026-05-31"],
    ["2026-05-01", "2026-05-01", "2026-06-16"],
  ];

  for (const cadence of INCOME_CADENCES) {
    it(`matches payDatesBetween for ${cadence}`, () => {
      for (const [anchor, from, to] of windows) {
        expect(occurrenceDatesBetween(cadence, anchor, from, to)).toEqual(
          payDatesBetween(cadence, anchor, from, to),
        );
      }
    });
  }
});

describe("occurrenceDatesBetween — quarterly", () => {
  it("steps exactly three calendar months from the anchor", () => {
    expect(occurrenceDatesBetween("quarterly", "2026-02-15", "2026-01-01", "2026-12-31")).toEqual([
      "2026-02-15",
      "2026-05-15",
      "2026-08-15",
      "2026-11-15",
    ]);
  });

  it("clamps a 31st anchor to each quarter's month length without drifting", () => {
    // April has 30 days; the July date must come back to the 31st, because the
    // day always comes from the anchor and never from the previous clamped result.
    expect(occurrenceDatesBetween("quarterly", "2026-01-31", "2026-01-01", "2026-12-31")).toEqual([
      "2026-01-31",
      "2026-04-30",
      "2026-07-31",
      "2026-10-31",
    ]);
  });

  it("generates dates before the anchor as well as after", () => {
    expect(occurrenceDatesBetween("quarterly", "2026-06-10", "2025-06-01", "2026-06-30")).toEqual([
      "2025-06-10",
      "2025-09-10",
      "2025-12-10",
      "2026-03-10",
      "2026-06-10",
    ]);
  });

  it("applies the window bound at day level, not month level", () => {
    expect(occurrenceDatesBetween("quarterly", "2026-01-31", "2026-04-30", "2026-07-30")).toEqual([
      "2026-04-30",
    ]);
  });
});

describe("occurrenceDatesBetween — semiannual", () => {
  it("steps exactly six calendar months in both directions", () => {
    expect(occurrenceDatesBetween("semiannual", "2026-03-15", "2025-01-01", "2027-12-31")).toEqual([
      "2025-03-15",
      "2025-09-15",
      "2026-03-15",
      "2026-09-15",
      "2027-03-15",
      "2027-09-15",
    ]);
  });
});

describe("occurrenceDatesBetween — annual", () => {
  it("repeats the anchor's month and day each year", () => {
    expect(occurrenceDatesBetween("annual", "2026-11-01", "2024-01-01", "2028-12-31")).toEqual([
      "2024-11-01",
      "2025-11-01",
      "2026-11-01",
      "2027-11-01",
      "2028-11-01",
    ]);
  });

  it("clamps a Feb 29 anchor to Feb 28 in common years", () => {
    expect(occurrenceDatesBetween("annual", "2028-02-29", "2027-01-01", "2031-12-31")).toEqual([
      "2027-02-28",
      "2028-02-29",
      "2029-02-28",
      "2030-02-28",
      "2031-02-28",
    ]);
  });

  it("clamps a Jan 31 anchor nowhere — January always has 31 days", () => {
    expect(occurrenceDatesBetween("annual", "2026-01-31", "2026-01-01", "2027-12-31")).toEqual([
      "2026-01-31",
      "2027-01-31",
    ]);
  });
});

describe("occurrenceDatesBetween — window and input handling", () => {
  it("returns an empty array for an inverted window", () => {
    expect(occurrenceDatesBetween("annual", "2026-06-15", "2027-01-01", "2026-01-01")).toEqual([]);
  });

  it("returns an empty array when the window contains no occurrence", () => {
    expect(occurrenceDatesBetween("quarterly", "2026-01-15", "2026-02-01", "2026-04-14")).toEqual(
      [],
    );
  });

  it("rejects malformed dates rather than guessing", () => {
    expect(() =>
      occurrenceDatesBetween("annual", "11/01/2026", "2026-01-01", "2027-01-01"),
    ).toThrow(/YYYY-MM-DD/);
    expect(() =>
      occurrenceDatesBetween("annual", "2026-02-30", "2026-01-01", "2027-01-01"),
    ).toThrow(/not a real date/);
    expect(() => occurrenceDatesBetween("annual", "2026-11-01", "nope", "2027-01-01")).toThrow();
  });

  it("rejects an unknown cadence", () => {
    expect(() =>
      // biome-ignore lint/suspicious/noExplicitAny: exercising the runtime guard on a text column
      occurrenceDatesBetween("fortnightly" as any, "2026-01-02", "2026-01-01", "2026-02-01"),
    ).toThrow(/Unknown cadence/);
  });
});
