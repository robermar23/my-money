// @vitest-environment node
import { describe, expect, it } from "vitest";
import { makeAdviceInput, makeCash, makeMember, makeProfile } from "../advice-input.fixture.ts";
import { emergencyFundRule, reserveMonthsFor } from "./emergency-fund.ts";

/*
 * P15-15 — the emergency-fund rule. Pure: no DB, no clock.
 *
 * Two income categories of roughly equal size means "diversified"; one dominant
 * category means "concentrated". Every test below states which it is using,
 * because that single input flips the target between 3 and 6 months.
 */

const DIVERSIFIED = [
  { categoryId: "c1", name: "Salary A", total: "40000.00", excluded: false },
  { categoryId: "c2", name: "Salary B", total: "32000.00", excluded: false },
];

const CONCENTRATED = [
  { categoryId: "c1", name: "Paycheck", total: "70000.00", excluded: false },
  { categoryId: "c2", name: "Interest", total: "2000.00", excluded: false },
];

/** $3,000 essentials, $6,000 net income, and a reserve of the given size. */
function household(reserve: string, extra: Parameters<typeof makeAdviceInput>[0] = {}) {
  return makeAdviceInput({
    netIncome: { trailingMedian: "6000.00", contributingCategories: DIVERSIFIED },
    cash: makeCash(
      [
        { name: "Everyday", subtype: "checking", balance: "2500.00" },
        { name: "Emergency", subtype: "savings", balance: reserve },
      ],
      "3000.00",
    ),
    ...extra,
  });
}

describe("reserveMonthsFor", () => {
  it("defaults to 3 months when income is diversified and nobody depends on it", () => {
    const target = reserveMonthsFor(household("9000.00"));

    expect(target.months).toBe(3);
    expect(target.source).toBe("default");
  });

  it("uses 6 months when a dependent is recorded", () => {
    const target = reserveMonthsFor(
      household("9000.00", {
        household: { members: [makeMember({ id: "kid", label: "Child", isDependent: true })] },
      }),
    );

    expect(target.months).toBe(6);
    expect(target.source).toBe("dependents");
    expect(target.reason).toContain("person depends");
  });

  it("uses 6 months when income is concentrated in a single source", () => {
    const target = reserveMonthsFor(
      household("9000.00", {
        netIncome: { trailingMedian: "6000.00", contributingCategories: CONCENTRATED },
      }),
    );

    expect(target.months).toBe(6);
    expect(target.source).toBe("income_concentration");
  });

  it("ignores excluded income categories when measuring concentration", () => {
    // A one-off bonus category the user excluded from the baseline must not make
    // a genuinely single-source household look diversified.
    const target = reserveMonthsFor(
      household("9000.00", {
        netIncome: {
          trailingMedian: "6000.00",
          contributingCategories: [
            { categoryId: "c1", name: "Paycheck", total: "70000.00", excluded: false },
            { categoryId: "c2", name: "Tax refund", total: "60000.00", excluded: true },
          ],
        },
      }),
    );

    expect(target.months).toBe(6);
    expect(target.source).toBe("income_concentration");
  });

  it("lets the household override win over every heuristic", () => {
    const target = reserveMonthsFor(
      household("9000.00", {
        household: {
          profile: makeProfile({ reserveMonthsOverride: 12 }),
          members: [makeMember({ id: "kid", isDependent: true })],
        },
      }),
    );

    expect(target.months).toBe(12);
    expect(target.source).toBe("override");
  });

  it("does not claim concentration when there is no income history to read", () => {
    const target = reserveMonthsFor(
      household("9000.00", {
        netIncome: { trailingMedian: null, contributingCategories: [] },
      }),
    );

    // With nothing to measure, the rule must not assert "diversified" OR
    // "concentrated" — it falls back to the base target and says why.
    expect(target.months).toBe(3);
    expect(target.source).toBe("default");
  });
});

