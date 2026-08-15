// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  type SavingsRateContribution,
  type SavingsRateSource,
  savingsRate,
} from "./savings-rate.ts";

function source(overrides: Partial<SavingsRateSource> = {}): SavingsRateSource {
  return {
    cadence: "biweekly",
    grossPerPeriod: "3000.00",
    currency: "USD",
    active: true,
    ...overrides,
  };
}

function contribution(
  employeeAmount: string,
  employerAmount = "0.00",
  currency = "USD",
): SavingsRateContribution {
  return { employeeAmount, employerAmount, currency };
}

describe("savingsRate", () => {
  it("annualizes gross by cadence", () => {
    expect(
      savingsRate(
        [source({ cadence: "weekly", grossPerPeriod: "1000" })],
        [],
      ).annualGross.toString(),
    ).toBe("52000.00");
    expect(
      savingsRate(
        [source({ cadence: "biweekly", grossPerPeriod: "1000" })],
        [],
      ).annualGross.toString(),
    ).toBe("26000.00");
    expect(
      savingsRate(
        [source({ cadence: "semimonthly", grossPerPeriod: "1000" })],
        [],
      ).annualGross.toString(),
    ).toBe("24000.00");
    expect(
      savingsRate(
        [source({ cadence: "monthly", grossPerPeriod: "1000" })],
        [],
      ).annualGross.toString(),
    ).toBe("12000.00");
  });

  it("sums gross across multiple sources", () => {
    const result = savingsRate(
      [
        source({ cadence: "biweekly", grossPerPeriod: "3000" }),
        source({ cadence: "monthly", grossPerPeriod: "1000" }),
      ],
      [],
    );
    expect(result.annualGross.toString()).toBe("90000.00");
  });

  it("excludes inactive sources from gross", () => {
    const result = savingsRate(
      [source({ grossPerPeriod: "3000" }), source({ grossPerPeriod: "9999", active: false })],
      [],
    );
    expect(result.annualGross.toString()).toBe("78000.00");
  });

  it("computes the rate from the employee side only", () => {
    // 26 × 3000 = 78,000 gross; 26 × 180 = 4,680 employee → 6%.
    const contributions = Array.from({ length: 26 }, () => contribution("180.00", "90.00"));
    const result = savingsRate([source()], contributions);
    expect(result.annualEmployee.toString()).toBe("4680.00");
    expect(result.annualEmployer.toString()).toBe("2340.00");
    expect(result.ratePct).toBe("6"); // the match is NOT in the numerator
  });

  it("rounds the rate to two decimals", () => {
    // 1000 / 78000 = 1.28205…%
    const result = savingsRate([source()], [contribution("1000.00")]);
    expect(result.ratePct).toBe("1.28");
  });

  it("returns a null rate when there is no gross to divide by", () => {
    expect(savingsRate([], [contribution("500.00")]).ratePct).toBeNull();
    expect(savingsRate([source({ grossPerPeriod: "0" })], []).ratePct).toBeNull();
    expect(savingsRate([source({ active: false })], []).ratePct).toBeNull();
  });

  it("returns zeros for an empty ledger", () => {
    const result = savingsRate([source()], []);
    expect(result.annualEmployee.isZero()).toBe(true);
    expect(result.annualEmployer.isZero()).toBe(true);
    expect(result.ratePct).toBe("0");
  });

  it("reports a rate above 100% rather than clamping when a source is retired", () => {
    // Contributions from a now-inactive paycheck are still real dollars saved.
    const result = savingsRate(
      [source({ grossPerPeriod: "1000", cadence: "monthly" })],
      [contribution("20000.00")],
    );
    expect(result.ratePct).toBe("166.67");
  });

  it("refuses to mix currencies instead of silently adding them", () => {
    expect(() => savingsRate([source({ currency: "EUR" })], [])).toThrow(/fx_rates/);
    expect(() => savingsRate([source()], [contribution("10.00", "0.00", "EUR")])).toThrow(
      /fx_rates/,
    );
  });

  it("honours a non-USD base currency", () => {
    const result = savingsRate(
      [source({ currency: "EUR", cadence: "monthly", grossPerPeriod: "1000" })],
      [contribution("100.00", "0.00", "EUR")],
      "EUR",
    );
    expect(result.annualGross.currency).toBe("EUR");
    expect(result.annualGross.toString()).toBe("12000.00");
    expect(result.ratePct).toBe("0.83");
  });
});
