// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  makeAdviceInput,
  makeCash,
  makeContributionRule,
  makeDebt,
  makeYtd,
} from "./advice-input.fixture.ts";
import { ADVICE_RULES, type DismissalRecord, runAdvice, sortRecommendations } from "./engine.ts";
import type { Recommendation } from "./types.ts";

/*
 * P15-23 — the engine. Pure: no DB, and the clock is injected.
 */

const NOW = new Date("2026-08-15T12:00:00Z");

const DIVERSIFIED = [
  { categoryId: "c1", name: "Salary A", total: "40000.00", excluded: false },
  { categoryId: "c2", name: "Salary B", total: "32000.00", excluded: false },
];

/** A household with something for several rules to say. */
function household(extra: Parameters<typeof makeAdviceInput>[0] = {}) {
  return makeAdviceInput({
    netIncome: { trailingMedian: "6000.00", contributingCategories: DIVERSIFIED },
    cash: makeCash(
      [
        { name: "Everyday", subtype: "checking", balance: "2500.00" },
        { name: "Emergency", subtype: "savings", balance: "1500.00" },
      ],
      "3000.00",
    ),
    debts: [
      makeDebt({
        accountId: "card",
        accountName: "Rewards card",
        balance: "4000.00",
        apr: "0.249900",
        creditLimit: "5000.00",
      }),
    ],
    contributionRules: [makeContributionRule({ ruleId: "r1" })],
    contributionsYtd: [
      makeYtd({
        ruleId: "r1",
        gross: "60000.00",
        employee: "1200.00",
        employer: "1200.00",
        periods: 13,
      }),
    ],
    ...extra,
  });
}

function rec(partial: Partial<Recommendation> & { id: string }): Recommendation {
  return {
    ruleId: "emergency_fund",
    subjectKey: "",
    severity: "info",
    status: "action",
    title: "Title",
    rationale: "",
    heuristic: "",
    benchmark: null,
    currentValue: null,
    suggestedValue: null,
    impact: null,
    inputsUsed: [],
    confidence: "high",
    ...partial,
  };
}

