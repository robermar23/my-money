// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  type DatedFlow,
  type FlowTxn,
  type ValuedSnapshot,
  attribution,
  benchmarkTwr,
  externalFlow,
  gainLossSeries,
  moneyWeightedReturn,
  netExternalFlows,
  twr,
  twrIndexSeries,
  valueSeries,
  xirr,
} from "./performance.ts";

/**
 * P9-13 — performance math test sweep over P9-09 → P9-12. These are the
 * edge-case-heavy "always-test" pure functions (CLAUDE.md §Testing Philosophy):
 * value/gain-loss series, contributions-vs-growth, XIRR, TWR + benchmark. All
 * math is `Decimal`/`Money` (penny-exact) — no native float anywhere.
 */

describe("valueSeries (P9-09)", () => {
  it("sums value per date across holdings, ascending", () => {
    const snaps: ValuedSnapshot[] = [
      { date: "2026-01-02", value: "100.00", costBasis: null },
      { date: "2026-01-01", value: "1000.00", costBasis: "900.00" },
      { date: "2026-01-01", value: "500.00", costBasis: "400.00" },
      { date: "2026-01-02", value: "1100.00", costBasis: "900.00" },
    ];
    expect(valueSeries(snaps)).toEqual([
      { date: "2026-01-01", value: "1500.00" },
      { date: "2026-01-02", value: "1200.00" },
    ]);
  });

  it("returns [] for empty input (never NaN)", () => {
    expect(valueSeries([])).toEqual([]);
  });
});

describe("gainLossSeries (P9-09)", () => {
  it("tracks value − basis over the basis-known subset", () => {
    const snaps: ValuedSnapshot[] = [
      { date: "2026-01-01", value: "1000.00", costBasis: "900.00" },
      { date: "2026-01-01", value: "300.00", costBasis: null }, // cash → excluded from gain
    ];
    expect(gainLossSeries(snaps)).toEqual([
      { date: "2026-01-01", value: "1300.00", costBasis: "900.00", gain: "100.00" },
    ]);
  });

  it("reports null basis/gain when no position has a known basis", () => {
    const snaps: ValuedSnapshot[] = [{ date: "2026-01-01", value: "300.00", costBasis: null }];
    expect(gainLossSeries(snaps)).toEqual([
      { date: "2026-01-01", value: "300.00", costBasis: null, gain: null },
    ]);
  });

  it("returns [] for empty input", () => {
    expect(gainLossSeries([])).toEqual([]);
  });
});

describe("externalFlow / netExternalFlows (P9-10)", () => {
  const at = (type: string, subtype: string | null, amount: string): FlowTxn => ({
    type,
    subtype,
    amount,
    date: "2026-03-01",
  });

  it("treats buys/deposits as inflows and sells/withdrawals as outflows", () => {
    // Plaid sign differs by type; classifier keys off type/subtype, not the sign.
    expect(externalFlow(at("buy", null, "-1000.00"))?.amount).toBe("1000.00");
    expect(externalFlow(at("sell", null, "500.00"))?.amount).toBe("-500.00");
    expect(externalFlow(at("cash", "deposit", "250.00"))?.amount).toBe("250.00");
    expect(externalFlow(at("cash", "withdrawal", "-250.00"))?.amount).toBe("-250.00");
  });

  it("ignores internal income/cost (dividend, interest, fee, transfer)", () => {
    expect(externalFlow(at("cash", "dividend", "12.00"))).toBeNull();
    expect(externalFlow(at("cash", "interest", "3.00"))).toBeNull();
    expect(externalFlow(at("fee", null, "-1.00"))).toBeNull();
    expect(externalFlow(at("transfer", null, "100.00"))).toBeNull();
  });

  it("nets a mixed set", () => {
    const flows: DatedFlow[] = [
      { date: "2026-01-01", amount: "1000.00" },
      { date: "2026-02-01", amount: "-300.00" },
    ];
    expect(netExternalFlows(flows).toString()).toBe("700.00");
  });
});

describe("attribution (P9-10)", () => {
  it("flat market + a deposit ⇒ growth ≈ 0, flows = deposit", () => {
    const a = attribution("1000.00", "1100.00", [{ date: "2026-02-01", amount: "100.00" }]);
    expect(a).toEqual({
      startValue: "1000.00",
      endValue: "1100.00",
      netFlows: "100.00",
      marketGrowth: "0.00",
    });
  });

  it("appreciation with no flows ⇒ growth = Δvalue", () => {
    const a = attribution("1000.00", "1250.00", []);
    expect(a.netFlows).toBe("0.00");
    expect(a.marketGrowth).toBe("250.00");
  });

  it("mixed flows + appreciation, penny-exact", () => {
    const a = attribution("1000.00", "1500.00", [
      { date: "2026-02-01", amount: "300.00" },
      { date: "2026-03-01", amount: "-50.00" },
    ]);
    expect(a.netFlows).toBe("250.00");
    expect(a.marketGrowth).toBe("250.00"); // 500 Δ − 250 net flows
  });
});

