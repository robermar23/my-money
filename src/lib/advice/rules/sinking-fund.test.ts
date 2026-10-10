// @vitest-environment node
import { Money } from "@/lib/money/money.ts";
import { ROUND12_TODAY, round12Costs, round12Input } from "@/lib/sinking/round12.fixture.ts";
import { describe, expect, it } from "vitest";
import { makeCash, makeProfile } from "../advice-input.fixture.ts";
import { type DismissalRecord, runAdvice } from "../engine.ts";
import { sinkingFundRule } from "./sinking-fund.ts";

/**
 * P18-21 — the `sinking_fund` rule (P18-20, ADR-046). Written before the
 * implementation.
 *
 * The arithmetic is already proved in [requirement.test.ts](../../sinking/requirement.test.ts)
 * and [availability.test.ts](../../sinking/availability.test.ts); this file is
 * about the four things the rule decides on top of it, and one of them matters
 * far more than the others:
 *
 *   1. **An empty cost stream is `unknown_input`, never `ok`** (ADR-046 §5).
 *      Asserted explicitly as not-`ok`, because a future simplification that
 *      "tidied up" the status ladder would otherwise pass every other test in
 *      this file while telling a family with an unrecorded insurance premium
 *      that they are fine. It is the single most important assertion in the
 *      batch.
 *   2. **Severity is capped at `info` while the emergency fund is short**
 *      (ADR-046 §3), and the ordering is stated in words rather than enforced by
 *      re-ordering the shipped waterfall.
 *   3. **Degradations name the missing input and link to it** (ADR-032 §2), with
 *      `null` figures rather than a confident `"0.00"`.
 *   4. **It is a first-class engine citizen** — dismissible, gated like every
 *      other rule, and (at `minMonthsHistory: 0`) still speaking on a one-month
 *      install, because it reads recorded costs rather than history.
 */

const NOW = new Date("2026-10-04T12:00:00Z");

/** Round 12's household, with its four costs on the input. */
function withCosts(overrides: Parameters<typeof round12Input>[0] = {}) {
  return round12Input({ knownFutureCosts: round12Costs(), ...overrides });
}

function evaluateOne(input: Parameters<typeof sinkingFundRule.evaluate>[0]) {
  const recommendations = sinkingFundRule.evaluate(input);
  expect(recommendations).toHaveLength(1);
  const first = recommendations[0];
  if (first === undefined) throw new Error("no recommendation");
  return first;
}

describe("sinkingFundRule — Round 12's sentence, through the engine's shape", () => {
  const rec = evaluateOne(withCosts());

  it("states the requirement and what is available against it", () => {
    // $2,180 required, $9,600 reserve against a $9,000 target, so $600
    // available and a $1,580 gap. Hand-typed, exactly as the pure tests do.
    expect(rec.status).toBe("action");
    expect(rec.benchmark).toBe("2180.00");
    expect(rec.suggestedValue).toBe("2180.00");
    expect(rec.currentValue).toBe("600.00");
    expect(rec.impact).toBe("1580.00");
  });

  it("is a warning, because the emergency fund is already funded", () => {
    // ADR-046 §3's other half: with the reserve above its target the next
    // dollars genuinely have this job.
    expect(rec.severity).toBe("warning");
  });

  it("names the heuristic plainly", () => {
    expect(rec.heuristic).toBe(
      "Set aside a known irregular cost evenly across the months before it is due",
    );
  });

  it("identifies itself for dismissal and sorting", () => {
    expect(rec.ruleId).toBe("sinking_fund");
    expect(rec.id).toBe("sinking_fund:");
    expect(rec.subjectKey).toBe("");
  });

  it("says how much a month, and over how many costs", () => {
    // The monthly set-aside is the number a household can act on; the count and
    // the horizon are what make the total checkable against the page's table.
    expect(rec.rationale).toContain("$580.00");
    expect(rec.rationale).toContain("4 known costs");
    expect(rec.rationale).toContain("next 12 months");
  });
});

