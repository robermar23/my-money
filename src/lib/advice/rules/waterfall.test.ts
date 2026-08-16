// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  makeAccount,
  makeAdviceInput,
  makeCash,
  makeContributionRule,
  makeDebt,
  makeYtd,
} from "../advice-input.fixture.ts";
import type { RungId } from "../types.ts";
import { RUNG_ORDER, evaluateWaterfall, focusRung, waterfallRule } from "./waterfall.ts";

/*
 * P15-22 — the waterfall (ADR-034 §4).
 *
 * Three properties are load-bearing and each has its own test below:
 *   1. The ordering is fixed and stable.
 *   2. No rung is EVER reported `done` on absent data.
 *   3. An unfinished rung blocks the ones beneath it — except IRA/HSA, whose
 *      unknown is structural rather than a missing user input.
 */

const DIVERSIFIED = [
  { categoryId: "c1", name: "Salary A", total: "40000.00", excluded: false },
  { categoryId: "c2", name: "Salary B", total: "32000.00", excluded: false },
];

/** A household that clears the first four rungs cleanly. */
function healthy(extra: Parameters<typeof makeAdviceInput>[0] = {}) {
  return makeAdviceInput({
    today: "2026-07-01",
    netIncome: { trailingMedian: "6000.00", contributingCategories: DIVERSIFIED },
    cash: makeCash(
      [
        { name: "Everyday", subtype: "checking", balance: "5000.00" },
        { name: "Emergency", subtype: "savings", balance: "12000.00" },
      ],
      "3000.00",
    ),
    debts: [],
    contributionRules: [makeContributionRule({ ruleId: "r1" })],
    contributionsYtd: [
      makeYtd({
        ruleId: "r1",
        gross: "60000.00",
        employee: "3600.00",
        employer: "2400.00",
        periods: 13,
      }),
    ],
    ...extra,
  });
}

function statusOf(rungs: ReturnType<typeof evaluateWaterfall>, rung: RungId) {
  return rungs.find((r) => r.rung === rung)?.status;
}

