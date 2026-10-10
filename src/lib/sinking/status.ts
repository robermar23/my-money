import type { SinkingAvailability, SinkingRequirement, SinkingStatus } from "./types.ts";

/**
 * Why a figure is or is not available (P18-17, ADR-046 §4/§5).
 *
 * Four lines, and it exists for one reason: otherwise `/plan/sinking` decides
 * for itself why the number is missing while the `sinking_fund` rule decides
 * separately, and the two disagree on one screen. That is ADR-032's loader/pure
 * split applied to a **word** rather than a number, and the page and the card
 * being unable to contradict each other is the property ADR-046's consequence 1
 * claims.
 *
 * ── `no_costs_recorded` is not success ───────────────────────────────────
 * The sharpest judgement call in the phase (ADR-046 §5), and the one a future
 * simplification would undo. With an empty stream every figure computes
 * cleanly: a $0 requirement, a known target, a positive surplus. The arithmetic
 * says *on track*. The app must not, because it cannot distinguish *"this
 * household has no large irregular costs"* from *"it has not recorded them
 * yet"*, and on any install the second is overwhelmingly likelier. Telling a
 * family with an unrecorded $1,340 premium that they are fine is the one failure
 * mode that would make this feature actively harmful — and it is the same
 * never-report-done-on-absent-data rule that makes every other rung of the
 * advice ladder trustworthy.
 *
 * ── Why `no_baseline` wins ───────────────────────────────────────────────
 * On a fresh install both are true at once. Without an essential baseline there
 * is no emergency-fund target, so there is no availability for a requirement to
 * be compared against — the household cannot be told its position **either
 * way**, whereas a missing cost list still leaves the target and the reserve
 * perfectly well stated. The baseline is also the input whose fix unblocks the
 * other, so naming it is one link to follow instead of two.
 *
 * Derived entirely from the two shapes rather than from the raw snapshot, so
 * there is no third opinion about what "missing" means: the `null` is already
 * [availability.ts](./availability.ts)'s answer and the count is already
 * [requirement.ts](./requirement.ts)'s.
 */

/**
 * Resolve the status of a sinking-fund figure.
 *
 * @param requirement - The output of {@link ./requirement.ts sinkingRequirement}.
 * @param availability - The output of
 *   {@link ./availability.ts sinkingAvailability}.
 * @returns `'no_baseline'` when the emergency-fund target is unknowable,
 *   `'no_costs_recorded'` when nothing has been recorded to require, otherwise
 *   `'ok'` — which says the figures can be **stated**, not that they are good
 *   news. A $1,580 gap is `'ok'`.
 */
export function sinkingStatus(
  requirement: SinkingRequirement,
  availability: SinkingAvailability,
): SinkingStatus {
  if (availability.emergencyTarget === null) return "no_baseline";
  if (requirement.costCount === 0) return "no_costs_recorded";
  return "ok";
}
