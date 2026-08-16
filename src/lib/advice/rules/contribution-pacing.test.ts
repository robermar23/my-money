// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  makeAdviceInput,
  makeContributionRule,
  makeMember,
  makeYtd,
} from "../advice-input.fixture.ts";
import { contributionPacingRule, deferralPacing } from "./contribution-pacing.ts";

/*
 * P15-21 — contribution pacing (ADR-034 §5).
 *
 * The 2026 elective-deferral limit is $24,500. The reference date is 1 July, so
 * roughly half the year is behind the year-to-date figures and a full-year
 * projection is about double them.
 */

const MID_YEAR = "2026-07-01";

function household(ytd: string, extra: Parameters<typeof makeAdviceInput>[0] = {}) {
  return makeAdviceInput({
    today: MID_YEAR,
    contributionYear: 2026,
    contributionRules: [makeContributionRule({ ruleId: "r1" })],
    contributionsYtd: [
      makeYtd({ ruleId: "r1", employee: ytd, employer: "1200.00", gross: "60000.00", periods: 13 }),
    ],
    ...extra,
  });
}

describe("deferralPacing", () => {
  it("returns null for an unconfigured year — the whole point of ADR-034 §5", () => {
    const pacing = deferralPacing(
      household("12000.00", { today: "2099-07-01", contributionYear: 2099 }),
    );

    expect(pacing).toBeNull();
  });

  it("paces year-to-date employee dollars against the year's ceiling", () => {
    const pacing = deferralPacing(household("12000.00"));

    expect(pacing?.limit).toBe("24500.00");
    expect(pacing?.employeeYtd).toBe("12000.00");
    expect(pacing?.remaining).toBe("12500.00");
    // Half a year in, $12,000 projects to roughly $24,000 — just short.
    expect(Number(pacing?.projectedAnnual)).toBeGreaterThan(23500);
    expect(Number(pacing?.projectedAnnual)).toBeLessThan(24500);
    expect(pacing?.pace).toBe("under");
  });

  it("counts the employee's dollars only — the match has its own ceiling", () => {
    const pacing = deferralPacing(household("12000.00"));

    // $1,200 of employer money is in the ledger and must not appear here;
    // folding it in would understate the user's remaining room.
    expect(pacing?.employeeYtd).toBe("12000.00");
  });

  it("excludes payroll HSA contributions, which have their own limit", () => {
    const pacing = deferralPacing(
      makeAdviceInput({
        today: MID_YEAR,
        contributionRules: [makeContributionRule({ ruleId: "r1" })],
        contributionsYtd: [
          makeYtd({ ruleId: "r1", employee: "10000.00", periods: 13 }),
          makeYtd({
            ruleId: "hsa",
            accountId: "acct-hsa",
            taxTreatment: "hsa",
            employee: "2000.00",
            periods: 13,
          }),
        ],
      }),
    );

    expect(pacing?.employeeYtd).toBe("10000.00");
  });

  it("sums a Roth 401(k) and a pre-tax 401(k) against the one shared limit", () => {
    const pacing = deferralPacing(
      makeAdviceInput({
        today: MID_YEAR,
        contributionRules: [makeContributionRule({ ruleId: "r1" })],
        contributionsYtd: [
          makeYtd({
            ruleId: "pretax",
            taxTreatment: "tax_deferred",
            employee: "6000.00",
            periods: 13,
          }),
          makeYtd({ ruleId: "roth", taxTreatment: "roth", employee: "6000.00", periods: 13 }),
        ],
      }),
    );

    expect(pacing?.employeeYtd).toBe("12000.00");
  });

  it("reports catch-up availability without raising the ceiling", () => {
    const pacing = deferralPacing(
      household("12000.00", {
        household: { members: [makeMember({ id: "a", birthYear: 1970 })] },
      }),
    );

    // 2026 − 1970 = 56, past the catch-up age. The extra room is REPORTED, and
    // the limit stays at the base figure: the app cannot tell which household
    // member owns this plan, and guessing would make a real over-contribution
    // look fine.
    expect(pacing?.catchUpAvailable).toBe(true);
    expect(pacing?.catchUpAmount).toBe("8000.00");
    expect(pacing?.limit).toBe("24500.00");
  });

  it("does not offer catch-up room to a dependent's birth year", () => {
    const pacing = deferralPacing(
      household("12000.00", {
        household: {
          members: [makeMember({ id: "grandparent", birthYear: 1950, isDependent: true })],
        },
      }),
    );

    expect(pacing?.catchUpAvailable).toBe(false);
  });

  it("detects being over the limit", () => {
    const pacing = deferralPacing(household("26000.00"));

    expect(pacing?.pace).toBe("over_limit");
    expect(pacing?.remaining).toBe("0.00");
  });

  it("detects being on track", () => {
    const pacing = deferralPacing(household("14000.00"));

    // Half a year in, $14,000 projects to about $28,000 — past the ceiling.
    expect(pacing?.pace).toBe("on_track");
  });
});