describe("evaluateWaterfall — ordering", () => {
  it("emits every rung in the fixed ADR-034 §4 order", () => {
    const rungs = evaluateWaterfall(healthy());

    expect(rungs.map((r) => r.rung)).toEqual(RUNG_ORDER);
    expect(rungs.map((r) => r.order)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it("keeps that order stable regardless of the household's state", () => {
    // An advice checklist that reorders itself between page loads reads as
    // broken even when every rung is individually correct.
    const blank = evaluateWaterfall(makeAdviceInput());
    const rich = evaluateWaterfall(healthy());

    expect(blank.map((r) => r.rung)).toEqual(rich.map((r) => r.rung));
  });

  it("gives every rung a reason, in every state", () => {
    for (const rungs of [evaluateWaterfall(makeAdviceInput()), evaluateWaterfall(healthy())]) {
      for (const rung of rungs) {
        expect(rung.reason.length).toBeGreaterThan(0);
      }
    }
  });
});

describe("evaluateWaterfall — never done on absent data", () => {
  it("reports NO rung as done for a completely empty install", () => {
    // The single most damaging thing this feature could say is "you are all set"
    // to a household it knows nothing about.
    const rungs = evaluateWaterfall(
      makeAdviceInput({
        essentials: { baseline: null, trailingMedian: null, basisMonths: 0 },
        netIncome: { trailingMedian: null, contributingCategories: [] },
        cash: makeCash([], null),
        debts: [],
        accounts: [],
        contributionRules: [],
        contributionsYtd: [],
      }),
    );

    expect(rungs.some((r) => r.status === "done")).toBe(false);
    expect(statusOf(rungs, "starter_buffer")).toBe("unknown_input");
  });

  it("does not call the starter buffer done when no cash account is recorded", () => {
    // `liquid` is "0.00" here, and 0 is not ≥ $1,000 — but the point is the
    // reason: a household with no accounts on file is unmeasured, not broke.
    const rungs = evaluateWaterfall(makeAdviceInput({ cash: makeCash([], "3000.00") }));

    expect(statusOf(rungs, "starter_buffer")).toBe("unknown_input");
    expect(rungs[0]?.current).toBeNull();
    expect(rungs[0]?.reason).toContain("No cash accounts are recorded");
  });

  it("does not call the employer match done with no contribution rule on file", () => {
    const rungs = evaluateWaterfall(healthy({ contributionRules: [], contributionsYtd: [] }));

    expect(statusOf(rungs, "employer_match")).toBe("unknown_input");
  });

  it("does not call high-interest debt done when a debt has no APR", () => {
    const rungs = evaluateWaterfall(
      healthy({
        debts: [
          makeDebt({ accountId: "mystery", balance: "2000.00", apr: null, missing: ["apr"] }),
        ],
      }),
    );

    expect(statusOf(rungs, "high_interest_debt")).toBe("unknown_input");
    expect(rungs[2]?.reason).toContain("no APR recorded");
  });

  it("does not call the reserve done with no essential baseline", () => {
    const rungs = evaluateWaterfall(
      healthy({ essentials: { baseline: null, trailingMedian: null } }),
    );

    expect(statusOf(rungs, "full_reserve")).not.toBe("done");
  });

  it("never calls the IRA/HSA rung done, even with money in the containers", () => {
    // A balance is not a contribution: the app tracks payroll only, and an IRA
    // funded by an April bank transfer leaves no record it can read.
    const rungs = evaluateWaterfall(
      healthy({
        accounts: [makeAccount({ accountId: "roth", type: "investment", taxTreatment: "roth" })],
        holdings: { roth: "42000.00", total: "42000.00" },
      }),
    );

    expect(statusOf(rungs, "ira_hsa")).toBe("unknown_input");
    expect(rungs[4]?.current).toBe("42000.00");
    expect(rungs[4]?.reason).toContain("only tracks payroll contributions");
  });
});

describe("evaluateWaterfall — blocking", () => {
  it("marks the rungs beneath the current focus as blocked", () => {
    const rungs = evaluateWaterfall(
      healthy({
        cash: makeCash([{ name: "Everyday", subtype: "checking", balance: "400.00" }], "3000.00"),
      }),
    );

    // $400 is short of the $1,000 starter buffer, so nothing beneath it is the
    // next place a dollar should go.
    expect(statusOf(rungs, "starter_buffer")).toBe("in_progress");
    expect(rungs.slice(1).every((r) => r.status === "blocked")).toBe(true);
    expect(rungs[1]?.reason).toContain("Comes after Starter buffer");
  });

  it("propagates an unknown input as a block, not as a pass", () => {
    const rungs = evaluateWaterfall(healthy({ contributionRules: [], contributionsYtd: [] }));

    // "We cannot tell whether your match is covered" must not be read as
    // permission to move on to the rungs beneath it.
    expect(statusOf(rungs, "employer_match")).toBe("unknown_input");
    expect(statusOf(rungs, "high_interest_debt")).toBe("blocked");
    expect(statusOf(rungs, "full_reserve")).toBe("blocked");
  });

  it("steps over the IRA/HSA rung rather than damming everything below it", () => {
    const rungs = evaluateWaterfall(healthy());

    // Rungs 1–4 clear, IRA/HSA is unverifiable, and the workplace plan is still
    // reachable — otherwise every household on earth stalls permanently at rung 5.
    expect(statusOf(rungs, "starter_buffer")).toBe("done");
    expect(statusOf(rungs, "employer_match")).toBe("done");
    expect(statusOf(rungs, "high_interest_debt")).toBe("done");
    expect(statusOf(rungs, "full_reserve")).toBe("done");
    expect(statusOf(rungs, "ira_hsa")).toBe("unknown_input");
    expect(statusOf(rungs, "workplace_plan")).toBe("in_progress");
    expect(statusOf(rungs, "taxable_medium_term")).toBe("blocked");
  });

  it("marks the IRA/HSA rung non-blocking and every other rung blocking", () => {
    const rungs = evaluateWaterfall(healthy());

    expect(rungs.find((r) => r.rung === "ira_hsa")?.blocking).toBe(false);
    expect(rungs.filter((r) => r.rung !== "ira_hsa").every((r) => r.blocking)).toBe(true);
  });

  it("reports the workplace rung unknown when the year is not configured", () => {
    const rungs = evaluateWaterfall(healthy({ today: "2099-07-01", contributionYear: 2099 }));

    // ADR-034 §5, in one sentence, in one place.
    expect(statusOf(rungs, "workplace_plan")).toBe("unknown_input");
    expect(rungs[5]?.reason).toContain("not configured for 2099");
    expect(rungs[5]?.reason).toContain("Last year's ceiling would be the wrong number");
  });
});

describe("focusRung", () => {
  it("points at the first unfinished blocking rung", () => {
    const focus = focusRung(evaluateWaterfall(healthy()));

    expect(focus?.rung).toBe("workplace_plan");
  });

  it("skips the non-blocking IRA/HSA rung", () => {
    const focus = focusRung(evaluateWaterfall(healthy()));

    expect(focus?.rung).not.toBe("ira_hsa");
  });

  it("returns null once every blocking rung is done", () => {
    const focus = focusRung(
      evaluateWaterfall(
        healthy({
          // Contribution room fully used, and no cash beyond the targets.
          contributionsYtd: [
            makeYtd({
              ruleId: "r1",
              gross: "120000.00",
              employee: "24500.00",
              employer: "4800.00",
              periods: 13,
            }),
          ],
          cash: makeCash(
            [
              { name: "Everyday", subtype: "checking", balance: "3000.00" },
              { name: "Emergency", subtype: "savings", balance: "9000.00" },
            ],
            "3000.00",
          ),
        }),
      ),
    );

    expect(focus).toBeNull();
  });
});

describe("waterfallRule", () => {
  it("names the next rung and counts the finished ones", () => {
    const [rec] = waterfallRule.evaluate(healthy());

    expect(rec?.status).toBe("action");
    expect(rec?.title).toContain("Workplace plan");
    expect(rec?.rationale).toContain("4 of 7 rungs are complete");
  });

  it("says an input is missing rather than naming an action it cannot justify", () => {
    const [rec] = waterfallRule.evaluate(healthy({ contributionRules: [], contributionsYtd: [] }));

    expect(rec?.status).toBe("unknown_input");
    expect(rec?.confidence).toBe("low");
    expect(rec?.title).toContain("missing an input");
  });

  it("carries the focus rung's own inputs onto the recommendation", () => {
    const [rec] = waterfallRule.evaluate(
      healthy({
        cash: makeCash([{ name: "Everyday", subtype: "checking", balance: "400.00" }], "3000.00"),
      }),
    );

    expect(rec?.inputsUsed.map((i) => i.label)).toContain("Starter buffer target");
    expect(rec?.impact).toBe("600.00");
  });

  it("congratulates only when every blocking rung is finished", () => {
    const [rec] = waterfallRule.evaluate(
      healthy({
        contributionsYtd: [
          makeYtd({
            ruleId: "r1",
            gross: "120000.00",
            employee: "24500.00",
            employer: "4800.00",
            periods: 13,
          }),
        ],
        cash: makeCash(
          [
            { name: "Everyday", subtype: "checking", balance: "3000.00" },
            { name: "Emergency", subtype: "savings", balance: "9000.00" },
          ],
          "3000.00",
        ),
      }),
    );

    expect(rec?.status).toBe("ok");
    // Even here it refuses to claim the IRA/HSA rung is handled.
    expect(rec?.rationale).toContain("not something the app can see");
  });

  it("inherits the essential baseline's history floor", () => {
    expect(waterfallRule.minMonthsHistory).toBe(3);
  });
});
