// @vitest-environment node
import { describe, expect, it } from "vitest";
import { residualDailyRate } from "./residual.ts";

/**
 * P16-15 — the residual rate (ADR-038 §2).
 *
 * These cases ARE the specification, in the plan's own words. The defect this
 * function exists to prevent is not a crash: it is taking a total-spend
 * run-rate AND adding the mortgage on the 1st, which counts the mortgage twice
 * and makes safe-to-spend badly, silently low — the direction that trains a
 * household to ignore the feature.
 */

describe("residualDailyRate", () => {
  it("returns zero when every dollar of spend is a confirmed obligation", () => {
    // The pure double-count case. If this returned the run-rate, the projection
    // would charge the household for its bills twice over.
    const result = residualDailyRate("3000.00", "3000.00", 30);

    expect(result.dailyRate).toBe("0.00");
    expect(result.coverage).toBe("1.0000");
    expect(result.clampedAtZero).toBe(false);
  });

  it("returns the full run-rate when nothing is attributed", () => {
    const result = residualDailyRate("3000.00", "0.00", 30);

    expect(result.dailyRate).toBe("100.00");
    expect(result.coverage).toBe("0.0000");
  });

  it("subtracts only the attributed share in the mixed case", () => {
    // $4,500 observed over 90 days, of which $2,700 is confirmed obligations.
    // Residual is $1,800 / 90 = $20/day, and coverage is 60%.
    const result = residualDailyRate("4500.00", "2700.00", 90);

    expect(result.dailyRate).toBe("20.00");
    expect(result.coverage).toBe("0.6000");
    expect(result.clampedAtZero).toBe(false);
  });

  it("clamps to zero on over-attribution and caps coverage at one", () => {
    // Over-attribution means matching claimed more than the household spent —
    // coverage is wrong, not that they earn money by existing.
    const result = residualDailyRate("3000.00", "3600.00", 30);

    expect(result.dailyRate).toBe("0.00");
    expect(result.coverage).toBe("1.0000");
    expect(result.clampedAtZero).toBe(true);
  });

  it("reports coverage as null, not zero, when there is nothing to attribute", () => {
    // "Nothing to measure" and "we measured and found none of it" are different
    // statements, and the UI renders them differently.
    const result = residualDailyRate("0.00", "0.00", 30);

    expect(result.dailyRate).toBe("0.00");
    expect(result.coverage).toBeNull();
  });

  it("keeps coverage at four decimal places so a UI percentage is not pre-rounded", () => {
    const result = residualDailyRate("3000.00", "1000.00", 30);

    expect(result.coverage).toBe("0.3333");
  });

  it("is penny-exact where a float would drift", () => {
    // 0.1 + 0.2 !== 0.3 in IEEE 754. Through Decimal the subtraction is exact.
    const result = residualDailyRate("0.30", "0.10", 1);

    expect(result.dailyRate).toBe("0.20");
  });

  it("never returns a negative rate, whatever the inputs", () => {
    for (const attributed of ["3000.01", "10000.00", "999999.99"]) {
      const result = residualDailyRate("3000.00", attributed, 30);
      expect(result.dailyRate).toBe("0.00");
      expect(result.clampedAtZero).toBe(true);
    }
  });

  it("rounds the daily rate down to cents rather than carrying a fraction", () => {
    // $100 over 3 days is $33.333…; the rate is a per-day money figure and is
    // stated in cents. Erring low by a fraction of a cent per day is the safe
    // direction for a residual that is subtracted from a balance.
    const result = residualDailyRate("100.00", "0.00", 3);

    expect(result.dailyRate).toBe("33.33");
  });

  it("refuses a window of zero days instead of dividing by it", () => {
    expect(() => residualDailyRate("3000.00", "0.00", 0)).toThrow(/window/i);
    expect(() => residualDailyRate("3000.00", "0.00", -30)).toThrow(/window/i);
  });

  it("refuses negative inputs — spend and attribution are magnitudes", () => {
    expect(() => residualDailyRate("-3000.00", "0.00", 30)).toThrow(/magnitude/i);
    expect(() => residualDailyRate("3000.00", "-100.00", 30)).toThrow(/magnitude/i);
  });
});
