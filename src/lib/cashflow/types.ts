import type { ObligationAmountMode } from "@/db/schema/scheduled-obligations.ts";
import type { InputUsed } from "@/lib/advice/types.ts";

/**
 * The projection engine's contract (P16-13, ADR-038).
 *
 * Every shape the cash-flow projection produces is declared here, once. The
 * event expander, the residual rate, the day walk, safe-to-spend, the status
 * ladder, the loader and the page all speak these and nothing else.
 *
 * ── Money discipline ───────────────────────────────────────────────────────
 * Every money-valued field is a `numeric(18,2)` string (CLAUDE.md §Money), and
 * every one of them is a POSITIVE MAGNITUDE except {@link DailyProjectionPoint}'s
 * balances, which are genuinely signed — a projected balance can go below zero,
 * and that is the single most important thing this feature has to be able to
 * say. Amounts carry their sign in `direction` for exactly the reason
 * `scheduled_obligations.expected_amount` does: a signed "expected amount"
 * invites a sign bug on the outflow side of a projection, which is where a sign
 * bug is most expensive.
 *
 * ── Why `InputUsed` is imported rather than redeclared ─────────────────────
 * ADR-038 §8. A user who disagrees with the number must be able to find the
 * wrong INPUT rather than conclude the feature is untrustworthy — which is the
 * same contract the advice layer already ships. Two parallel audit-trail shapes
 * would mean two renderers, and the second one would drift. The import is
 * TYPE-ONLY, so this module pulls no `server-only` code into a client bundle
 * (the same erasure trick [advice/types.ts](../advice/types.ts) relies on for
 * `AdviceInput`).
 *
 * ── Nothing here is persisted ──────────────────────────────────────────────
 * A projection is computed on read from the schedule, the balances and the
 * trailing spend. Persisting it would create a second source of truth that goes
 * stale the moment a transaction imports — the same reasoning that keeps
 * recommendations unpersisted (ADR-032 §3). What IS persisted is the schedule
 * (`scheduled_obligations`) and its materialized occurrences.
 */

export type { InputUsed };

/** Which way money moves on a projected day. */
export type CashFlowDirection = "inflow" | "outflow";

/**
 * Fields every projected event carries, whatever produced it.
 *
 * `amount` is a positive magnitude; `direction` decides which side of the day's
 * ledger it lands on.
 */
interface CashFlowEventBase {
  /** `YYYY-MM-DD` the money is expected to move. */
  readonly date: string;
  /** Positive magnitude. Never signed — see the module header. */
  readonly amount: string;
  readonly direction: CashFlowDirection;
  /** What the user sees on the calendar. Never parsed. */
  readonly label: string;
}

/**
 * A projected paycheck.
 *
 * Amount is observed take-home, never gross (ADR-038 §3): projecting
 * `income_sources.gross_per_period` into a checking account overstates every
 * inflow by the entire withholding stack, which is the optimistic direction and
 * therefore the dangerous one.
 */
export interface IncomeEvent extends CashFlowEventBase {
  readonly kind: "income";
  readonly direction: "inflow";
  readonly incomeSourceId: string;
}

/**
 * A projected occurrence of a CONFIRMED obligation (ADR-036 §2).
 *
 * `direction` is the obligation's own, because an obligation can be a receipt —
 * a quarterly dividend, a rent cheque from a lodger — that no income source
 * models. That is the case the union would lose if inflows were assumed to be
 * paychecks.
 */
export interface ObligationEvent extends CashFlowEventBase {
  readonly kind: "obligation";
  readonly obligationId: string;
  /**
   * Carried through so the UI can say which figures are re-priced from actuals
   * and which are the user's stated amount. A `trailing_median` obligation is
   * projected at its median and WILL be wrong by its variance — ADR-038's
   * stated limitation, and the reason the mode is visible rather than internal.
   */
  readonly amountMode: ObligationAmountMode;
}

/**
 * One day's share of everything that is not a confirmed obligation — groceries,
 * fuel, the unremarkable card spend.
 *
 * A flat daily rate, and deliberately so: per-category daily rates were rejected
 * in ADR-038 as more machinery, no better answer at this horizon, and more ways
 * to double-count. It appears as an EVENT rather than as a hidden subtraction
 * inside the walk so that a day's `events[]` explains its own `outflow` in full
 * — a user who adds up the day and gets a different number has found a bug, and
 * should be able to.
 */
export interface DiscretionaryEvent extends CashFlowEventBase {
  readonly kind: "discretionary";
  readonly direction: "outflow";
}

