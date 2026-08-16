import { Money } from "@/lib/money/money.ts";
// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  CASH_DRAG_MINIMUM_EXCESS,
  DEFAULT_HIGH_INTEREST_THRESHOLD_APR,
  DEFAULT_RESERVE_MONTHS,
  DEFAULT_SPLIT,
  ELEVATED_RESERVE_MONTHS,
  STARTER_BUFFER,
  configuredLimitYears,
  limitsForYear,
} from "./constants.ts";

/*
 * P15-14 — the constants gate (ADR-034 §5).
 *
 * The unconfigured-year test below is the one that stops January from lying: it
 * is the difference between "we cannot tell you whether you are on pace for 2027"
 * and confidently pacing the user against 2026's ceiling for a whole year.
 */

describe("limitsForYear", () => {
  it("returns the configured limits for a known year", () => {
    const limits = limitsForYear(2026);

    expect(limits).not.toBeNull();
    expect(limits?.year).toBe(2026);
    expect(limits?.electiveDeferral).toBe("24500.00");
    expect(limits?.iraContribution).toBe("7500.00");
    expect(limits?.hsaSelfOnly).toBe("4400.00");
    expect(limits?.hsaFamily).toBe("8750.00");
  });

  it("returns null for an unconfigured FUTURE year — never last year's dollars", () => {
    // The load-bearing assertion of the whole module. If this ever starts
    // returning the most recent configured year, every pacing figure silently
    // becomes wrong on 1 January and nothing surfaces it.
    expect(limitsForYear(2099)).toBeNull();

    const latest = configuredLimitYears().at(-1) ?? 0;
    expect(limitsForYear(latest + 1)).toBeNull();
  });

  it("returns null for a year before the table starts", () => {
    // A backfilled 2019 paycheck must not be paced against 2024's limit either.
    expect(limitsForYear(2019)).toBeNull();
  });

  it("does not resolve keys through string coercion or prototype pollution", () => {
    // A Map keyed by number, not an object literal: `limitsForYear` can never be
    // tricked into returning `Object.prototype.toString` for a weird year.
    expect(limitsForYear(Number.NaN)).toBeNull();
    expect(limitsForYear(0)).toBeNull();
  });

  it("keeps every configured year internally consistent", () => {
    for (const year of configuredLimitYears()) {
      const limits = limitsForYear(year);
      expect(limits).not.toBeNull();
      if (!limits) continue;

      // Every ceiling is a positive money string, parseable by Money.
      for (const value of [
        limits.electiveDeferral,
        limits.electiveDeferralCatchUp,
        limits.iraContribution,
        limits.iraCatchUp,
        limits.hsaSelfOnly,
        limits.hsaFamily,
        limits.hsaCatchUp,
      ]) {
        expect(Money.fromString(value, "USD").isNegative()).toBe(false);
        expect(value).toMatch(/^\d+\.\d{2}$/);
      }

      // Family HSA coverage is always the larger of the two.
      const gap = Money.fromString(limits.hsaFamily, "USD").sub(
        Money.fromString(limits.hsaSelfOnly, "USD"),
      );
      expect(gap.isNegative()).toBe(false);

      // The HSA catch-up starts later than the deferral catch-up.
      expect(limits.hsaCatchUpAge).toBeGreaterThan(limits.catchUpAge);
    }
  });

  it("lists configured years in ascending order", () => {
    const years = configuredLimitYears();

    expect(years.length).toBeGreaterThan(0);
    expect([...years].sort((a, b) => a - b)).toEqual(years);
  });
});

describe("default benchmarks", () => {
  it("brackets the conventional 3–6 month reserve range", () => {
    expect(DEFAULT_RESERVE_MONTHS).toBe(3);
    expect(ELEVATED_RESERVE_MONTHS).toBe(6);
    expect(ELEVATED_RESERVE_MONTHS).toBeGreaterThan(DEFAULT_RESERVE_MONTHS);
  });

  it("expresses the high-interest threshold as a decimal FRACTION", () => {
    // Units guard (Batch 1 convention): an APR is a fraction, so 7% is 0.07 and
    // never "7". A units slip here would flag every debt in the household as
    // high-interest, or none of them.
    const threshold = Number(DEFAULT_HIGH_INTEREST_THRESHOLD_APR);
    expect(threshold).toBeGreaterThan(0);
    expect(threshold).toBeLessThan(1);
  });

  it("expresses the default split as percentages summing to 100", () => {
    const total = Money.fromString(DEFAULT_SPLIT.needs, "USD")
      .add(Money.fromString(DEFAULT_SPLIT.wants, "USD"))
      .add(Money.fromString(DEFAULT_SPLIT.savings, "USD"));

    expect(total.toString()).toBe("100.00");
  });

  it("keeps the starter buffer well below any plausible full reserve", () => {
    const starter = Money.fromString(STARTER_BUFFER, "USD");
    const drag = Money.fromString(CASH_DRAG_MINIMUM_EXCESS, "USD");

    expect(starter.isNegative()).toBe(false);
    // The first rung must be reachable in weeks, not months — otherwise it is
    // just the reserve rung again with a smaller number.
    expect(starter.sub(drag).isNegative()).toBe(true);
  });
});
