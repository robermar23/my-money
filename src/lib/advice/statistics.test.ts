// @vitest-environment node
import { describe, expect, it } from "vitest";
import { coverageMultiple, medianMoney, percentileMoney, shareOf } from "./statistics.ts";

/* Pure order statistics — no DB, no fixtures. ADR-034 §3 lives or dies here. */

describe("medianMoney", () => {
  it("returns null for an empty set — 'no data' is not 'zero dollars'", () => {
    // The whole phase rests on this distinction: a 0 median would produce a $0
    // reserve target, which renders as *funded*.
    expect(medianMoney([])).toBeNull();
  });

  it("returns the middle value for an odd count", () => {
    expect(medianMoney(["300.00", "100.00", "200.00"])).toBe("200.00");
  });

  it("averages the two middle values for an even count", () => {
    expect(medianMoney(["100.00", "200.00", "300.00", "500.00"])).toBe("250.00");
  });

  it("is penny-exact on an even count that averages to a half-cent boundary", () => {
    // 100.01 + 100.02 = 200.03 / 2 = 100.015 → banker's rounding to 100.02.
    expect(medianMoney(["100.01", "100.02"])).toBe("100.02");
  });

  it("does not care about input order", () => {
    expect(medianMoney(["500.00", "100.00", "300.00", "200.00"])).toBe("250.00");
  });

  it("handles a single value", () => {
    expect(medianMoney(["1234.56"])).toBe("1234.56");
  });

  it("handles negative values (a clawback month)", () => {
    expect(medianMoney(["-100.00", "0.00", "100.00"])).toBe("0.00");
  });
});

describe("medianMoney vs. the mean — the ADR-034 §3 divergence", () => {
  it("an outlier month barely moves the median but drags the mean", () => {
    // Eleven ordinary months plus one $2,000 transmission repair.
    const ordinary = Array.from({ length: 11 }, () => "400.00");
    const withOutlier = [...ordinary, "2400.00"];

    // Median of 12 values = mean of the 6th and 7th = 400.
    expect(medianMoney(withOutlier)).toBe("400.00");

    // The mean is 566.67 — a 42% inflation of every target built on it.
    const mean = withOutlier.reduce((sum, v) => sum + Number(v), 0) / withOutlier.length;
    expect(Math.round(mean)).toBe(567);
  });
});

describe("percentileMoney", () => {
  it("p75 sits above the median — the buffer ADR-034 §3 wants for budgets", () => {
    const values = ["100.00", "200.00", "300.00", "400.00"];
    expect(medianMoney(values)).toBe("250.00");
    expect(percentileMoney(values, 0.75)).toBe("325.00");
  });

  it("p0 and p1 are the min and max", () => {
    const values = ["300.00", "100.00", "200.00"];
    expect(percentileMoney(values, 0)).toBe("100.00");
    expect(percentileMoney(values, 1)).toBe("300.00");
  });

  it("clamps out-of-range percentiles rather than throwing", () => {
    const values = ["100.00", "200.00"];
    expect(percentileMoney(values, -5)).toBe("100.00");
    expect(percentileMoney(values, 5)).toBe("200.00");
  });

  it("returns null for an empty set", () => {
    expect(percentileMoney([], 0.75)).toBeNull();
  });
});

describe("shareOf", () => {
  it("computes a ratio to four places", () => {
    expect(shareOf("180.00", "1000.00")).toBe(0.18);
    expect(shareOf("1.00", "3.00")).toBe(0.3333);
  });

  it("returns 0 rather than NaN/Infinity when the denominator is zero", () => {
    // A NaN reaching the UI would render as "NaN% of your spend is unclassified".
    expect(shareOf("100.00", "0.00")).toBe(0);
    expect(shareOf("0.00", "0.00")).toBe(0);
  });

  it("returns 0 for a negative denominator", () => {
    expect(shareOf("100.00", "-500.00")).toBe(0);
  });
});

describe("coverageMultiple", () => {
  it("expresses a balance in months of a unit", () => {
    expect(coverageMultiple("9600.00", "3200.00")).toBe("3");
    expect(coverageMultiple("10000.00", "3125.00")).toBe("3.2");
  });

  it("returns null — not 0, not Infinity — when the unit is unknown or zero", () => {
    // "0 months of runway" reads as an emergency; "∞" reads as solved. Neither
    // is what "we could not compute your essential baseline" means.
    expect(coverageMultiple("10000.00", null)).toBeNull();
    expect(coverageMultiple("10000.00", "0.00")).toBeNull();
  });
});