describe("xirr (P9-11)", () => {
  it("solves the textbook single-period case to 10%", () => {
    const r = xirr([
      { date: "2025-01-01", amount: "-1000.00" },
      { date: "2026-01-01", amount: "1100.00" },
    ]);
    expect(r).not.toBeNull();
    expect(Number(r)).toBeCloseTo(10, 1);
  });

  it("solves a multi-flow case (≈ a known IRR)", () => {
    // -1000 at t0, -1000 at +1y, +2200 at +2y → root of x²+x−2.2=0 (x=1+r) ⇒ r ≈ 6.52%.
    const r = xirr([
      { date: "2024-01-01", amount: "-1000.00" },
      { date: "2025-01-01", amount: "-1000.00" },
      { date: "2026-01-01", amount: "2200.00" },
    ]);
    expect(Number(r)).toBeCloseTo(6.52, 1);
  });

  it("handles a loss (negative return)", () => {
    const r = xirr([
      { date: "2025-01-01", amount: "-1000.00" },
      { date: "2026-01-01", amount: "800.00" },
    ]);
    expect(Number(r)).toBeCloseTo(-20, 1);
  });

  it("returns null when the IRR is undefined", () => {
    expect(xirr([{ date: "2025-01-01", amount: "-1000.00" }])).toBeNull(); // single flow
    expect(
      xirr([
        { date: "2025-01-01", amount: "-1000.00" },
        { date: "2026-01-01", amount: "-500.00" }, // no sign change
      ]),
    ).toBeNull();
    expect(
      xirr([
        { date: "2025-01-01", amount: "-1000.00" },
        { date: "2025-01-01", amount: "1100.00" }, // same day → no time span
      ]),
    ).toBeNull();
  });
});

describe("moneyWeightedReturn (P9-11)", () => {
  it("wraps xirr with start value as the initial purchase", () => {
    const r = moneyWeightedReturn({
      startValue: "1000.00",
      startDate: "2025-01-01",
      endValue: "1100.00",
      endDate: "2026-01-01",
      flows: [],
    });
    expect(Number(r)).toBeCloseTo(10, 1);
  });

  it("neutralizes a mid-period contribution in the personal return", () => {
    // Put in 1000, add 1000 at 6mo, end at 2100 → small positive personal return.
    const r = moneyWeightedReturn({
      startValue: "1000.00",
      startDate: "2025-01-01",
      endValue: "2100.00",
      endDate: "2026-01-01",
      flows: [{ date: "2025-07-01", amount: "1000.00" }],
    });
    expect(r).not.toBeNull();
    expect(Number(r)).toBeGreaterThan(0);
  });

  it("returns null for an empty portfolio with no flows", () => {
    expect(
      moneyWeightedReturn({
        startValue: "0.00",
        startDate: "2025-01-01",
        endValue: "0.00",
        endDate: "2026-01-01",
        flows: [],
      }),
    ).toBeNull();
  });
});

describe("twr (P9-12)", () => {
  it("equals the simple return when there are no flows", () => {
    const r = twr([
      { date: "2026-01-01", value: "1000.00" },
      { date: "2026-01-02", value: "1050.00" },
      { date: "2026-01-03", value: "1100.00" },
    ]);
    expect(Number(r)).toBeCloseTo(10, 4); // 1100/1000 − 1
  });

  it("a mid-period flow does not distort the period return", () => {
    // Day 2: value jumps 1000 → 2000 but 1000 of it is a contribution → 0% that day.
    const r = twr(
      [
        { date: "2026-01-01", value: "1000.00" },
        { date: "2026-01-02", value: "2000.00" },
        { date: "2026-01-03", value: "2200.00" },
      ],
      [{ date: "2026-01-02", amount: "1000.00" }],
    );
    // sub-returns: day2 = 2000/(1000+1000)-1 = 0; day3 = 2200/2000-1 = 10%.
    expect(Number(r)).toBeCloseTo(10, 4);
  });

  it("returns null for insufficient history", () => {
    expect(twr([{ date: "2026-01-01", value: "1000.00" }])).toBeNull();
    expect(twr([])).toBeNull();
  });
});

describe("twrIndexSeries (P9-12)", () => {
  it("indexes growth from the base, neutralizing flows", () => {
    const series = twrIndexSeries(
      [
        { date: "2026-01-01", value: "1000.00" },
        { date: "2026-01-02", value: "2000.00" }, // +1000 is a contribution → flat
        { date: "2026-01-03", value: "2200.00" }, // +10%
      ],
      [{ date: "2026-01-02", amount: "1000.00" }],
    );
    expect(series.map((p) => p.value)).toEqual(["100.00", "100.00", "110.00"]);
  });

  it("returns [] for empty input", () => {
    expect(twrIndexSeries([])).toEqual([]);
  });
});

describe("benchmarkTwr (P9-12)", () => {
  it("is the simple index return over the date axis", () => {
    const r = benchmarkTwr([
      { date: "2026-01-01", value: "5000.00" },
      { date: "2026-01-02", value: "5500.00" },
    ]);
    expect(Number(r)).toBeCloseTo(10, 4);
  });

  it("returns null when there is only one close", () => {
    expect(benchmarkTwr([{ date: "2026-01-01", value: "5000.00" }])).toBeNull();
  });
});
