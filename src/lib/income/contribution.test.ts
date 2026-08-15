// @vitest-environment node
import { Money } from "@/lib/money/money.ts";
import { describe, expect, it } from "vitest";
import { type ContributionRuleInput, computeContribution } from "./contribution.ts";

const gross = (amount: string): Money => Money.fromString(amount, "USD");

function rule(overrides: Partial<ContributionRuleInput> = {}): ContributionRuleInput {
  return {
    employeeBasis: "percent",
    employeeValue: "6",
    matchBasis: "none",
    matchValue: "0",
    matchCapPercent: null,
    ...overrides,
  };
}

describe("computeContribution — employee side", () => {
  it("takes a percentage of gross", () => {
    const { employee } = computeContribution(rule({ employeeValue: "6" }), gross("3000.00"));
    expect(employee.toString()).toBe("180.00");
  });

  it("takes a fixed dollar amount", () => {
    const result = computeContribution(
      rule({ employeeBasis: "amount", employeeValue: "250" }),
      gross("3000.00"),
    );
    expect(result.employee.toString()).toBe("250.00");
  });

  it("rounds half-even to cents (GAAP default, not half-up)", () => {
    // 2884.62 × 6% = 173.0772 → 173.08
    expect(computeContribution(rule(), gross("2884.62")).employee.toString()).toBe("173.08");
    // 100.05 × 50% = 50.025 → 50.02 under banker's rounding (50.03 under half-up).
    expect(
      computeContribution(rule({ employeeValue: "50" }), gross("100.05")).employee.toString(),
    ).toBe("50.02");
  });

  it("clamps a fixed amount that exceeds gross", () => {
    // A misconfigured rule must not manufacture cost basis out of nothing. The
    // clamp is visible in the P14-15 preview, so the user sees the correction.
    const result = computeContribution(
      rule({ employeeBasis: "amount", employeeValue: "5000" }),
      gross("3000.00"),
    );
    expect(result.employee.toString()).toBe("3000.00");
  });

  it("yields zero for a zero rate and for zero gross", () => {
    expect(computeContribution(rule({ employeeValue: "0" }), gross("3000")).employee.isZero()).toBe(
      true,
    );
    expect(computeContribution(rule(), gross("0")).employee.isZero()).toBe(true);
  });

  it("handles a 100% contribution", () => {
    expect(
      computeContribution(rule({ employeeValue: "100" }), gross("3000.00")).employee.toString(),
    ).toBe("3000.00");
  });
});

describe("computeContribution — employer match", () => {
  it("contributes nothing when the basis is none", () => {
    const result = computeContribution(
      rule({ matchBasis: "none", matchValue: "50" }),
      gross("100"),
    );
    expect(result.employer.isZero()).toBe(true);
  });

  it("matches a percent of gross", () => {
    const result = computeContribution(
      rule({ matchBasis: "percent_of_gross", matchValue: "3" }),
      gross("3000.00"),
    );
    expect(result.employer.toString()).toBe("90.00");
  });

  it("matches a percent of the employee's contribution", () => {
    // 6% of 3000 = 180 employee; a 50% match = 90.
    const result = computeContribution(
      rule({ matchBasis: "percent_of_contribution", matchValue: "50" }),
      gross("3000.00"),
    );
    expect(result.employee.toString()).toBe("180.00");
    expect(result.employer.toString()).toBe("90.00");
  });

  it("matches a fixed dollar amount", () => {
    const result = computeContribution(
      rule({ matchBasis: "amount", matchValue: "125.50" }),
      gross("3000.00"),
    );
    expect(result.employer.toString()).toBe("125.50");
  });

  it("follows the employee contribution to zero on a percent_of_contribution match", () => {
    const result = computeContribution(
      rule({ employeeValue: "0", matchBasis: "percent_of_contribution", matchValue: "100" }),
      gross("3000.00"),
    );
    expect(result.employer.isZero()).toBe(true);
  });
});

describe("computeContribution — match cap", () => {
  it("clamps a match above the cap", () => {
    // 100% of a 6% contribution = 180, capped at 3% of gross = 90.
    const result = computeContribution(
      rule({ matchBasis: "percent_of_contribution", matchValue: "100", matchCapPercent: "3" }),
      gross("3000.00"),
    );
    expect(result.employer.toString()).toBe("90.00");
  });

  it("leaves a match exactly at the cap untouched", () => {
    const result = computeContribution(
      rule({ matchBasis: "percent_of_gross", matchValue: "3", matchCapPercent: "3" }),
      gross("3000.00"),
    );
    expect(result.employer.toString()).toBe("90.00");
  });

  it("leaves a match below the cap untouched", () => {
    const result = computeContribution(
      rule({ matchBasis: "percent_of_gross", matchValue: "2", matchCapPercent: "6" }),
      gross("3000.00"),
    );
    expect(result.employer.toString()).toBe("60.00");
  });

  it("treats a null cap as uncapped", () => {
    const result = computeContribution(
      rule({ matchBasis: "percent_of_gross", matchValue: "50", matchCapPercent: null }),
      gross("3000.00"),
    );
    expect(result.employer.toString()).toBe("1500.00");
  });

  it("zeroes the match at a zero cap", () => {
    const result = computeContribution(
      rule({ matchBasis: "amount", matchValue: "500", matchCapPercent: "0" }),
      gross("3000.00"),
    );
    expect(result.employer.isZero()).toBe(true);
  });
});

describe("computeContribution — total and invariants", () => {
  it("totals employee + employer", () => {
    const result = computeContribution(
      rule({ employeeValue: "6", matchBasis: "percent_of_gross", matchValue: "3" }),
      gross("3000.00"),
    );
    expect(result.total.toString()).toBe("270.00");
    expect(result.total.equals(result.employee.add(result.employer))).toBe(true);
  });

  it("preserves the gross's currency", () => {
    const result = computeContribution(rule(), Money.fromString("3000.00", "EUR"));
    expect(result.employee.currency).toBe("EUR");
    expect(result.total.currency).toBe("EUR");
  });

  it("rejects negative gross and negative rule values", () => {
    expect(() => computeContribution(rule(), gross("-100"))).toThrow(/non-negative/);
    expect(() => computeContribution(rule({ employeeValue: "-1" }), gross("100"))).toThrow(
      /non-negative/,
    );
    expect(() =>
      computeContribution(rule({ matchBasis: "amount", matchValue: "-1" }), gross("100")),
    ).toThrow(/non-negative/);
  });

  it("rejects unknown bases rather than silently contributing zero", () => {
    expect(() =>
      // biome-ignore lint/suspicious/noExplicitAny: exercising the runtime guard on a text column
      computeContribution(rule({ employeeBasis: "bps" as any }), gross("100")),
    ).toThrow(/Unknown employee contribution basis/);
    expect(() =>
      // biome-ignore lint/suspicious/noExplicitAny: exercising the runtime guard on a text column
      computeContribution(rule({ matchBasis: "tiered" as any }), gross("100")),
    ).toThrow(/Unknown employer match basis/);
  });
});
