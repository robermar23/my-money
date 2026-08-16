// @vitest-environment node
import { describe, expect, it } from "vitest";
import { adviceAlerts, adviceDedupHash, isAlertable } from "./alerts.ts";
import type { AdviceResult } from "./engine.ts";
import type { Recommendation, Severity } from "./types.ts";

/**
 * Guidance→alert mapping (P15-36).
 *
 * Two properties carry this file:
 *
 *   1. **The title never carries a figure.** ADR-015 keeps amounts out of
 *      `alerts.title`, and recommendation titles routinely contain one. A
 *      regression here would leak a balance into the one column the privacy
 *      posture says must not hold one.
 *   2. **A standing condition produces a stable hash.** That is the entire
 *      mechanism preventing a nightly nag, and it is easy to break by adding a
 *      "helpful" field like the impact amount to the state string.
 */

function makeRecommendation(partial: Partial<Recommendation> = {}): Recommendation {
  return {
    id: "emergency_fund:",
    ruleId: "emergency_fund",
    subjectKey: "",
    severity: "critical",
    status: "action",
    title: "Build your emergency fund to $18,000.00",
    rationale: "You hold less than one month of essential expenses.",
    heuristic: "3–6 months of essential expenses",
    benchmark: "18000.00",
    currentValue: "1200.00",
    suggestedValue: "18000.00",
    impact: "16800.00",
    inputsUsed: [],
    confidence: "high",
    ...partial,
  };
}

function makeResult(recommendations: readonly Recommendation[]): AdviceResult {
  return {
    recommendations,
    suppressed: [],
    waterfall: [],
    gated: [],
    generatedAt: "2026-08-15",
  };
}

describe("isAlertable", () => {
  it("accepts a critical action", () => {
    expect(isAlertable(makeRecommendation({ severity: "critical", status: "action" }))).toBe(true);
  });

  it("accepts a warning action", () => {
    expect(isAlertable(makeRecommendation({ severity: "warning", status: "action" }))).toBe(true);
  });

  it("rejects an info action — a nag is not an interruption", () => {
    expect(isAlertable(makeRecommendation({ severity: "info", status: "action" }))).toBe(false);
  });

  it("rejects a missing input — that is a fact about the app, not the money", () => {
    expect(isAlertable(makeRecommendation({ severity: "critical", status: "unknown_input" }))).toBe(
      false,
    );
  });

  it("rejects good news", () => {
    expect(isAlertable(makeRecommendation({ severity: "info", status: "ok" }))).toBe(false);
  });
});

describe("adviceAlerts", () => {
  it("puts no figure in the title", () => {
    const [alert] = adviceAlerts(makeResult([makeRecommendation()]));
    expect(alert).toBeDefined();
    expect(alert?.title).toBe("Guidance: Emergency fund");
    // The recommendation's own title has an amount in it; the alert's must not.
    expect(alert?.title).not.toMatch(/\d/);
  });

  it("keeps the figure-bearing copy in detail, where ADR-015 allows it", () => {
    const [alert] = adviceAlerts(makeResult([makeRecommendation()]));
    expect(alert?.detail.recommendation).toBe("Build your emergency fund to $18,000.00");
    expect(alert?.detail.impact).toBe("16800.00");
    expect(alert?.detail.href).toBe("/plan");
  });

  it("carries the recommendation's severity through to the alert", () => {
    const [alert] = adviceAlerts(makeResult([makeRecommendation({ severity: "warning" })]));
    expect(alert?.severity).toBe("warning");
  });

  it("emits one row per qualifying recommendation and skips the rest", () => {
    const alerts = adviceAlerts(
      makeResult([
        makeRecommendation({ ruleId: "emergency_fund", subjectKey: "" }),
        makeRecommendation({ ruleId: "credit_utilization", subjectKey: "acct-1" }),
        makeRecommendation({ severity: "info", ruleId: "cash_drag" }),
        makeRecommendation({ status: "ok", ruleId: "budget_coverage" }),
      ]),
    );
    expect(alerts).toHaveLength(2);
    expect(alerts.map((a) => a.type)).toEqual(["advice", "advice"]);
  });

  it("gives an empty result on a household with nothing urgent", () => {
    expect(adviceAlerts(makeResult([]))).toEqual([]);
  });

  it("uses the same hash tomorrow for a standing condition", () => {
    // The impact drifts as balances move; the hash must not.
    const today = adviceAlerts(makeResult([makeRecommendation({ impact: "16800.00" })]));
    const tomorrow = adviceAlerts(makeResult([makeRecommendation({ impact: "16755.31" })]));
    expect(tomorrow[0]?.dedupHash).toBe(today[0]?.dedupHash);
  });

  it("fires a fresh hash when the severity escalates", () => {
    const warning = adviceAlerts(makeResult([makeRecommendation({ severity: "warning" })]));
    const critical = adviceAlerts(makeResult([makeRecommendation({ severity: "critical" })]));
    expect(critical[0]?.dedupHash).not.toBe(warning[0]?.dedupHash);
  });

  it("keeps per-subject alerts distinct", () => {
    const alerts = adviceAlerts(
      makeResult([
        makeRecommendation({ ruleId: "credit_utilization", subjectKey: "card-a" }),
        makeRecommendation({ ruleId: "credit_utilization", subjectKey: "card-b" }),
      ]),
    );
    expect(new Set(alerts.map((a) => a.dedupHash)).size).toBe(2);
  });

  it("falls back to the rule id when a rule has no registered title", () => {
    // Guards the `?? recommendation.ruleId` branch: a retired rule id must not
    // render "Guidance: undefined".
    const [alert] = adviceAlerts(
      makeResult([makeRecommendation({ ruleId: "not_a_rule" as Recommendation["ruleId"] })]),
    );
    expect(alert?.title).toBe("Guidance: not_a_rule");
  });
});

describe("adviceDedupHash", () => {
  it("is stable for the same inputs", () => {
    const a = adviceDedupHash("emergency_fund", "", "critical|action");
    const b = adviceDedupHash("emergency_fund", "", "critical|action");
    expect(a).toBe(b);
  });

  it("changes with the state", () => {
    const severities: readonly Severity[] = ["critical", "warning", "info"];
    const hashes = severities.map((s) => adviceDedupHash("emergency_fund", "", `${s}|action`));
    expect(new Set(hashes).size).toBe(3);
  });
});