describe("contributionPacingRule", () => {
  it("emits NOTHING for an unconfigured year", () => {
    // The test that stops January from lying: no recommendation at all rather
    // than a confident percentage against last year's ceiling. The waterfall
    // rung carries the one explanatory sentence.
    const recs = contributionPacingRule.evaluate(
      household("12000.00", { today: "2099-07-01", contributionYear: 2099 }),
    );

    expect(recs).toEqual([]);
  });

  it("quantifies the room being left unused", () => {
    const [rec] = contributionPacingRule.evaluate(household("9000.00"));

    expect(rec?.status).toBe("action");
    expect(rec?.severity).toBe("info");
    expect(rec?.benchmark).toBe("24500.00");
    expect(rec?.rationale).toContain("diagnostic, not a target");
    expect(Number(rec?.impact)).toBeGreaterThan(0);
  });

  it("frames being under pace as information, never as a failure", () => {
    const [rec] = contributionPacingRule.evaluate(household("2000.00"));

    // Not contributing the maximum is a cash-flow decision, not a mistake.
    expect(rec?.severity).toBe("info");
  });

  it("says so when the household is on pace", () => {
    const [rec] = contributionPacingRule.evaluate(household("14000.00"));

    expect(rec?.status).toBe("ok");
    expect(rec?.impact).toBe("0.00");
  });

  it("warns when contributions have already passed the limit", () => {
    const [rec] = contributionPacingRule.evaluate(household("26000.00"));

    expect(rec?.severity).toBe("warning");
    expect(rec?.status).toBe("action");
    expect(rec?.impact).toBe("1500.00");
    expect(rec?.rationale).toContain("plan administrator");
  });

  it("softens the over-limit finding when catch-up room may apply", () => {
    const [rec] = contributionPacingRule.evaluate(
      household("26000.00", {
        household: { members: [makeMember({ id: "a", birthYear: 1970 })] },
      }),
    );

    expect(rec?.rationale).toContain("catch-up contribution");
    expect(rec?.confidence).toBe("low");
  });

  it("drops confidence on a projection built on very few pay periods", () => {
    const [rec] = contributionPacingRule.evaluate(
      makeAdviceInput({
        today: "2026-02-01",
        contributionRules: [makeContributionRule({ ruleId: "r1" })],
        contributionsYtd: [makeYtd({ ruleId: "r1", employee: "800.00", periods: 2 })],
      }),
    );

    // Two pay periods extrapolated across a year is a wild number. It is still
    // shown — with the caveat attached.
    expect(rec?.confidence).toBe("low");
  });

  it("reports unknown_input when a rule exists but nothing has been paid yet", () => {
    const [rec] = contributionPacingRule.evaluate(
      makeAdviceInput({
        today: MID_YEAR,
        contributionRules: [makeContributionRule({ ruleId: "r1" })],
        contributionsYtd: [],
      }),
    );

    expect(rec?.status).toBe("unknown_input");
    expect(rec?.inputsUsed.find((i) => i.missing)?.label).toBe("Contributions this year");
  });

  it("stays silent for a household with no payroll contribution rules", () => {
    expect(
      contributionPacingRule.evaluate(
        makeAdviceInput({ today: MID_YEAR, contributionRules: [], contributionsYtd: [] }),
      ),
    ).toEqual([]);
  });

  it("shows the catch-up room as a separate input, not folded into the limit", () => {
    const [rec] = contributionPacingRule.evaluate(
      household("9000.00", {
        household: { members: [makeMember({ id: "a", birthYear: 1970 })] },
      }),
    );
    const catchUp = rec?.inputsUsed.find((i) => i.label === "Catch-up room available");

    expect(catchUp?.value).toBe("8000.00");
    expect(catchUp?.source).toContain("not included in the limit above");
  });
});