describe("ADVICE_RULES", () => {
  it("registers every rule exactly once", () => {
    const ids = ADVICE_RULES.map((r) => r.id);

    expect(ids).toEqual([
      "emergency_fund",
      "employer_match",
      "high_interest_debt",
      "credit_utilization",
      "contribution_pacing",
      "cash_drag",
      "budget_coverage",
      "needs_wants_split",
      "waterfall",
    ]);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("runAdvice — history gating (ADR-034 §7)", () => {
  it("runs every rule on a mature install", () => {
    const result = runAdvice(household({ historyMonths: 24 }), [], NOW);

    expect(result.gated).toHaveLength(0);
    expect(result.recommendations.length).toBeGreaterThan(0);
    expect(result.waterfall).toHaveLength(7);
  });

  it("gates the baseline-dependent rules on a two-month-old install", () => {
    const result = runAdvice(household({ historyMonths: 2 }), [], NOW);

    // A two-month-old install must not confidently size an emergency fund from
    // two months of spending, suggest a budget from it, or state a 50/30/20
    // proportion. Rules that read only recorded terms still run.
    expect(result.gated.map((g) => g.ruleId).sort()).toEqual([
      "budget_coverage",
      "cash_drag",
      "emergency_fund",
      "needs_wants_split",
      "waterfall",
    ]);
    expect(result.recommendations.some((r) => r.ruleId === "emergency_fund")).toBe(false);
    expect(result.recommendations.some((r) => r.ruleId === "high_interest_debt")).toBe(true);
  });

  it("reports the gate as a fact about the app, not as a recommendation", () => {
    const result = runAdvice(household({ historyMonths: 1 }), [], NOW);
    const gate = result.gated.find((g) => g.ruleId === "emergency_fund");

    expect(gate?.minMonthsHistory).toBe(3);
    expect(gate?.historyMonths).toBe(1);
    expect(gate?.title).toBe("Emergency fund");
    // No placeholder recommendation is manufactured for it.
    expect(result.recommendations.some((r) => r.ruleId === "emergency_fund")).toBe(false);
  });

  it("empties the waterfall rather than showing rungs it cannot justify", () => {
    const result = runAdvice(household({ historyMonths: 1 }), [], NOW);

    expect(result.waterfall).toEqual([]);
  });
});

describe("runAdvice — dismissals and snoozes", () => {
  function dismissal(partial: Partial<DismissalRecord> & { ruleId: string }): DismissalRecord {
    return {
      subjectKey: "",
      dismissedAt: new Date("2026-08-01T00:00:00Z"),
      snoozeUntil: null,
      ...partial,
    };
  }

  it("hides a whole rule dismissed with an empty subject key", () => {
    const result = runAdvice(household(), [dismissal({ ruleId: "emergency_fund" })], NOW);

    expect(result.recommendations.some((r) => r.ruleId === "emergency_fund")).toBe(false);
    expect(result.suppressed.map((s) => s.recommendation.ruleId)).toContain("emergency_fund");
  });

  it("hides only the named subject, leaving the rule's other findings alone", () => {
    const input = household({
      debts: [
        makeDebt({ accountId: "card", accountName: "Card", balance: "4000.00", apr: "0.249900" }),
        makeDebt({ accountId: "loan", accountName: "Loan", balance: "9000.00", apr: "0.129900" }),
      ],
    });
    const result = runAdvice(
      input,
      [dismissal({ ruleId: "high_interest_debt", subjectKey: "card" })],
      NOW,
    );

    const subjects = result.recommendations
      .filter((r) => r.ruleId === "high_interest_debt")
      .map((r) => r.subjectKey);
    expect(subjects).toEqual(["loan"]);
    expect(result.suppressed[0]?.recommendation.subjectKey).toBe("card");
  });

  it("lets a whole-rule dismissal outrank the per-subject one", () => {
    const result = runAdvice(
      household(),
      [
        dismissal({ ruleId: "high_interest_debt", subjectKey: "" }),
        dismissal({ ruleId: "high_interest_debt", subjectKey: "card" }),
      ],
      NOW,
    );

    expect(result.recommendations.some((r) => r.ruleId === "high_interest_debt")).toBe(false);
  });

  it("keeps a recommendation hidden while its snooze is still running", () => {
    const result = runAdvice(
      household(),
      [
        dismissal({
          ruleId: "emergency_fund",
          snoozeUntil: new Date("2026-09-01T00:00:00Z"),
        }),
      ],
      NOW,
    );

    expect(result.recommendations.some((r) => r.ruleId === "emergency_fund")).toBe(false);
    expect(result.suppressed[0]?.snoozeUntil?.toISOString()).toBe("2026-09-01T00:00:00.000Z");
  });

  it("brings a recommendation back the moment its snooze expires", () => {
    // An expired snooze is not a dismissal. The row stays in the table so the
    // history of what was rejected is inspectable, but it stops suppressing.
    const result = runAdvice(
      household(),
      [
        dismissal({
          ruleId: "emergency_fund",
          snoozeUntil: new Date("2026-08-15T11:59:59Z"),
        }),
      ],
      NOW,
    );

    expect(result.recommendations.some((r) => r.ruleId === "emergency_fund")).toBe(true);
    expect(result.suppressed).toHaveLength(0);
  });

  it("treats the snooze boundary as strictly-in-the-future", () => {
    const exact = runAdvice(
      household(),
      [dismissal({ ruleId: "emergency_fund", snoozeUntil: NOW })],
      NOW,
    );

    expect(exact.recommendations.some((r) => r.ruleId === "emergency_fund")).toBe(true);
  });

  it("ignores a dismissal for a rule that no longer exists", () => {
    // Rule ids are plain text, not a FK, so a retired rule leaves a harmless
    // orphan row rather than breaking a migration or the engine.
    const result = runAdvice(household(), [dismissal({ ruleId: "retired_rule_from_2024" })], NOW);

    expect(result.recommendations.length).toBeGreaterThan(0);
    expect(result.suppressed).toHaveLength(0);
  });

  it("still computes the waterfall for a dismissed rule's subject matter", () => {
    // Dismissing the emergency-fund card does not delete the reserve rung: the
    // waterfall is a diagnostic checklist, not a notification feed.
    const result = runAdvice(household(), [dismissal({ ruleId: "emergency_fund" })], NOW);

    expect(result.waterfall).toHaveLength(7);
  });
});

describe("sortRecommendations", () => {
  it("puts critical before warning before info", () => {
    const sorted = sortRecommendations([
      rec({ id: "c", severity: "info", title: "Info" }),
      rec({ id: "a", severity: "critical", title: "Critical" }),
      rec({ id: "b", severity: "warning", title: "Warning" }),
    ]);

    expect(sorted.map((r) => r.id)).toEqual(["a", "b", "c"]);
  });

  it("puts actionable items above good news at the same severity", () => {
    const sorted = sortRecommendations([
      rec({ id: "fine", severity: "info", status: "ok", title: "All good" }),
      rec({ id: "todo", severity: "info", status: "action", title: "Do this" }),
      rec({ id: "blank", severity: "info", status: "unknown_input", title: "Missing" }),
    ]);

    expect(sorted.map((r) => r.id)).toEqual(["todo", "blank", "fine"]);
  });

  it("ranks by impact within a severity and status", () => {
    const sorted = sortRecommendations([
      rec({ id: "small", severity: "warning", impact: "120.00", title: "Small" }),
      rec({ id: "big", severity: "warning", impact: "9000.00", title: "Big" }),
      rec({ id: "mid", severity: "warning", impact: "1200.00", title: "Mid" }),
    ]);

    expect(sorted.map((r) => r.id)).toEqual(["big", "mid", "small"]);
  });

  it("sorts an unsized recommendation last, not first", () => {
    const sorted = sortRecommendations([
      rec({ id: "unsized", severity: "warning", impact: null, title: "Unsized" }),
      rec({ id: "sized", severity: "warning", impact: "50.00", title: "Sized" }),
    ]);

    // We could not size it, so we cannot rank it — but it is still shown.
    expect(sorted.map((r) => r.id)).toEqual(["sized", "unsized"]);
  });

  it("breaks a total tie on the title so the order never reshuffles", () => {
    const items = [
      rec({ id: "z", severity: "warning", impact: "100.00", title: "Zulu" }),
      rec({ id: "a", severity: "warning", impact: "100.00", title: "Alpha" }),
    ];

    expect(sortRecommendations(items).map((r) => r.id)).toEqual(["a", "z"]);
    expect(sortRecommendations([...items].reverse()).map((r) => r.id)).toEqual(["a", "z"]);
  });

  it("does not mutate the caller's array", () => {
    const items = [rec({ id: "b", title: "B" }), rec({ id: "a", title: "A" })];
    const before = items.map((r) => r.id);

    sortRecommendations(items);
    expect(items.map((r) => r.id)).toEqual(before);
  });
});

describe("runAdvice — output shape", () => {
  it("echoes the snapshot's reference date rather than reading a clock", () => {
    const result = runAdvice(household({ today: "2026-03-04" }), [], NOW);

    expect(result.generatedAt).toBe("2026-03-04");
  });

  it("gives every recommendation a unique, stable id", () => {
    const first = runAdvice(household(), [], NOW).recommendations.map((r) => r.id);
    const second = runAdvice(household(), [], NOW).recommendations.map((r) => r.id);

    expect(new Set(first).size).toBe(first.length);
    expect(second).toEqual(first);
  });

  it("produces something usable on a blank install without throwing", () => {
    const result = runAdvice(
      makeAdviceInput({
        historyMonths: 0,
        essentials: { baseline: null, trailingMedian: null, basisMonths: 0 },
        netIncome: { trailingMedian: null, contributingCategories: [] },
        cash: makeCash([], null),
      }),
      [],
      NOW,
    );

    expect(result.waterfall).toEqual([]);
    expect(result.gated.length).toBeGreaterThan(0);
    // Whatever survives the gate must not claim anything about a household the
    // app knows nothing about.
    expect(result.recommendations.every((r) => r.status !== "ok")).toBe(true);
  });
});
