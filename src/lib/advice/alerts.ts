import { type DetectedAlert, dedupHash } from "@/lib/alerts/rules.ts";
import { ADVICE_RULES } from "./engine.ts";
import type { AdviceResult } from "./engine.ts";
import type { Recommendation, RuleId } from "./types.ts";

/**
 * Material-change guidance alerts (Phase 15, PLAN15 P15-36, ADR-015).
 *
 * A pure map from an already-run {@link AdviceResult} to `alerts` rows. No I/O,
 * no clock — the daily `evaluate-advice` job loads the snapshot, runs the engine,
 * and hands the result here.
 *
 * ── Why the title cannot be the recommendation's title ─────────────────────
 * ADR-015 keeps raw amounts out of `alerts.title` and puts them in `detail`,
 * which is rendered only in the authenticated UI and never emailed. Several
 * recommendation titles carry a figure by design — "Build your emergency fund to
 * $18,000.00", "Pay down Chase Sapphire — 24.99% APR". Reusing them would put a
 * balance in the one column the privacy posture says must not hold one. So the
 * alert title is built from {@link Rule.title} (the short, figure-free rule name)
 * and the recommendation's own title travels in `detail`.
 *
 * ── Why the dedup hash includes the STATE and nothing finer ────────────────
 * `(rule_id, subject_key, state)` where state is `severity|status`. The whole
 * point is that a **standing** condition never re-nags: an under-funded
 * emergency fund is under-funded again tomorrow, and firing an alert every night
 * would train the user to ignore the alerts page — the exact failure ADR-026
 * rejected for price targets.
 *
 * The state deliberately excludes the *amount*. Folding the impact figure into
 * the hash would make every cent of balance drift a new "material change", which
 * is the same nightly nag wearing a disguise. What fires is a genuine transition:
 * a rule going from `ok` to `action`, or a warning escalating to critical.
 *
 * ── What qualifies ─────────────────────────────────────────────────────────
 * `status === 'action'` and severity `warning` or `critical`. Two exclusions are
 * deliberate:
 *
 *   - **`info` actions do not alert.** "No budget set for Groceries" is worth a
 *     line on `/plan`; it is not worth an interruption and an email doorbell.
 *   - **`unknown_input` does not alert.** A missing input is a fact about the
 *     app's data, not a change in the household's money, and alerting on it would
 *     turn the honest-degradation path (ADR-032 consequence 1) into a nag.
 *
 * ── Why `advice` is not resolve-swept ──────────────────────────────────────
 * `RULE_ALERT_TYPES` drives the nightly sweep that closes alerts whose condition
 * has cleared. `advice` is excluded, like `backup_failure` and `price_target`. A
 * guidance rule can stop speaking for two very different reasons: the household
 * fixed the problem, or an input it depended on went missing. Auto-resolving on
 * silence would treat those identically and quietly close an alert on the second
 * one — announcing good news the app has no evidence for. The user dismisses it
 * from `/alerts` instead.
 */

/** Severities urgent enough to interrupt for. */
const ALERTING_SEVERITIES: ReadonlySet<string> = new Set(["critical", "warning"]);

/** Rule id → its short, figure-free title, for the alert's `title` column. */
const RULE_TITLES: ReadonlyMap<string, string> = new Map(
  ADVICE_RULES.map((rule) => [rule.id as string, rule.title]),
);

/** Whether a recommendation is a material change worth an alert row. */
export function isAlertable(recommendation: Recommendation): boolean {
  return (
    recommendation.status === "action" && ALERTING_SEVERITIES.has(recommendation.severity as string)
  );
}

/**
 * The dedup key for one guidance alert.
 *
 * @param ruleId - The rule that fired.
 * @param subjectKey - Account/category id, or `''` for a whole-rule item.
 * @param state - `severity|status` — the transition being announced.
 * @returns The sha256 dedup hash.
 */
export function adviceDedupHash(ruleId: string, subjectKey: string, state: string): string {
  return dedupHash("advice", `${ruleId}:${subjectKey}`, state);
}

/**
 * Turn a run of the engine into `alerts` rows (P15-36).
 *
 * @param result - The output of `runAdvice` over a freshly-loaded snapshot.
 * @returns One `DetectedAlert` per material, actionable recommendation. Empty on
 *   a household with nothing urgent — which is the normal case, not an error.
 */
export function adviceAlerts(result: AdviceResult): DetectedAlert[] {
  const out: DetectedAlert[] = [];

  for (const recommendation of result.recommendations) {
    if (!isAlertable(recommendation)) continue;

    const ruleTitle = RULE_TITLES.get(recommendation.ruleId) ?? recommendation.ruleId;
    const state = `${recommendation.severity}|${recommendation.status}`;

    out.push({
      type: "advice",
      severity: recommendation.severity,
      dedupHash: adviceDedupHash(recommendation.ruleId, recommendation.subjectKey, state),
      // Figure-free by construction — see the header.
      title: `Guidance: ${ruleTitle}`,
      detail: {
        ruleId: recommendation.ruleId,
        subjectKey: recommendation.subjectKey,
        status: recommendation.status,
        confidence: recommendation.confidence,
        // The figure-bearing copy lives here, where ADR-015 allows it.
        recommendation: recommendation.title,
        heuristic: recommendation.heuristic,
        currentValue: recommendation.currentValue,
        suggestedValue: recommendation.suggestedValue,
        impact: recommendation.impact,
        href: "/plan",
      },
    });
  }

  return out;
}

/** Every rule id the alert mapper knows about — for tests and the docs sweep. */
export function alertableRuleIds(): readonly RuleId[] {
  return ADVICE_RULES.map((rule) => rule.id);
}
