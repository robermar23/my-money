// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  makeAccount,
  makeAdviceInput,
  makeContributionRule,
  makeYtd,
} from "../advice-input.fixture.ts";
import { employerMatchRule, matchGapFor, matchGaps } from "./employer-match.ts";

/*
 * P15-16 — the employer-match rule. Pure: no DB, no clock.
 *
 * The reference household: $60,000 gross year-to-date on a "100% of the first
 * 4%" formula, so the employer will pay at most $2,400 and the employee has to
 * contribute $2,400 (4%) to collect all of it.
 */

const GROSS = "60000.00";

function gapFor(
  rule: Parameters<typeof matchGapFor>[0],
  ytd: Parameters<typeof matchGapFor>[1],
  today = "2026-07-02",
) {
  return matchGapFor(rule, ytd, today);
}

describe("matchGapFor — percent_of_contribution with a cap", () => {
  const rule = makeContributionRule({
    ruleId: "r1",
    matchBasis: "percent_of_contribution",
    matchValue: "100.0000",
    matchCapPercent: "4.0000",
  });

  it("computes the unclaimed dollars when the employee is under the cap", () => {
    // Contributing 2% of gross collects $1,200 of the $2,400 on offer.
    const gap = gapFor(
      rule,
      makeYtd({
        ruleId: "r1",
        gross: GROSS,
        employee: "1200.00",
        employer: "1200.00",
        periods: 13,
      }),
    );

    expect(gap.status).toBe("gap");
    expect(gap.maxMatchYtd).toBe("2400.00");
    expect(gap.unclaimedYtd).toBe("1200.00");
    expect(gap.requiredEmployeePercent).toBe("4");
    expect(gap.requiredEmployeeYtd).toBe("2400.00");
    expect(gap.currentEmployeePercent).toBe("2");
  });

  it("annualizes the shortfall at the current pace", () => {
    const gap = gapFor(
      rule,
      makeYtd({ ruleId: "r1", gross: GROSS, employee: "1200.00", employer: "1200.00" }),
      // Half the year gone, so a full year is roughly double the YTD shortfall.
      "2026-07-02",
    );

    const projected = Number(gap.projectedAnnualUnclaimed);
    expect(projected).toBeGreaterThan(2350);
    expect(projected).toBeLessThan(2500);
  });

  it("reports maximized at exactly the cap — the boundary, not one cent past it", () => {
    const gap = gapFor(
      rule,
      makeYtd({ ruleId: "r1", gross: GROSS, employee: "2400.00", employer: "2400.00" }),
    );

    expect(gap.status).toBe("maximized");
    expect(gap.unclaimedYtd).toBe("0.00");
  });

  it("reports maximized when the employee contributes well past the cap", () => {
    const gap = gapFor(
      rule,
      makeYtd({ ruleId: "r1", gross: GROSS, employee: "9000.00", employer: "2400.00" }),
    );

    expect(gap.status).toBe("maximized");
    expect(gap.unclaimedYtd).toBe("0.00");
  });

  it("handles a partial match rate — 50% of the first 3% needs a 6% contribution", () => {
    const partial = makeContributionRule({
      ruleId: "r2",
      matchBasis: "percent_of_contribution",
      matchValue: "50.0000",
      matchCapPercent: "3.0000",
    });
    const gap = gapFor(
      partial,
      makeYtd({ ruleId: "r2", gross: GROSS, employee: "1200.00", employer: "600.00" }),
    );

    // Cap is 3% of $60,000 = $1,800. At a 50% rate that takes a 6% employee
    // contribution, not 3% — the arithmetic users most often get wrong.
    expect(gap.maxMatchYtd).toBe("1800.00");
    expect(gap.requiredEmployeePercent).toBe("6");
    expect(gap.unclaimedYtd).toBe("1200.00");
  });
});

describe("matchGapFor — the shapes with no computable gap", () => {
  it("reports no_match for a formula with no employer contribution", () => {
    const gap = gapFor(
      makeContributionRule({ ruleId: "r1", matchBasis: "none", matchValue: "0" }),
      makeYtd({ ruleId: "r1", gross: GROSS, employee: "3600.00" }),
    );

    expect(gap.status).toBe("no_match");
    expect(gap.unclaimedYtd).toBe("0.00");
  });

  it("reports no_match when the match rate is zero despite a basis being set", () => {
    const gap = gapFor(
      makeContributionRule({
        ruleId: "r1",
        matchBasis: "percent_of_contribution",
        matchValue: "0",
        matchCapPercent: "4.0000",
      }),
      makeYtd({ ruleId: "r1", gross: GROSS, employee: "3600.00" }),
    );

    expect(gap.status).toBe("no_match");
  });

  it("reports maximized for percent_of_gross — the employee cannot change it", () => {
    const gap = gapFor(
      makeContributionRule({
        ruleId: "r1",
        matchBasis: "percent_of_gross",
        matchValue: "3.0000",
        matchCapPercent: null,
      }),
      makeYtd({ ruleId: "r1", gross: GROSS, employee: "600.00", employer: "1800.00" }),
    );

    expect(gap.status).toBe("maximized");
    expect(gap.unclaimedYtd).toBe("0.00");
  });

  it("reports maximized for a flat dollar match", () => {
    const gap = gapFor(
      makeContributionRule({
        ruleId: "r1",
        matchBasis: "amount",
        matchValue: "100.0000",
        matchCapPercent: null,
      }),
      makeYtd({ ruleId: "r1", gross: GROSS, employee: "600.00", employer: "1300.00" }),
    );

    expect(gap.status).toBe("maximized");
  });

  it("reports uncapped when a proportional match has no ceiling", () => {
    const gap = gapFor(
      makeContributionRule({
        ruleId: "r1",
        matchBasis: "percent_of_contribution",
        matchValue: "50.0000",
        matchCapPercent: null,
      }),
      makeYtd({ ruleId: "r1", gross: GROSS, employee: "3600.00", employer: "1800.00" }),
    );

    // There is no ceiling to fall short of; the binding constraint is the
    // statutory limit, which belongs to the pacing rule.
    expect(gap.status).toBe("uncapped");
    expect(gap.unclaimedYtd).toBeNull();
  });

  it("reports unknown_input when no pay periods have been materialized", () => {
    const gap = gapFor(makeContributionRule({ ruleId: "r1" }), undefined);

    // A 100% shortfall against $0 of gross is not a finding, it is a division by
    // zero wearing a suit.
    expect(gap.status).toBe("unknown_input");
    expect(gap.unclaimedYtd).toBeNull();
    expect(gap.currentEmployeePercent).toBeNull();
  });
});

