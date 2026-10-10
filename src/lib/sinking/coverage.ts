import type { ObligationCadence } from "@/lib/schedule/cadence.ts";
import { isSinkingEligible } from "./cadence.ts";
import { SINKING_MATERIALIZATION_DAYS_AHEAD } from "./constants.ts";

/**
 * Occurrence coverage — how far ahead a schedule must be materialized for the
 * requirement to be able to see it (P18-11, ADR-045 consequence 2).
 *
 * **This module exists because the gap it closes is invisible.** Every other way
 * this phase can be wrong shows up as a number that looks odd. A missing
 * occurrence row shows up as a number that looks fine and is too small, which is
 * the understating direction, which is the dangerous one for a set-aside.
 * [constants.ts](./constants.ts) states the measurement that found it and the
 * arithmetic behind 400 days.
 *
 * ── Why the lead is widened rather than the stream expanded ───────────────
 * P18-11 offered two routes, and this is route (a). Route (b) — have
 * `buildCostStream` expand eligible schedules forward past the materialized
 * window — would mean the calendar answers "when is the insurance due" one way
 * and the requirement answers it another, and the two would diverge the first
 * time a schedule was edited. ADR-045 already rejected re-expansion for exactly
 * that reason. Widening the lead keeps **one** interpretation of a schedule and
 * costs a handful of rows per obligation per year.
 *
 * ── It is a MAX, not an assignment ────────────────────────────────────────
 * A household that set `projection_horizon_days` to 365 already materializes
 * further ahead than this constant. Returning the sinking figure there would
 * SHORTEN the cash-flow calendar and drop bills off the end of the projection —
 * a cash-flow regression introduced by a sinking-fund feature, which is the kind
 * of coupling that makes a shared materializer frightening to touch. So the
 * function can only ever extend.
 *
 * ── Both call sites, or the fix is half-applied ───────────────────────────
 * The lead is applied in [project-cashflow-daily.ts](../../worker/jobs/project-cashflow-daily.ts)
 * (nightly, every obligation) **and** in `materializeThroughHorizon` in
 * [review/actions.ts](../../app/plan/cashflow/review/actions.ts) (immediately
 * after a create or an edit). Only the first would leave a newly confirmed
 * annual obligation uncovered — and therefore absent from the requirement —
 * until the next nightly run, which is precisely the moment a user goes looking
 * for the number they just created an obligation to see.
 *
 * Pure and I/O-free; no date arithmetic (it returns a day count, and the two
 * callers already own the day shift).
 */

/**
 * How many days ahead of today an obligation of this cadence should be
 * materialized.
 *
 * @param cadence - The obligation's cadence, already narrowed.
 * @param cashFlowDaysAhead - What the cash-flow projection needs:
 *   `projection_horizon_days + MATERIALIZATION_LEAD_DAYS`.
 * @returns `cashFlowDaysAhead` for a monthly-or-shorter cadence; the greater of
 *   it and {@link SINKING_MATERIALIZATION_DAYS_AHEAD} for a cadence a sinking
 *   fund accrues for. Never less than `cashFlowDaysAhead`.
 */
export function materializationDaysAhead(
  cadence: ObligationCadence,
  cashFlowDaysAhead: number,
): number {
  if (!isSinkingEligible(cadence)) return cashFlowDaysAhead;
  return Math.max(cashFlowDaysAhead, SINKING_MATERIALIZATION_DAYS_AHEAD);
}