describe("sinkingFundRule — the emergency fund comes first (ADR-046 §3)", () => {
  /** A 6-month override puts the target at $18,000 against a $9,600 reserve. */
  const short = withCosts({
    household: { profile: makeProfile({ reserveMonthsOverride: 6 }) },
  });

  it("caps severity at info while the reserve is below its target", () => {
    const rec = evaluateOne(short);

    expect(rec.status).toBe("action");
    expect(rec.severity).toBe("info");
  });

  it("states the ordering in words rather than hiding the gap", () => {
    const rec = evaluateOne(short);

    // The gap is real and reported in full — nothing about the cap suppresses
    // it. What the cap changes is only where it sorts.
    expect(rec.impact).toBe("2180.00");
    expect(rec.currentValue).toBe("0.00");
    expect(rec.rationale.toLowerCase()).toContain("emergency fund");
  });

  it("stays info even when the sinking gap is the larger number", () => {
    // A household $8,400 short on its reserve and $20,000 short on known costs
    // still hears about the reserve first. The severity is an ordering claim,
    // not a size claim.
    const rec = evaluateOne(
      withCosts({
        household: { profile: makeProfile({ reserveMonthsOverride: 6 }) },
        knownFutureCosts: [
          {
            source: "planned_expense",
            sourceId: "pe-huge",
            label: "Roof replacement",
            amount: "24000.00",
            currency: "USD",
            dueDate: "2027-04-04",
            fundingStart: "2026-04-04",
            status: "planned",
            categoryId: null,
          },
        ],
      }),
    );

    expect(rec.severity).toBe("info");
    expect(Money.fromString(rec.impact ?? "0.00", "USD").isZero()).toBe(false);
  });
});

describe("sinkingFundRule — ok is for a met requirement, nothing else", () => {
  it("reports ok when the reserve above target covers the requirement", () => {
    const rec = evaluateOne(
      withCosts({
        cash: makeCash(
          [{ name: "Ally Savings", subtype: "savings", balance: "12000.00" }],
          "3000.00",
        ),
      }),
    );

    expect(rec.status).toBe("ok");
    expect(rec.severity).toBe("info");
    expect(rec.currentValue).toBe("3000.00");
    expect(rec.impact).toBe("0.00");
  });

  it("is NOT ok on an empty cost stream, even though every figure computed", () => {
    // ADR-046 §5, and the reason [sinking/status.ts](../../sinking/status.ts)
    // exists. With nothing recorded the arithmetic is immaculate — a $0
    // requirement, a known $9,000 target, a $600 surplus — and it says "on
    // track". The app must not, because it cannot tell "no large irregular
    // costs" from "none entered yet", and the second is likelier on every
    // install. THE test a future simplification breaks.
    const rec = evaluateOne(round12Input({ knownFutureCosts: [] }));

    expect(rec.status).not.toBe("ok");
    expect(rec.status).toBe("unknown_input");
    // Nothing is claimed about the household's position, in either direction.
    expect(rec.benchmark).toBeNull();
    expect(rec.suggestedValue).toBeNull();
    expect(rec.impact).toBeNull();
  });

  it("names the cost list as the missing input, and links to where it is entered", () => {
    const rec = evaluateOne(round12Input({ knownFutureCosts: [] }));
    const missing = rec.inputsUsed.filter((input) => input.missing === true);

    expect(missing).toHaveLength(1);
    expect(missing[0]?.label).toBe("Known upcoming costs");
    expect(missing[0]?.value).toBeNull();
    expect(missing[0]?.href).toBe("/plan/sinking");
    // The figures it CAN state are still stated: declining to answer one
    // question is not a reason to withhold the reserve balance.
    const reserve = rec.inputsUsed.find((input) => input.label === "Reserve savings");
    expect(reserve?.value).toBe("9600.00");
  });
});