describe("emergencyFundRule", () => {
  it("reports a funded reserve as ok, not as an action", () => {
    const [rec] = emergencyFundRule.evaluate(household("9000.00"));

    expect(rec?.status).toBe("ok");
    expect(rec?.severity).toBe("info");
    expect(rec?.impact).toBe("0.00");
    expect(rec?.benchmark).toBe("9000.00");
    expect(rec?.title).toContain("3 months");
  });

  it("treats an over-funded reserve as a zero gap, never a negative one", () => {
    const [rec] = emergencyFundRule.evaluate(household("25000.00"));

    expect(rec?.status).toBe("ok");
    expect(rec?.impact).toBe("0.00");
  });

  it("sizes the gap and the months to close it", () => {
    const [rec] = emergencyFundRule.evaluate(household("4000.00"));

    // Target 3 × $3,000 = $9,000; reserve $4,000; gap $5,000. Surplus is
    // $6,000 − $3,000 = $3,000/month, so two months of saving closes it.
    expect(rec?.status).toBe("action");
    expect(rec?.severity).toBe("warning");
    expect(rec?.impact).toBe("5000.00");
    expect(rec?.rationale).toContain("about 2 months");
  });

  it("escalates to critical below one month of essentials", () => {
    const [rec] = emergencyFundRule.evaluate(household("2000.00"));

    // $2,000 against $3,000 of monthly essentials: the next unexpected bill
    // becomes debt. That is a different conversation from "a bit short of six".
    expect(rec?.severity).toBe("critical");
    expect(rec?.status).toBe("action");
  });

  it("says there is no surplus rather than projecting an impossible date", () => {
    const [rec] = emergencyFundRule.evaluate(
      household("1000.00", {
        netIncome: { trailingMedian: "2800.00", contributingCategories: DIVERSIFIED },
      }),
    );

    expect(rec?.rationale).toContain("no surplus");
    expect(rec?.rationale).not.toContain("about");
  });

  it("counts only the reserve tier — not checking, and not a CD", () => {
    const rec = emergencyFundRule.evaluate(
      makeAdviceInput({
        netIncome: { trailingMedian: "6000.00", contributingCategories: DIVERSIFIED },
        cash: makeCash(
          [
            { name: "Everyday", subtype: "checking", balance: "12000.00" },
            { name: "18-mo CD", subtype: "cd", balance: "20000.00" },
            { name: "Emergency", subtype: "savings", balance: "1000.00" },
          ],
          "3000.00",
        ),
      }),
    )[0];

    // $32,000 of cash on hand, but only $1,000 of it is reachable in an
    // emergency without a penalty or defunding this month's bills.
    expect(rec?.currentValue).toBe("1000.00");
    expect(rec?.severity).toBe("critical");
  });

  it("declines to size a fund with no essential baseline", () => {
    const [rec] = emergencyFundRule.evaluate(
      makeAdviceInput({
        essentials: { baseline: null, trailingMedian: null, basisMonths: 0 },
      }),
    );

    expect(rec?.status).toBe("unknown_input");
    expect(rec?.benchmark).toBeNull();
    expect(rec?.suggestedValue).toBeNull();
    expect(rec?.impact).toBeNull();
    // The missing input is named, with a link to where it gets fixed.
    const missing = rec?.inputsUsed.find((i) => i.missing);
    expect(missing?.label).toBe("Essential monthly expenses");
    expect(missing?.value).toBeNull();
    expect(missing?.href).toBe("/settings/categories");
  });

  it("drops confidence when a fifth of spend is unclassified", () => {
    const [rec] = emergencyFundRule.evaluate(
      household("4000.00", {
        essentials: { unclassifiedShare: 0.4 },
      }),
    );

    // The figure is still shown — with the caveat attached, not suppressed.
    expect(rec?.confidence).toBe("low");
    expect(rec?.impact).toBe("5000.00");
  });

  it("drops confidence when the median rests on only a few months", () => {
    const [rec] = emergencyFundRule.evaluate(
      household("4000.00", { essentials: { basisMonths: 4 } }),
    );

    expect(rec?.confidence).toBe("low");
  });

  it("surfaces unclassified cash as an input the user can act on", () => {
    const [rec] = emergencyFundRule.evaluate(
      makeAdviceInput({
        netIncome: { trailingMedian: "6000.00", contributingCategories: DIVERSIFIED },
        cash: makeCash(
          [
            { name: "Emergency", subtype: "savings", balance: "4000.00" },
            { name: "Untriaged", subtype: null, balance: "8000.00" },
          ],
          "3000.00",
        ),
      }),
    );

    const unclassified = rec?.inputsUsed.find((i) => i.label === "Cash not yet classified");
    expect(unclassified?.value).toBe("8000.00");
    expect(rec?.confidence).toBe("low");
  });

  it("keeps a stable recommendation id for the dismissal key", () => {
    const [rec] = emergencyFundRule.evaluate(household("4000.00"));

    expect(rec?.id).toBe("emergency_fund:");
    expect(rec?.subjectKey).toBe("");
  });
});
