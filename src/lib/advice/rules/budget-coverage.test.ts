// @vitest-environment node
import { describe, expect, it } from "vitest";
import { makeAdviceInput, makeCategory, makeMonthlySpend } from "../advice-input.fixture.ts";
import { budgetCoverage, budgetCoverageRule } from "./budget-coverage.ts";

/*
 * P15-25 — the budget-coverage rule. Pure: no DB, no clock.
 *
 * Every fixture below runs to 2026-07 and evaluates at 2026-08-15, so August is
 * an in-progress month that the rule must ignore. That is deliberate: a rule
 * that counts a half-finished month is a rule whose "three months running"
 * streak resets on the first of every month.
 */

const TODAY = "2026-08-15";
const GROCERIES = "cat-groceries";
const DINING = "cat-dining";
const COFFEE = "cat-coffee";

const CATEGORIES = [
  makeCategory({ categoryId: GROCERIES, name: "Groceries", necessity: "essential" }),
  makeCategory({ categoryId: DINING, name: "Dining out", necessity: "discretionary" }),
];

/** Six complete months of the given per-category spend. */
function sixMonths(byCategory: Record<string, string>) {
  return makeMonthlySpend(
    ["2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07"].map((month) => ({
      month,
      byCategory,
      income: "6000.00",
    })),
  );
}

function household(overrides: Parameters<typeof makeAdviceInput>[0] = {}) {
  return makeAdviceInput({
    today: TODAY,
    categories: CATEGORIES,
    monthlySpend: sixMonths({ [GROCERIES]: "600.00", [DINING]: "300.00" }),
    ...overrides,
  });
}

describe("budgetCoverage", () => {
  it("reports a typical month and no target for an unbudgeted category", () => {
    const [top] = budgetCoverage(household());

    expect(top?.categoryId).toBe(GROCERIES);
    expect(top?.target).toBeNull();
    expect(top?.typicalMonthly).toBe("600.00");
    expect(top?.monthsOver).toBe(0);
  });

  it("counts only the trailing run of over-target months", () => {
    const spend = makeMonthlySpend([
      // Two months over, then back under, then three over. The broken streak
      // must not be counted — it is history, not a standing condition.
      { month: "2026-02", byCategory: { [GROCERIES]: "900.00" }, income: "6000.00" },
      { month: "2026-03", byCategory: { [GROCERIES]: "900.00" }, income: "6000.00" },
      { month: "2026-04", byCategory: { [GROCERIES]: "400.00" }, income: "6000.00" },
      { month: "2026-05", byCategory: { [GROCERIES]: "900.00" }, income: "6000.00" },
      { month: "2026-06", byCategory: { [GROCERIES]: "900.00" }, income: "6000.00" },
      { month: "2026-07", byCategory: { [GROCERIES]: "900.00" }, income: "6000.00" },
    ]);

    const [top] = budgetCoverage(
      household({ monthlySpend: spend, budgets: [{ categoryId: GROCERIES, amount: "500.00" }] }),
    );

    expect(top?.monthsOver).toBe(3);
    expect(top?.typicalOverage).toBe("400.00");
  });

  it("treats spend within the tolerance as hitting the target", () => {
    // $530 against a $500 target is 6% over — that is hitting a budget, not
    // missing one, and calling it a miss would make every round target diverge.
    const [top] = budgetCoverage(
      household({
        monthlySpend: sixMonths({ [GROCERIES]: "530.00" }),
        budgets: [{ categoryId: GROCERIES, amount: "500.00" }],
      }),
    );

    expect(top?.monthsOver).toBe(0);
  });

  it("ignores the in-progress month entirely", () => {
    const withPartial = makeMonthlySpend([
      ...["2026-05", "2026-06", "2026-07"].map((month) => ({
        month,
        byCategory: { [GROCERIES]: "900.00" },
        income: "6000.00",
      })),
      // Mid-August: $80 spent so far. Counting it would break the streak and
      // drag the median from $900 to $490.
      { month: "2026-08", byCategory: { [GROCERIES]: "80.00" }, income: "3000.00" },
    ]);

    const [top] = budgetCoverage(
      household({
        monthlySpend: withPartial,
        budgets: [{ categoryId: GROCERIES, amount: "500.00" }],
      }),
    );

    expect(top?.monthsOver).toBe(3);
    expect(top?.typicalMonthly).toBe("900.00");
  });

  it("skips income and transfer categories", () => {
    const coverage = budgetCoverage(
      household({
        categories: [
          makeCategory({ categoryId: "cat-salary", name: "Salary", kind: "income" }),
          makeCategory({ categoryId: "cat-xfer", name: "Card payment", kind: "transfer" }),
        ],
      }),
    );

    expect(coverage).toEqual([]);
  });

  it("orders by typical monthly spend, largest first", () => {
    expect(budgetCoverage(household()).map((c) => c.name)).toEqual(["Groceries", "Dining out"]);
  });
});

