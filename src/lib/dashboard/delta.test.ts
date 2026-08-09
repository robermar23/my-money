// @vitest-environment node
import { describe, expect, it } from "vitest";
import { type SeriesPoint, rangeDelta } from "./delta.ts";

// Fixed "today" so the resolved window is deterministic. With NOW in mid-2026,
// a "1Y" window is 2025-06-15 … 2026-06-15 and "ALL" keeps everything.
const NOW = new Date("2026-06-15T00:00:00Z");

const series: readonly SeriesPoint[] = [
  { date: "2024-01-01", value: "50000.00" },
  { date: "2025-07-01", value: "100000.00" },
  { date: "2026-01-01", value: "110000.00" },
  { date: "2026-06-01", value: "125000.00" },
];

describe("rangeDelta", () => {
  it("computes a positive move + percent over the windowed series", () => {
    // 1Y window keeps 2025-07-01 (100k) … 2026-06-01 (125k): +25k = +25.00%.
    const d = rangeDelta(series, "1Y", "USD", NOW);
    expect(d.abs.toString()).toBe("25000.00");
    expect(d.pct).toBe("25.00");
    expect(d.direction).toBe("up");
  });

  it("uses the whole series for ALL and reports the full move", () => {
    // 50k → 125k = +75k over a 50k base = +150.00%.
    const d = rangeDelta(series, "ALL", "USD", NOW);
    expect(d.abs.toString()).toBe("75000.00");
    expect(d.pct).toBe("150.00");
    expect(d.direction).toBe("up");
  });

  it("reports a negative move as down with a signed percent", () => {
    const down: SeriesPoint[] = [
      { date: "2026-05-01", value: "200000.00" },
      { date: "2026-06-10", value: "150000.00" },
    ];
    const d = rangeDelta(down, "3M", "USD", NOW);
    expect(d.abs.toString()).toBe("-50000.00");
    expect(d.pct).toBe("-25.00");
    expect(d.direction).toBe("down");
  });

  it("is flat with no percent for an empty series", () => {
    const d = rangeDelta([], "1Y", "USD", NOW);
    expect(d.abs.toString()).toBe("0.00");
    expect(d.pct).toBeNull();
    expect(d.direction).toBe("flat");
  });

  it("is flat with no percent when only one point falls in the window", () => {
    const d = rangeDelta([{ date: "2026-06-01", value: "125000.00" }], "1Y", "USD", NOW);
    expect(d.pct).toBeNull();
    expect(d.direction).toBe("flat");
  });

  it("returns flat when start and end are equal", () => {
    const equal: SeriesPoint[] = [
      { date: "2026-05-01", value: "1000.00" },
      { date: "2026-06-01", value: "1000.00" },
    ];
    const d = rangeDelta(equal, "3M", "USD", NOW);
    expect(d.abs.isZero()).toBe(true);
    expect(d.pct).toBe("0.00");
    expect(d.direction).toBe("flat");
  });

  it("yields a null percent (not Infinity) when the baseline is zero", () => {
    const fromZero: SeriesPoint[] = [
      { date: "2026-05-01", value: "0.00" },
      { date: "2026-06-01", value: "5000.00" },
    ];
    const d = rangeDelta(fromZero, "3M", "USD", NOW);
    expect(d.abs.toString()).toBe("5000.00");
    expect(d.pct).toBeNull();
    expect(d.direction).toBe("up");
  });

  it("sorts defensively before picking start/end", () => {
    const unordered: SeriesPoint[] = [
      { date: "2026-06-01", value: "125000.00" },
      { date: "2026-05-01", value: "100000.00" },
    ];
    const d = rangeDelta(unordered, "3M", "USD", NOW);
    expect(d.abs.toString()).toBe("25000.00");
    expect(d.direction).toBe("up");
  });
});
