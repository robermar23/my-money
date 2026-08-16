/**
 * Checked-in benchmark constants (Phase 15, PLAN15 P15-14, ADR-034 §5/§6).
 *
 * Every number the advice engine compares against lives here, in the repository,
 * reviewable in a diff. **Nothing in this module is fetched.** That is the
 * binding privacy property of the phase (PLAN15 §Privacy): the rules engine makes
 * zero outbound HTTP on any code path, so a statutory limit is a constant the
 * user can read, not a call to an IRS endpoint that would leak the fact that this
 * household is looking at retirement limits today.
 *
 * ── Year-keyed, and `null` for unconfigured years ──────────────────────────
 * ADR-034 §5 is the whole design of {@link limitsForYear}: statutory limits
 * change every year, this file is updated by hand, and **the honest failure mode
 * of a stale hand-maintained table is silence, not last year's dollars.**
 *
 * Hardcoding one year's figures is silently wrong every January — the rule keeps
 * running, the pacing math keeps producing a confident percentage, and the user
 * is told they are on track against a ceiling that no longer exists. Returning
 * `null` instead suppresses the rung with "limit not configured for 2027", which
 * is a sentence the user can act on. [constants.test.ts](./constants.test.ts)
 * asserts the unconfigured-future-year path explicitly.
 *
 * **Maintenance**: the IRS announces the following year's figures each autumn.
 * Add a row to {@link STATUTORY_LIMITS} and the pacing rule and the workplace
 * rung come back to life on their own. Do not "carry forward" a year.
 *
 * ── The other constants are DEFAULTS, not policy ───────────────────────────
 * The reserve months, the high-interest threshold and the 50/30/20 split are all
 * overridable on `household_profile` (ADR-033 §4). NULL there means "use the
 * default in this file" — which keeps the defaults reviewable in code rather than
 * pinned into the database on install day, and keeps ADR-034 §6's "visible,
 * user-tunable, not a magic number" true.
 *
 * Money discipline (CLAUDE.md §Money): every dollar figure is a `numeric` string.
 * Rates follow the units convention Batch 1 locked — an APR is a decimal
 * FRACTION, an APY/percentage is a percentage.
 */

/**
 * Statutory contribution ceilings for one calendar year.
 *
 * Employee-side only. Employer dollars sit under a separate, much larger limit
 * this app does not model — folding them together would understate how much room
 * the user actually has, which is the wrong direction to be wrong in.
 *
 * No tax math is performed anywhere against these (ADR-032 §4): they are
 * ceilings to pace against, not inputs to a deduction calculation.
 */
export interface StatutoryLimits {
  readonly year: number;
  /** 401(k)/403(b)/457 employee elective deferral. */
  readonly electiveDeferral: string;
  /** Additional elective deferral once {@link catchUpAge} is reached. */
  readonly electiveDeferralCatchUp: string;
  /** Traditional + Roth IRA combined, per person. */
  readonly iraContribution: string;
  readonly iraCatchUp: string;
  /** HSA, self-only coverage. */
  readonly hsaSelfOnly: string;
  /** HSA, family coverage. */
  readonly hsaFamily: string;
  readonly hsaCatchUp: string;
  /** Age at which the elective-deferral and IRA catch-ups become available. */
  readonly catchUpAge: number;
  /** Age at which the HSA catch-up becomes available (it differs — 55). */
  readonly hsaCatchUpAge: number;
}

/**
 * The configured years.
 *
 * A `Map` rather than an object literal so a numeric key cannot be reached by
 * accidental string coercion, and so {@link configuredLimitYears} can report the
 * coverage range to the UI without `Object.keys` gymnastics.
 */
const STATUTORY_LIMITS: ReadonlyMap<number, StatutoryLimits> = new Map([
  [
    2024,
    {
      year: 2024,
      electiveDeferral: "23000.00",
      electiveDeferralCatchUp: "7500.00",
      iraContribution: "7000.00",
      iraCatchUp: "1000.00",
      hsaSelfOnly: "4150.00",
      hsaFamily: "8300.00",
      hsaCatchUp: "1000.00",
      catchUpAge: 50,
      hsaCatchUpAge: 55,
    },
  ],
  [
    2025,
    {
      year: 2025,
      electiveDeferral: "23500.00",
      electiveDeferralCatchUp: "7500.00",
      iraContribution: "7000.00",
      iraCatchUp: "1000.00",
      hsaSelfOnly: "4300.00",
      hsaFamily: "8550.00",
      hsaCatchUp: "1000.00",
      catchUpAge: 50,
      hsaCatchUpAge: 55,
    },
  ],
  [
    2026,
    {
      year: 2026,
      electiveDeferral: "24500.00",
      electiveDeferralCatchUp: "8000.00",
      iraContribution: "7500.00",
      iraCatchUp: "1100.00",
      hsaSelfOnly: "4400.00",
      hsaFamily: "8750.00",
      hsaCatchUp: "1000.00",
      catchUpAge: 50,
      hsaCatchUpAge: 55,
    },
  ],
]);