/**
 * Anything that moves the projected balance on a given day.
 *
 * A genuine discriminated union on `kind`: the three members carry different
 * provenance (`incomeSourceId`, `obligationId`, nothing at all) and narrow to
 * different shapes, so `switch (event.kind)` is exhaustively checkable.
 */
export type CashFlowEvent = IncomeEvent | ObligationEvent | DiscretionaryEvent;

/** One day of the walk. `closing` is the next day's `opening`, by construction. */
export interface DailyProjectionPoint {
  /** `YYYY-MM-DD`. */
  readonly date: string;
  /** Balance carried in from the previous day. Signed. */
  readonly opening: string;
  /** Sum of the day's inflow magnitudes. Non-negative. */
  readonly inflow: string;
  /** Sum of the day's outflow magnitudes, residual included. Non-negative. */
  readonly outflow: string;
  /** `opening + inflow − outflow`. Signed — this is allowed to be negative. */
  readonly closing: string;
  /** Everything that moved on this day, ascending and stably ordered. */
  readonly events: readonly CashFlowEvent[];
}

/**
 * The lowest closing balance across the horizon, and when it first happens.
 *
 * "First" is load-bearing: on ties the EARLIEST date wins, because the family
 * needs to know when it first gets tight, not the last time it stays tight.
 */
export interface LowWaterMark {
  /** `YYYY-MM-DD`. */
  readonly date: string;
  /** Signed. Negative means a projected overdraft. */
  readonly balance: string;
}

/**
 * What the household may spend without breaching its own floor (ADR-038 §5).
 *
 * `amount` is clamped at zero and never negative: a negative figure is not an
 * allowance of minus two hundred dollars, it is a SHORTFALL, and it is reported
 * as one via `clampedAtZero` plus `bindingDate` rather than as a nonsense
 * number the UI would have to special-case anyway.
 */
export interface SafeToSpend {
  /** `min(closing) − floor`, clamped at zero. Non-negative. */
  readonly amount: string;
  /** The date that bound the figure — the low-water date. `null` on an empty horizon. */
  readonly bindingDate: string | null;
  /** The floor that was subtracted, echoed so the number is never mistaken for a balance. */
  readonly floor: string;
  /** True when the projection dips below the floor: a shortfall, not an allowance. */
  readonly clampedAtZero: boolean;
  /**
   * How far below the floor the low point falls, when `clampedAtZero`. A
   * positive magnitude, `null` otherwise. The clamp must not destroy the size of
   * the problem — "you are short" and "you are short by $1,400" are different
   * sentences and the family acts on the second.
   */
  readonly shortfall: string | null;
}

/**
 * How much of the projection is honest, in four named levels (ADR-038 §7).
 *
 *   - `no_operating_account` — no `checking`/`cash_management` account is
 *     classified, so there is no balance to project. **No projection at all**,
 *     with the missing input named and linked. Never a projection from savings.
 *   - `insufficient_history` — under three months of transactions. Obligations
 *     still render on the calendar; there is no residual rate, because a rate
 *     from six weeks of data is a guess wearing a decimal point.
 *   - `run_rate_only` — no confirmed obligations, so the line is a pure run-rate
 *     and is LABELLED as one, with the detection candidates offered as the fix.
 *   - `ok` — obligations and history both present.
 *
 * Thin coverage is not a fifth level: it is a percentage shown beside an `ok`
 * number, because the projection is still the best available answer and hiding
 * it would be worse than qualifying it.
 */
export type ProjectionStatus =
  | "ok"
  | "run_rate_only"
  | "insufficient_history"
  | "no_operating_account";

/** The assembled projection, as a surface renders it. */
export interface ProjectionResult {
  /** One point per day from `from` through `to`, inclusive and gapless. */
  readonly points: readonly DailyProjectionPoint[];
  /** `null` only when the horizon contains no days. */
  readonly lowWaterMark: LowWaterMark | null;
  readonly safeToSpend: SafeToSpend;
  /** Days walked, inclusive of both ends. Always displayed with the figures. */
  readonly horizonDays: number;
  /** The user's stated buffer, echoed for the same reason `SafeToSpend.floor` is. */
  readonly cashFloor: string;
  /**
   * Share of trailing observed expense attributable to confirmed obligations,
   * as a decimal fraction string in [0, 1] — `null` when there was no observed
   * expense to attribute. `null` and `"0.0000"` are different statements: one
   * says "nothing to measure", the other says "we measured, and none of it is
   * accounted for". The UI renders them differently.
   */
  readonly coverage: string | null;
  readonly status: ProjectionStatus;
  /** The audit trail (ADR-038 §8). Present at every status, including failure. */
  readonly inputsUsed: readonly InputUsed[];
}
