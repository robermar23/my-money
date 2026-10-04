import { OBLIGATION_CADENCES, type ObligationCadence } from "@/lib/schedule/cadence.ts";

/**
 * Which obligation cadences a sinking fund accrues for (P18-01, ADR-045 §2).
 *
 * **This is the double-count gate, and it is the one place in Phase 18 where a
 * plausible-looking widening produces a badly wrong number.** A bill that
 * arrives monthly-or-more-often is paid out of the month's income: it is
 * already inside `essentials.monthly`
 * ([essential-expenses.ts](../advice/essential-expenses.ts)), which sizes the
 * emergency-fund target the requirement is measured against (ADR-046), **and**
 * inside the trailing observed spend behind the cash-flow residual rate
 * (ADR-038 §2). Accruing a reserve for it would demand the household hold a
 * **second copy** of money it already budgets every month — on a household with
 * $2,700/month of monthly obligations a naive 12-month stream asks for roughly
 * $16,000 against bills that are simply paid as they arrive, and the rule would
 * tell a perfectly solvent family it is catastrophically behind.
 *
 * What a sinking fund is *for* is the cost a monthly budget structurally cannot
 * represent: the $1,340 insurance premium in March, the semiannual water bill,
 * the quarterly estimated tax. Those arrive less often than the budget period,
 * so there is no month in which they are "normal".
 *
 * ── Why a Record and not an array `includes` ───────────────────────────────
 * The eligible set is DERIVED from an exhaustive
 * `Record<ObligationCadence, boolean>`, so adding a member to
 * `OBLIGATION_CADENCES` without deciding whether a household should accrue for
 * it **fails `tsc`** instead of silently defaulting to excluded (which would
 * understate the requirement) or included (which would double-count). Same
 * compile-time-gate trick, and the same motivation, as the income/obligation
 * superset assertion in [schedule/cadence.ts](../schedule/cadence.ts).
 *
 * The rationale for each verdict lives in the record itself rather than in a
 * doc elsewhere, because the next person to add a cadence will be editing this
 * object and nothing else.
 *
 * Pure and I/O-free: this module imports one type-erasing tuple and nothing
 * else, so it stays inside the zero-egress budget P18-33 enforces over
 * `src/lib/sinking/`.
 */
const SINKING_ELIGIBILITY = {
  // ── Excluded: paid out of the month's income, and already counted twice over
  // in `essentials.monthly` and the residual rate. See the header.
  weekly: false,
  biweekly: false,
  semimonthly: false,
  monthly: false,
  // ── Eligible: arrives less often than the budget period, so no single month
  // can absorb it. These are exactly the three cadences ADR-037 §3 added for
  // ("insurance premiums land semiannually, estimated taxes quarterly, property
  // tax and domain renewals annually") and they are the reason this phase
  // exists.
  quarterly: true,
  semiannual: true,
  annual: true,
} as const satisfies Record<ObligationCadence, boolean>;

/**
 * The cadences a sinking fund accrues for, as a type.
 *
 * Derived from `SINKING_ELIGIBILITY` rather than written out, so the type and
 * the runtime verdict cannot disagree.
 */
export type SinkingEligibleCadence = {
  [K in keyof typeof SINKING_ELIGIBILITY]: (typeof SINKING_ELIGIBILITY)[K] extends true ? K : never;
}[keyof typeof SINKING_ELIGIBILITY];

/**
 * The eligible cadences, in `OBLIGATION_CADENCES` order.
 *
 * Derived by filtering the vocabulary through the record — one source of truth,
 * and a stable order for anything that renders the list.
 */
export const SINKING_ELIGIBLE_CADENCES: readonly SinkingEligibleCadence[] =
  OBLIGATION_CADENCES.filter((cadence): cadence is SinkingEligibleCadence =>
    isSinkingEligible(cadence),
  );

/**
 * Whether a household should hold a sinking reserve against an obligation of
 * this cadence (ADR-045 §2).
 *
 * Narrowing, so a caller that filters a stream of occurrences keeps the proof
 * in the type rather than re-asserting it.
 *
 * @param cadence - One of `OBLIGATION_CADENCES`. A cadence read from the
 *     database is `text` and must be narrowed by the caller first, exactly as
 *     [cashflow/loader.ts](../cashflow/loader.ts) narrows it today.
 * @returns True for `quarterly`, `semiannual` and `annual`; false for every
 *     cadence of monthly or shorter period.
 */
export function isSinkingEligible(cadence: ObligationCadence): cadence is SinkingEligibleCadence {
  return SINKING_ELIGIBILITY[cadence];
}
