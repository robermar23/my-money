// @vitest-environment node
import { describe, expect, it } from "vitest";
import { contributionPreviewSchema, contributionRuleSchema, incomeSourceSchema } from "./income.ts";

/**
 * P14-13 — the boundary guards for the income forms.
 *
 * These tests are about the REFINEMENTS, not about re-testing Zod. Each one
 * mirrors a CHECK constraint on the underlying table: if a refinement drifts
 * from its CHECK, the user gets a raw Postgres error instead of a sentence — or
 * worse, a percentage over 100 silently manufactures cost basis.
 */

/** A valid source payload; individual tests override one field at a time. */
const SOURCE = {
  name: "Acme Corp",
  cadence: "biweekly",
  grossPerPeriod: "3000.00",
  currency: "usd",
  anchorDate: "2026-01-02",
  startDate: "2026-01-01",
  endDate: "",
  notes: "",
  active: "on",
};

/** A valid rule payload: 6% employee, 3%-of-gross match capped at 4%. */
const RULE = {
  accountId: "11111111-1111-1111-1111-111111111111",
  holdingId: "",
  employeeBasis: "percent",
  employeeValue: "6",
  pretax: "on",
  matchBasis: "percent_of_gross",
  matchValue: "3",
  matchCapPercent: "4",
  active: "on",
};

/** First issue message, or "" when the parse unexpectedly succeeded. */
function firstError(result: {
  success: boolean;
  error?: { issues: { message: string }[] };
}): string {
  return result.success ? "" : (result.error?.issues[0]?.message ?? "");
}

describe("incomeSourceSchema", () => {
  it("normalises a well-formed source", () => {
    const parsed = incomeSourceSchema.parse(SOURCE);
    expect(parsed.currency).toBe("USD"); // upper-cased at the boundary
    expect(parsed.active).toBe(true); // checkbox "on"
    expect(parsed.endDate).toBeNull(); // blank → NULL, not ""
    expect(parsed.notes).toBeNull();
    expect(parsed.grossPerPeriod).toBe("3000.00"); // still a string — never a float
  });

  it("treats an absent checkbox as inactive rather than an error", () => {
    // An unchecked HTML checkbox is ABSENT from FormData, not "false".
    const parsed = incomeSourceSchema.parse({ ...SOURCE, active: undefined });
    expect(parsed.active).toBe(false);
  });

  it("rejects an end date before the start date", () => {
    const result = incomeSourceSchema.safeParse({
      ...SOURCE,
      startDate: "2026-06-01",
      endDate: "2026-05-31",
    });
    expect(firstError(result)).toMatch(/on or after the start date/i);
  });

  it("accepts an end date equal to the start date", () => {
    // Mirrors the CHECK, which is `>=`: a single-day source is legal.
    const parsed = incomeSourceSchema.parse({
      ...SOURCE,
      startDate: "2026-06-01",
      endDate: "2026-06-01",
    });
    expect(parsed.endDate).toBe("2026-06-01");
  });

  it("allows an anchor date outside the start/end window", () => {
    // The anchor PHASES the schedule; it does not bound it (schedule.ts §1).
    const parsed = incomeSourceSchema.parse({
      ...SOURCE,
      anchorDate: "2020-01-03",
      startDate: "2026-01-01",
    });
    expect(parsed.anchorDate).toBe("2020-01-03");
  });

  it("rejects negative gross pay", () => {
    const result = incomeSourceSchema.safeParse({ ...SOURCE, grossPerPeriod: "-100.00" });
    expect(firstError(result)).toMatch(/zero or more/i);
  });

  it("rejects fractional cents in gross pay", () => {
    // NUMERIC(18,2) would round it; better to refuse than to silently alter pay.
    const result = incomeSourceSchema.safeParse({ ...SOURCE, grossPerPeriod: "3000.005" });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown cadence", () => {
    const result = incomeSourceSchema.safeParse({ ...SOURCE, cadence: "fortnightly" });
    expect(result.success).toBe(false);
  });
});

describe("contributionRuleSchema", () => {
  it("normalises a well-formed rule", () => {
    const parsed = contributionRuleSchema.parse(RULE);
    expect(parsed.holdingId).toBeNull(); // blank → basis-only (ADR-031)
    expect(parsed.matchCapPercent).toBe("4");
    expect(parsed.pretax).toBe(true);
  });

  it("rejects an employee percentage above 100", () => {
    const result = contributionRuleSchema.safeParse({ ...RULE, employeeValue: "101" });
    expect(firstError(result)).toMatch(/cannot exceed 100%/i);
  });

  it("allows a fixed dollar amount above 100 — it is dollars, not a percent", () => {
    const parsed = contributionRuleSchema.parse({
      ...RULE,
      employeeBasis: "amount",
      employeeValue: "750.00",
    });
    expect(parsed.employeeValue).toBe("750.00");
  });

  it("rejects a match percentage above 100 only for percent bases", () => {
    const percent = contributionRuleSchema.safeParse({
      ...RULE,
      matchBasis: "percent_of_contribution",
      matchValue: "150",
    });
    expect(firstError(percent)).toMatch(/cannot exceed 100%/i);

    // The same value as a fixed dollar match is perfectly ordinary.
    const dollars = contributionRuleSchema.parse({
      ...RULE,
      matchBasis: "amount",
      matchValue: "150",
    });
    expect(dollars.matchValue).toBe("150");
  });

  it("rejects a cap above 100% of gross", () => {
    const result = contributionRuleSchema.safeParse({ ...RULE, matchCapPercent: "120" });
    expect(firstError(result)).toMatch(/cap cannot exceed 100%/i);
  });

  it("zeroes the match fields when the basis is 'none'", () => {
    // Stale values from an earlier edit must not survive; `computeContribution`
    // ignores them, but a leftover "3%" in the row would mislead a reader.
    const parsed = contributionRuleSchema.parse({
      ...RULE,
      matchBasis: "none",
      matchValue: "3",
      matchCapPercent: "4",
    });
    expect(parsed.matchValue).toBe("0");
    expect(parsed.matchCapPercent).toBeNull();
  });

  it("rejects negative values on either side", () => {
    expect(contributionRuleSchema.safeParse({ ...RULE, employeeValue: "-6" }).success).toBe(false);
    expect(contributionRuleSchema.safeParse({ ...RULE, matchValue: "-1" }).success).toBe(false);
  });

  it("rejects more than four decimal places (the column scale)", () => {
    const result = contributionRuleSchema.safeParse({ ...RULE, employeeValue: "6.123456" });
    expect(result.success).toBe(false);
  });

  it("requires a real UUID for the account", () => {
    const result = contributionRuleSchema.safeParse({ ...RULE, accountId: "not-a-uuid" });
    expect(firstError(result)).toMatch(/investment account/i);
  });
});

describe("contributionPreviewSchema", () => {
  it("accepts the math fields without an account or holding", () => {
    // A preview computes dollars; it never touches the ledger, so it must stay
    // callable before the user has picked where the money lands.
    const parsed = contributionPreviewSchema.parse({
      incomeSourceId: "22222222-2222-2222-2222-222222222222",
      employeeBasis: "percent",
      employeeValue: "6",
      matchBasis: "none",
      matchValue: "0",
      matchCapPercent: "",
    });
    expect(parsed.employeeValue).toBe("6");
  });

  it("requires an income source to price the percentages against", () => {
    const result = contributionPreviewSchema.safeParse({
      incomeSourceId: "",
      employeeBasis: "percent",
      employeeValue: "6",
      matchBasis: "none",
      matchValue: "0",
    });
    expect(result.success).toBe(false);
  });
});
