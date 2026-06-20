// @vitest-environment node
import { describe, expect, it } from "vitest";
import { type RangeKey, enumerateMonths, resolveRange } from "./range.ts";

// Fixed "today" so the relative windows are deterministic.
const NOW = new Date("2026-06-19T12:00:00Z");

describe("resolveRange", () => {
  it("defaults to last 12 months when range is missing or unknown", () => {
    for (const params of [undefined, {}, { range: "bogus" }]) {
      const r = resolveRange(params, NOW);
      expect(r.key).toBe<RangeKey>("12m");
      expect(r.from).toBe("2025-07-01");
      expect(r.to).toBe("2026-06-19");
    }
  });

  it("computes trailing N-month windows including the current month", () => {
    expect(resolveRange({ range: "3m" }, NOW).from).toBe("2026-04-01");
    expect(resolveRange({ range: "6m" }, NOW).from).toBe("2026-01-01");
    expect(resolveRange({ range: "12m" }, NOW).from).toBe("2025-07-01");
    // All windows end at "today".
    expect(resolveRange({ range: "3m" }, NOW).to).toBe("2026-06-19");
  });

  it("handles year-to-date", () => {
    const r = resolveRange({ range: "ytd" }, NOW);
    expect(r.from).toBe("2026-01-01");
    expect(r.to).toBe("2026-06-19");
  });

  it("accepts a valid custom range", () => {
    const r = resolveRange({ range: "custom", from: "2025-03-01", to: "2025-09-30" }, NOW);
    expect(r.key).toBe<RangeKey>("custom");
    expect(r.from).toBe("2025-03-01");
    expect(r.to).toBe("2025-09-30");
  });

  it("auto-detects a custom range when both dates are present without an explicit key", () => {
    const r = resolveRange({ from: "2025-03-01", to: "2025-09-30" }, NOW);
    expect(r.key).toBe<RangeKey>("custom");
  });

  it("falls back to the default when custom dates are invalid or mis-ordered", () => {
    expect(resolveRange({ range: "custom", from: "2025-09-30", to: "2025-03-01" }, NOW).key).toBe(
      "12m",
    );
    expect(resolveRange({ range: "custom", from: "not-a-date", to: "2025-03-01" }, NOW).key).toBe(
      "12m",
    );
    expect(resolveRange({ range: "custom" }, NOW).key).toBe("12m");
  });
});

describe("enumerateMonths", () => {
  it("lists every YYYY-MM in an inclusive range", () => {
    expect(enumerateMonths("2026-04-01", "2026-06-19")).toEqual(["2026-04", "2026-05", "2026-06"]);
  });

  it("returns a single month when from and to share it", () => {
    expect(enumerateMonths("2026-06-01", "2026-06-30")).toEqual(["2026-06"]);
  });

  it("crosses a year boundary", () => {
    expect(enumerateMonths("2025-11-15", "2026-02-02")).toEqual([
      "2025-11",
      "2025-12",
      "2026-01",
      "2026-02",
    ]);
  });

  it("returns empty for a reversed range", () => {
    expect(enumerateMonths("2026-06-01", "2026-04-01")).toEqual([]);
  });
});