describe("sinkingFundRule — no baseline, no target (ADR-046 §4)", () => {
  const rec = evaluateOne(withCosts({ essentials: { baseline: null } }));

  it("declines to state a position rather than guessing a zero target", () => {
    expect(rec.status).toBe("unknown_input");
    expect(rec.currentValue).toBeNull();
    expect(rec.suggestedValue).toBeNull();
    expect(rec.impact).toBeNull();
    // `null` ≠ `"0.00"`: a zero target would render as *funded*.
    expect(rec.impact).not.toBe("0.00");
    expect(rec.currentValue).not.toBe("0.00");
  });

  it("names the baseline, and links to where it is fixed", () => {
    const missing = rec.inputsUsed.filter((input) => input.missing === true);

    expect(missing.map((input) => input.label)).toContain("Essential monthly expenses");
    const baseline = missing.find((input) => input.label === "Essential monthly expenses");
    expect(baseline?.value).toBeNull();
    expect(baseline?.href).toBe("/settings/categories");
  });

  it("wins over the empty-stream degradation when both are true", () => {
    // A fresh install is in both states at once. Without a baseline there is no
    // target and therefore no position either way, while a missing cost list
    // still leaves the target perfectly well stated — and fixing the baseline
    // is the one link that unblocks the other.
    const fresh = round12Input({ essentials: { baseline: null }, knownFutureCosts: [] });
    const rec = evaluateOne(fresh);

    expect(rec.inputsUsed.map((input) => input.label)).toEqual([
      "Essential monthly expenses",
      "Reserve savings",
    ]);
    expect(rec.inputsUsed[0]?.missing).toBe(true);
    // One link to follow, not two: without a target this branch never got as
    // far as needing a requirement, so the cost list is not among the inputs it
    // read — and a count of `0` shown as a known value would be the
    // `null` ≠ `"0.00"` mistake moved into the audit trail.
    expect(rec.inputsUsed.map((input) => input.label)).not.toContain("Known upcoming costs");
  });
});

describe("sinkingFundRule — what it says about costs already late", () => {
  it("names the past-due costs rather than silently requiring them in full", () => {
    // ADR-044 §5: a still-`planned` cost whose date has passed is overdue, not
    // out of scope, and its full amount stays in the requirement. A household
    // seeing an unexplained figure would conclude the feature is broken, so the
    // row is called out with the two actions that clear it.
    const rec = evaluateOne(
      withCosts({
        knownFutureCosts: [
          {
            source: "planned_expense",
            sourceId: "pe-late",
            label: "Vet bill",
            amount: "600.00",
            currency: "USD",
            dueDate: "2026-09-01",
            fundingStart: "2026-06-01",
            status: "planned",
            categoryId: null,
          },
        ],
      }),
    );

    expect(rec.rationale).toContain("past due");
    expect(rec.rationale).toContain("mark it paid");
  });

  it("says nothing about past-due costs when none are", () => {
    expect(evaluateOne(withCosts()).rationale).not.toContain("past due");
  });
});

describe("sinkingFundRule — confidence follows the baseline (ADR-046 §7)", () => {
  it("is high on a clean year of classified spend", () => {
    expect(evaluateOne(withCosts()).confidence).toBe("high");
  });

  it("drops to low when the target rests on four months of history", () => {
    // The target is `months × baseline`, so it is only as trustworthy as the
    // median behind it — graded by the shipped `baselineConfidence` rather than
    // by a threshold invented here, so this card and the emergency-fund card
    // never show two different levels of trust in the same figure.
    const rec = evaluateOne(withCosts({ essentials: { basisMonths: 4 } }));

    expect(rec.confidence).toBe("low");
    // And the figure itself is unchanged: low confidence is said next to a
    // number, never instead of one.
    expect(rec.impact).toBe("1580.00");
  });
});