describe("budgetCoverageRule — uncovered categories", () => {
  it("flags a material category with no budget and offers the median as a target", () => {
    const recs = budgetCoverageRule.evaluate(household());
    const groceries = recs.find((r) => r.subjectKey === GROCERIES);

    expect(groceries?.status).toBe("action");
    expect(groceries?.severity).toBe("info");
    expect(groceries?.title).toBe("No budget set for Groceries");
    expect(groceries?.suggestedValue).toBe("600.00");
    expect(groceries?.impact).toBe("600.00");
    expect(groceries?.id).toBe(`budget_coverage:${GROCERIES}`);
  });

  it("stays quiet about a category too small to be worth a budget", () => {
    const recs = budgetCoverageRule.evaluate(
      household({
        categories: [...CATEGORIES, makeCategory({ categoryId: COFFEE, name: "Coffee" })],
        monthlySpend: sixMonths({ [GROCERIES]: "600.00", [COFFEE]: "22.00" }),
      }),
    );

    // A $22/month category is not a budgeting gap; listing it is how a
    // recommendations page becomes something the user scrolls past.
    expect(recs.map((r) => r.subjectKey)).not.toContain(COFFEE);
  });

  it("does not flag a category that already has a target it is hitting", () => {
    const recs = budgetCoverageRule.evaluate(
      household({ budgets: [{ categoryId: GROCERIES, amount: "650.00" }] }),
    );

    expect(recs.find((r) => r.subjectKey === GROCERIES)).toBeUndefined();
  });
});

describe("budgetCoverageRule — diverged budgets", () => {
  const diverged = household({
    monthlySpend: sixMonths({ [GROCERIES]: "900.00", [DINING]: "300.00" }),
    budgets: [{ categoryId: GROCERIES, amount: "500.00" }],
  });

  it("reports a standing overage as a warning, not a scolding", () => {
    const rec = budgetCoverageRule.evaluate(diverged).find((r) => r.subjectKey === GROCERIES);

    expect(rec?.status).toBe("action");
    expect(rec?.severity).toBe("warning");
    expect(rec?.title).toContain("6 months running");
    expect(rec?.benchmark).toBe("500.00");
    expect(rec?.currentValue).toBe("900.00");
    expect(rec?.impact).toBe("400.00");
  });

  it("offers to raise the target rather than only asking for restraint", () => {
    const rec = budgetCoverageRule.evaluate(diverged).find((r) => r.subjectKey === GROCERIES);

    expect(rec?.suggestedValue).toBe("900.00");
    expect(rec?.rationale).toContain("stops being read");
  });

  it("says nothing until the streak reaches the threshold", () => {
    const twoOver = makeMonthlySpend([
      { month: "2026-03", byCategory: { [GROCERIES]: "400.00" }, income: "6000.00" },
      { month: "2026-04", byCategory: { [GROCERIES]: "400.00" }, income: "6000.00" },
      { month: "2026-05", byCategory: { [GROCERIES]: "400.00" }, income: "6000.00" },
      { month: "2026-06", byCategory: { [GROCERIES]: "900.00" }, income: "6000.00" },
      { month: "2026-07", byCategory: { [GROCERIES]: "900.00" }, income: "6000.00" },
    ]);

    const recs = budgetCoverageRule.evaluate(
      household({ monthlySpend: twoOver, budgets: [{ categoryId: GROCERIES, amount: "500.00" }] }),
    );

    expect(recs.every((r) => r.status === "ok")).toBe(true);
  });

  it("carries the audit trail: target, typical month, and the streak", () => {
    const rec = budgetCoverageRule.evaluate(diverged).find((r) => r.subjectKey === GROCERIES);
    const labels = rec?.inputsUsed.map((i) => i.label) ?? [];

    expect(labels).toEqual(["Current target", "Typical monthly spend", "Months over target"]);
    expect(rec?.inputsUsed[0]?.href).toBe("/analysis/budgets");
  });
});

describe("budgetCoverageRule — degradation", () => {
  it("reports ok when every material category is budgeted and holding", () => {
    const [rec] = budgetCoverageRule.evaluate(
      household({
        budgets: [
          { categoryId: GROCERIES, amount: "650.00" },
          { categoryId: DINING, amount: "350.00" },
        ],
      }),
    );

    expect(rec?.status).toBe("ok");
    expect(rec?.severity).toBe("info");
    expect(rec?.impact).toBe("0.00");
    expect(rec?.currentValue).toBe("2");
  });

  it("says so plainly when nothing is large enough to budget yet", () => {
    const [rec] = budgetCoverageRule.evaluate(
      household({ monthlySpend: sixMonths({ [GROCERIES]: "20.00", [DINING]: "10.00" }) }),
    );

    expect(rec?.status).toBe("ok");
    expect(rec?.title).toContain("large enough");
  });

  it("stays silent when there are no categories at all", () => {
    expect(budgetCoverageRule.evaluate(household({ categories: [] }))).toEqual([]);
  });

  it("needs three months before it will speak", () => {
    // The divergence streak is undefined below its own threshold, so the rule
    // declares the requirement rather than answering from two months (ADR-034 §7).
    expect(budgetCoverageRule.minMonthsHistory).toBe(3);
  });

  it("keeps a stable id per category for the dismissal key", () => {
    const recs = budgetCoverageRule.evaluate(household());

    // Dismissing "no budget for Groceries" must not dismiss Dining out.
    expect(recs.map((r) => r.id)).toEqual([
      `budget_coverage:${GROCERIES}`,
      `budget_coverage:${DINING}`,
    ]);
  });
});
