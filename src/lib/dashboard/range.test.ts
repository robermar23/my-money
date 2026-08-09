// @vitest-environment node
import { describe, expect, it } from "vitest";
import { DEFAULT_RANGE, type DashboardRange, parseDashboardRange, rangeWindow } from "./range.ts";

// Fixed "today" so the relative windows are deterministic.
const NOW = new Date("2026-06-19T12:00:00Z");

describe("parseDashboardRange", () => {
  it("accepts each preset, case-insensitively", () => {
    const cases: ReadonlyArray<[string, DashboardRange]> = [
      ["1M", "1M"],
      ["3m", "3M"],
      ["6M", "6M"],
      ["1y", "1Y"],
      ["ytd", "YTD"],
      ["ALL", "ALL"],
      ["  all  ", "ALL"],
    ];
    for (const [input, expected] of cases) {
      expect(parseDashboardRange(input)).toBe(expected);
    }
  });

  it("falls back to the default (1Y) for missing/garbage values", () => {
    for (const raw of [undefined, "", "bogus", "2y", "week", "1"]) {
      expect(parseDashboardRange(raw)).toBe<DashboardRange>("1Y");
    }
    expect(DEFAULT_RANGE).toBe<DashboardRange>("1Y");
  });
});

describe("rangeWindow", () => {
  it("ends every window at today", () => {
    for (const r of ["1M", "3M", "6M", "1Y", "YTD", "ALL"] as const) {
      expect(rangeWindow(r, NOW).to).toBe("2026-06-19");
    }
  });

  it("computes day-preserving N-month windows", () => {
    expect(rangeWindow("1M", NOW).from).toBe("2026-05-19");
    expect(rangeWindow("3M", NOW).from).toBe("2026-03-19");
    expect(rangeWindow("6M", NOW).from).toBe("2025-12-19");
    expect(rangeWindow("1Y", NOW).from).toBe("2025-06-19");
  });

  it("YTD starts at January 1st of the current year", () => {
    expect(rangeWindow("YTD", NOW).from).toBe("2026-01-01");
  });

  it("ALL reaches back before any plausible snapshot", () => {
    const all = rangeWindow("ALL", NOW);
    expect(all.from < "1970-01-01").toBe(true);
    // A real snapshot date is always inside [from, to].
    expect("2019-01-01" >= all.from && "2019-01-01" <= all.to).toBe(true);
  });

  it("distinguishes YTD from ALL at the year boundary (Jan vs epoch)", () => {
    const jan = new Date("2026-01-05T00:00:00Z");
    expect(rangeWindow("YTD", jan).from).toBe("2026-01-01");
    expect(rangeWindow("ALL", jan).from).toBe("0001-01-01");
    // Early January: a 1Y window crosses into the prior year, YTD does not.
    expect(rangeWindow("1Y", jan).from).toBe("2025-01-05");
  });
});
