// @vitest-environment node
import { describe, expect, it } from "vitest";
import { splitTakeHome } from "./take-home.ts";

/**
 * ADR-049 §1 — stated take-home is projected exactly; only the remainder of the
 * observed median is shared. The fixture is the household that surfaced the
 * bug: every payday showed $2,787.67.
 */

const ERICA = { id: "erica", cadence: "monthly" as const };
const SAM = { id: "sam", cadence: "monthly" as const };
const SALARY = { id: "salary", cadence: "biweekly" as const };
const MEDIAN = "11615.30";

describe("splitTakeHome", () => {
  it("reproduces the old even split when nothing is stated", () => {
    const split = splitTakeHome(
      [
        { ...ERICA, netPerPeriod: null },
        { ...SAM, netPerPeriod: null },
        { ...SALARY, netPerPeriod: null },
      ],
      MEDIAN,
    );
    // 11,615.30 × 12 ÷ 50 pay events.
    expect([...split.perPeriod.values()]).toEqual(["2787.67", "2787.67", "2787.67"]);
    expect(split).toMatchObject({ stated: 0, shared: 3, unpriced: 0 });
  });

  it("projects stated figures exactly and shares only the remainder", () => {
    const split = splitTakeHome(
      [
        { ...ERICA, netPerPeriod: "3251.00" },
        { ...SAM, netPerPeriod: "1625.00" },
        { ...SALARY, netPerPeriod: null },
      ],
      MEDIAN,
    );
    expect(split.perPeriod.get("erica")).toBe("3251.00");
    expect(split.perPeriod.get("sam")).toBe("1625.00");
    // (139,383.60 − 58,512.00) ÷ 26.
    expect(split.perPeriod.get("salary")).toBe("3110.44");
    expect(split).toMatchObject({ stated: 2, shared: 1, unpriced: 0 });
  });

  it("projects stated figures even with no observed income", () => {
    const split = splitTakeHome(
      [
        { ...ERICA, netPerPeriod: "3251.00" },
        { ...SALARY, netPerPeriod: null },
      ],
      null,
    );
    expect(split.perPeriod.get("erica")).toBe("3251.00");
    expect(split.perPeriod.has("salary")).toBe(false);
    expect(split).toMatchObject({ stated: 1, shared: 0, unpriced: 1 });
  });

  it("prices no unstated source when stated figures use up the median", () => {
    const split = splitTakeHome(
      [
        { ...SALARY, netPerPeriod: "6000.00" },
        { ...SAM, netPerPeriod: null },
      ],
      "10000.00",
    );
    expect(split.perPeriod.has("sam")).toBe(false);
    expect(split.unpriced).toBe(1);
  });
});