describe("sinkingFundRule — the audit trail (ADR-032 §2)", () => {
  const rec = evaluateOne(withCosts());

  it("shows every input the figure was built from", () => {
    expect(rec.inputsUsed.map((input) => input.label)).toEqual([
      "Set aside required today",
      "Reserve savings",
      "Emergency-fund target",
      "Reserve above your emergency-fund target",
      "Essential monthly expenses",
      "Reserve target",
    ]);
  });

  it("gives every input a value, a source sentence and an in-app href", () => {
    for (const input of rec.inputsUsed) {
      expect(input.value).not.toBeNull();
      expect(input.source.length).toBeGreaterThan(0);
      // Every href is a route this app serves — `/plan/sinking` is added at
      // P18-23 and registered in the nav manifest at P18-26.
      expect(input.href).toMatch(/^\/(plan\/sinking|accounts|settings\/(categories|household))$/);
    }
  });

  it("explains the target with the shipped reserveMonthsFor reason", () => {
    const target = rec.inputsUsed.find((input) => input.label === "Reserve target");

    expect(target?.value).toBe("3");
    expect(target?.kind).toBe("months");
    // The same sentence the emergency-fund card shows, not a second wording.
    expect(target?.source).toContain("no dependents are recorded");
  });

  it("counts the costs behind the requirement in its source sentence", () => {
    const requirement = rec.inputsUsed.find((input) => input.label === "Set aside required today");

    expect(requirement?.value).toBe("2180.00");
    expect(requirement?.source).toBe("4 known costs due in the next 12 months");
    expect(requirement?.href).toBe("/plan/sinking");
  });
});

describe("sinkingFundRule — through the shipped engine", () => {
  function dismissal(partial: Partial<DismissalRecord> = {}): DismissalRecord {
    return {
      ruleId: "sinking_fund",
      subjectKey: "",
      dismissedAt: new Date("2026-10-01T00:00:00Z"),
      snoozeUntil: null,
      ...partial,
    };
  }

  it("runs on a one-month-old install rather than being gated", () => {
    // `minMonthsHistory: 0` (ADR-046 §6): the costs are recorded by hand and the
    // balances are recorded too, so nothing here needs a year of transactions.
    const result = runAdvice(withCosts({ historyMonths: 1 }), [], NOW);

    expect(result.gated.map((gate) => gate.ruleId)).not.toContain("sinking_fund");
    expect(result.recommendations.some((r) => r.ruleId === "sinking_fund")).toBe(true);
  });

  it("is dismissible, and reappears in the dismissed list rather than vanishing", () => {
    const result = runAdvice(withCosts(), [dismissal()], NOW);

    expect(result.recommendations.some((r) => r.ruleId === "sinking_fund")).toBe(false);
    expect(result.suppressed.map((s) => s.recommendation.ruleId)).toContain("sinking_fund");
  });

  it("comes back on its own once a snooze expires", () => {
    const result = runAdvice(
      withCosts(),
      [dismissal({ snoozeUntil: new Date("2026-10-02T00:00:00Z") })],
      NOW,
    );

    expect(result.recommendations.some((r) => r.ruleId === "sinking_fund")).toBe(true);
  });

  it("agrees with the pure functions — one figure, not two", () => {
    // ADR-046 consequence 1 in miniature: what the card shows is what the
    // requirement computed, with no second rounding on the way through.
    const input = withCosts();
    const fromEngine = runAdvice(input, [], NOW).recommendations.find(
      (r) => r.ruleId === "sinking_fund",
    );

    expect(fromEngine?.impact).toBe(evaluateOne(input).impact);
  });
});

describe("sinkingFundRule — purity", () => {
  it("reads only its input, and does not mutate it", () => {
    const input = withCosts();
    const before = JSON.stringify(input);
    sinkingFundRule.evaluate(input);
    expect(JSON.stringify(input)).toBe(before);
  });

  it("is deterministic in `today`, not in the clock", () => {
    const input = withCosts();
    expect(input.today).toBe(ROUND12_TODAY);
    expect(evaluateOne(input).impact).toBe(evaluateOne(input).impact);
  });
});