describe("matchGaps", () => {
  it("skips inactive rules and orders by the size of the gap", () => {
    const input = makeAdviceInput({
      contributionRules: [
        makeContributionRule({ ruleId: "small", accountName: "Small plan" }),
        makeContributionRule({ ruleId: "big", accountName: "Big plan" }),
        makeContributionRule({ ruleId: "paused", accountName: "Paused plan", active: false }),
      ],
      contributionsYtd: [
        makeYtd({ ruleId: "small", gross: "30000.00", employee: "900.00", employer: "900.00" }),
        makeYtd({ ruleId: "big", gross: GROSS, employee: "600.00", employer: "600.00" }),
        makeYtd({ ruleId: "paused", gross: GROSS, employee: "0.00", employer: "0.00" }),
      ],
    });

    const gaps = matchGaps(input);

    // Small: cap $1,200, claimed $900 → $300 unclaimed.
    // Big:   cap $2,400, claimed $600 → $1,800 unclaimed.
    expect(gaps.map((g) => g.ruleId)).toEqual(["big", "small"]);
    expect(gaps[0]?.unclaimedYtd).toBe("1800.00");
    expect(gaps[1]?.unclaimedYtd).toBe("300.00");
  });
});

describe("employerMatchRule", () => {
  const withGap = makeAdviceInput({
    contributionRules: [makeContributionRule({ ruleId: "r1", accountName: "Fidelity 401(k)" })],
    contributionsYtd: [
      makeYtd({
        ruleId: "r1",
        gross: GROSS,
        employee: "1200.00",
        employer: "1200.00",
        periods: 13,
      }),
    ],
  });

  it("recommends the exact contribution percentage that closes the gap", () => {
    const [rec] = employerMatchRule.evaluate(withGap);

    expect(rec?.status).toBe("action");
    expect(rec?.severity).toBe("warning");
    expect(rec?.impact).toBe("1200.00");
    expect(rec?.title).toContain("4%");
    expect(rec?.subjectKey).toBe("r1");
    expect(rec?.id).toBe("employer_match:r1");
  });

  it("shows the three ledger figures it read", () => {
    const [rec] = employerMatchRule.evaluate(withGap);
    const labels = rec?.inputsUsed.map((i) => i.label) ?? [];

    expect(labels).toContain("Gross pay this year");
    expect(labels).toContain("Your contributions this year");
    expect(labels).toContain("Employer contributions this year");
    expect(labels).toContain("Match cap");
  });

  it("runs with no history at all — a match gap is real in week two", () => {
    expect(employerMatchRule.minMonthsHistory).toBe(0);
  });

  it("stays silent about a formula that offers no match", () => {
    const recs = employerMatchRule.evaluate(
      makeAdviceInput({
        contributionRules: [makeContributionRule({ ruleId: "r1", matchBasis: "none" })],
        contributionsYtd: [makeYtd({ ruleId: "r1", gross: GROSS, employee: "3600.00" })],
      }),
    );

    expect(recs).toHaveLength(0);
  });

  it("says so when the match is fully captured", () => {
    const [rec] = employerMatchRule.evaluate(
      makeAdviceInput({
        contributionRules: [makeContributionRule({ ruleId: "r1" })],
        contributionsYtd: [
          makeYtd({ ruleId: "r1", gross: GROSS, employee: "3600.00", employer: "2400.00" }),
        ],
      }),
    );

    expect(rec?.status).toBe("ok");
    expect(rec?.severity).toBe("info");
    expect(rec?.impact).toBe("0.00");
  });

  it("flags a workplace account with no contribution rule recorded", () => {
    const [rec] = employerMatchRule.evaluate(
      makeAdviceInput({
        accounts: [
          makeAccount({
            accountId: "a1",
            type: "investment",
            name: "401(k)",
            taxTreatment: "tax_deferred",
          }),
        ],
      }),
    );

    expect(rec?.status).toBe("unknown_input");
    expect(rec?.inputsUsed[0]?.missing).toBe(true);
    expect(rec?.inputsUsed[0]?.href).toBe("/settings/income");
  });

  it("stays silent when there is no workplace account to match into", () => {
    const recs = employerMatchRule.evaluate(
      makeAdviceInput({
        accounts: [makeAccount({ accountId: "a1", type: "depository", subtype: "checking" })],
      }),
    );

    expect(recs).toHaveLength(0);
  });
});