/**
 * Statutory limits for a calendar year (ADR-034 §5).
 *
 * @param year - Four-digit calendar year.
 * @returns The year's limits, or **`null` when the year is not configured** —
 *   which every caller must handle by suppressing its output with a reason, never
 *   by falling back to an adjacent year.
 */
export function limitsForYear(year: number): StatutoryLimits | null {
  return STATUTORY_LIMITS.get(year) ?? null;
}

/** The configured years, ascending. For "limits are configured through YYYY". */
export function configuredLimitYears(): readonly number[] {
  return [...STATUTORY_LIMITS.keys()].sort((a, b) => a - b);
}

/**
 * Baseline emergency-fund target, in months of essential expenses.
 *
 * The low end of the conventional 3–6 month range, used when income is
 * diversified and there are no dependents (P15-15).
 */
export const DEFAULT_RESERVE_MONTHS = 3;

/**
 * The elevated target, used when a job loss would hit the whole household at
 * once: dependents are recorded, or income is concentrated in a single source.
 */
export const ELEVATED_RESERVE_MONTHS = 6;

/**
 * The starter buffer — the first waterfall rung (ADR-034 §4).
 *
 * A deliberately small, flat, un-indexed figure. Its whole job is to stop the
 * next flat tire from becoming credit-card debt, and a household with no cash at
 * all needs a target they can hit in weeks, not the 3–6 month number.
 */
export const STARTER_BUFFER = "1000.00";

/**
 * Months of essential expenses that belong in *operating* cash (checking).
 *
 * Everything above this and the reserve target is what the cash-drag rule
 * (P15-20) considers idle.
 */
export const OPERATING_TARGET_MONTHS = 1;

/**
 * Where "high-interest debt" starts, as a decimal **fraction** (7%).
 *
 * Overridden by `household_profile.high_interest_threshold_apr`. Visible and
 * tunable by design (ADR-034 §6): the number encodes a judgement about paying
 * down debt versus investing the same dollar, and a household that disagrees
 * should be able to move it rather than argue with a constant they cannot see.
 */
export const DEFAULT_HIGH_INTEREST_THRESHOLD_APR = "0.070000";

/** The conventional 50/30/20 split, as percentages. Overridable per ADR-033 §4. */
export const DEFAULT_SPLIT = {
  needs: "50.00",
  wants: "30.00",
  savings: "20.00",
} as const;

/**
 * Credit-utilization thresholds, as fractions of the limit (P15-19).
 *
 * 30% is the conventional line. Above 90% a card is effectively maxed, which is
 * a different conversation from "a bit high", so it gets its own severity.
 */
export const UTILIZATION_TARGET = 0.3;
export const UTILIZATION_CRITICAL = 0.9;

/**
 * Rungs in a suggested CD ladder, and the months between maturities (P15-20).
 *
 * Four rungs a quarter apart means something matures every three months, which
 * is the point of a ladder: committed money that is nonetheless never more than
 * a quarter away. A *structure and an amount* — never a product, an institution,
 * or a rate (ADR-032 §4).
 */
export const DEFAULT_LADDER_RUNGS = 4;
export const DEFAULT_LADDER_INTERVAL_MONTHS = 3;

/**
 * Minimum idle cash before the cash-drag rule speaks, as a money string.
 *
 * Below this the suggestion is noise: a four-rung ladder over $600 is $150 a
 * rung, and the user's time is worth more than the yield difference.
 */
export const CASH_DRAG_MINIMUM_EXCESS = "2000.00";

/**
 * Share of observed net income above which one income category counts as the
 * household's *single* source of income (P15-15).
 *
 * Deliberately conservative: a two-earner household whose paychecks land in one
 * shared "Paycheck" category reads as concentrated and gets the 6-month target.
 * Erring toward the larger reserve is the safe direction, and
 * `reserve_months_override` exists for the household that disagrees.
 */
export const INCOME_CONCENTRATION_THRESHOLD = 0.8;

/**
 * Unclassified share above which a rule drops its confidence to `low`.
 *
 * At a fifth of spend unclassified the essential baseline is materially low, and
 * every target built on it is materially low too. The figure is still shown —
 * with the caveat attached (ADR-032 consequence 1).
 */
export const UNCLASSIFIED_CONFIDENCE_LIMIT = 0.2;
