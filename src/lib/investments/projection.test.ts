// @vitest-environment node
import { describe, expect, it } from "vitest";
import { goalDate, projectValue } from "./projection.ts";

describe("projectValue", () => {
  it("compounds the current value at the annual rate", () => {
    const series = projectValue("1000", 10, 2);
    expect(series).toEqual([
      { year: 0, value: "1000.00" },
      { year: 1, value: "1100.00" },
      { year: 2, value: "1210.00" },
    ]);
  });

  it("stays flat at a zero growth rate", () => {
    const series = projectValue("5000", 0, 3);
    expect(series.map((p) => p.value)).toEqual(["5000.00", "5000.00", "5000.00", "5000.00"]);
  });

  it("returns just year 0 for a zero-year horizon", () => {
    expect(projectValue("100", 7, 0)).toEqual([{ year: 0, value: "100.00" }]);
  });
});

describe("goalDate", () => {
  const FROM = "2026-01-01";

  it("reaches the target linearly when the rate is zero", () => {
    // 0 + 100/mo, target 1200 → exactly 12 months.
    const result = goalDate("0", "100", 0, "1200", FROM);
    expect(result).not.toBeNull();
    expect(result?.months).toBe(12);
    expect(result?.date).toBe("2027-01-01");
  });

  it("returns months 0 when the target is already met", () => {
    const result = goalDate("5000", "100", 7, "1000", FROM);
    expect(result).toEqual({ months: 0, date: FROM });
  });

  it("returns null when the target is unreachable", () => {
    // No growth, no contributions, below target → never.
    expect(goalDate("100", "0", 0, "1000", FROM)).toBeNull();
  });

  it("reaches the target sooner with positive growth than with contributions alone", () => {
    const withGrowth = goalDate("10000", "0", 10, "11000", FROM);
    expect(withGrowth).not.toBeNull();
    // 10000 compounding monthly at 10%/yr crosses 11000 within ~12 months.
    expect(withGrowth?.months).toBeLessThanOrEqual(12);
    expect(withGrowth?.months).toBeGreaterThan(0);
  });
});
