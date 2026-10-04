import type { PlannedExpenseStatus } from "@/db/schema/planned-expenses.ts";
import type { InputUsed } from "@/lib/advice/types.ts";

/**
 * The sinking-fund contract (Phase 18, P18-05, ADR-044 / ADR-045 / ADR-046).
 *
 * Every shape this phase produces is declared here, once: the cost stream, the
 * accrual, the requirement, the availability, the status ladder and the
 * collision warning. The accrual math, the stream builder, the rule, the loader
 * and `/plan/sinking` speak these and nothing else.
 *
 * ── Money discipline ───────────────────────────────────────────────────────
 * Every money-valued field is a `numeric(18,2)` string (CLAUDE.md §Money), and
 * every one of them is a POSITIVE MAGNITUDE — there is no signed field in this
 * phase, because there is no inflow in it. A sinking fund answers one question
 * ("how much should already be set aside?") and the answer cannot be negative;
 * the two ways it could *look* negative are both represented as separate
 * non-negative fields instead ({@link SinkingAvailability.gap} and
 * `.surplus`), so no consumer has to read a sign to know which it is.
 *
 * **The only `number` fields in this module are counts**:
 * {@link AccruedCost.totalMonths}, `.elapsedMonths`,
 * {@link SinkingRequirement.costCount} and `.pastDueCount`. Whole months and
 * row counts are integers that no arithmetic will ever turn into cents, and
 * typing them as strings would mean parsing them back to divide — which is the
 * one operation this phase has to get right.
 *
 * ── Nothing here is persisted ──────────────────────────────────────────────
 * ADR-032 §3, and it is the load-bearing rule of the phase rather than a
 * convention. What the database stores is the COST — `planned_expenses` rows and
 * `scheduled_obligations` / `obligation_occurrences` rows. The requirement, the
 * per-month set-aside and the availability are computed on read and stored
 * nowhere. A stored `requiredToday` would be a second source of truth that goes
 * stale the moment a balance moves, and a stored "funded so far" would be the
 * envelope system CLAUDE.md §Domain Scope rules out. **There is no field in
 * this file that records where money "is."** Deleting every planned-expense row
 * leaves the household's money exactly where it was.
 *
 * ── Why `InputUsed` is imported rather than redeclared ─────────────────────
 * ADR-038 §8, followed by Phase 17 and followed again here. A user who
 * disagrees with the requirement has to be able to find the wrong INPUT rather
 * than conclude the feature is untrustworthy, and that audit-trail shape already
 * ships. A second parallel declaration would mean a second renderer, and the
 * second one would drift. The import is TYPE-ONLY, so this module pulls no
 * `server-only` code into a client bundle — the erasure
 * [advice/types.ts](../advice/types.ts) already relies on for `AdviceInput`.
 * {@link PlannedExpenseStatus} is imported the same way, for the same reason:
 * its declaring module is a Drizzle module.
 */

export type { InputUsed };

/**
 * Where a known future cost came from (ADR-045 §1).
 *
 * Two sources, deliberately: the one-off costs the household recorded in
 * `planned_expenses`, and the non-monthly occurrences of obligations it already
 * confirmed on the calendar. Both are costs the household knows about; what
 * differs is which table states them. The badge on `/plan/sinking` renders this
 * field, so a reader can tell why a row they do not remember typing is there.
 */
export type CostSource = "planned_expense" | "obligation";

/**
 * Whether a cost is still coming, and therefore whether it still accrues.
 *
 * **Aliased to the column's vocabulary rather than redeclared**, so the stream
 * and the table cannot disagree about what `paid` means. Obligation-sourced
 * costs enter as `planned`: the stream admits only `scheduled` occurrences
 * (P18-10), and a `matched` / `missed` / `skipped` occurrence is simply not in
 * the stream to carry a status at all.
 *
 * ADR-044 §7: a `paid` or `cancelled` cost accrues `"0.00"` and is excluded
 * from every total, while staying visible with its status — deactivate, never
 * delete (CLAUDE.md §Database).
 */
export type CostStatus = PlannedExpenseStatus;

/**
 * One dated cost the household already knows about.
 *
 * The common shape both sources map into, so [accrual.ts](./accrual.ts) never
 * learns which table a row came from. Dates are inclusive UTC-midnight
 * `YYYY-MM-DD` strings, the phase-wide convention.
 *
 * `fundingStart` is **stated, never inferred** (ADR-044 §4). For a planned
 * expense it is the stored `accrual_start_date`; for an obligation occurrence it
 * is the previous occurrence's due date, which is the honest reading — you have
 * had since the last premium to save for the next one. The two inferences this
 * phase deliberately rejects are `created_at` (a displayed figure must not move
 * for reasons the user cannot see) and `due_date − 12 months` (which would tell
 * a household that recorded a cost yesterday it is already thousands behind).
 */
export interface KnownFutureCost {
  readonly source: CostSource;
  /** `planned_expenses.id` or `obligation_occurrences.id`. Never displayed. */
  readonly sourceId: string;
  /** What the user sees. Free text, PII, never parsed and never logged. */
  readonly label: string;
  /** Positive magnitude, a `numeric(18,2)` string. */
  readonly amount: string;
  readonly currency: string;
  /** When the cost lands. May be in the past — see {@link AccruedCost.pastDue}. */
  readonly dueDate: string;
  /** When accrual starts: the denominator's left edge. See above. */
  readonly fundingStart: string;
  readonly status: CostStatus;
  /** Optional category, so a cost can be read beside its budget. */
  readonly categoryId: string | null;
}

/**
 * One cost with its accrual resolved (ADR-044).
 *
 * `requiredToday` is **the authoritative figure** and `perMonth` is a display
 * figure derived separately; they can differ by a cent or two and
 * [accrual.ts](./accrual.ts)'s header says why rather than leaving a reader to
 * discover it from a failing test.
 */
export interface AccruedCost {
  readonly cost: KnownFutureCost;
  /** Whole months from `fundingStart` to `dueDate`, floored at 1. A count. */
  readonly totalMonths: number;
  /** Whole months from `fundingStart` to today, clamped to `[0, totalMonths]`. */
  readonly elapsedMonths: number;
  /** `amount ÷ totalMonths` — what to set aside each month. */
  readonly perMonth: string;
  /** `amount × elapsedMonths ÷ totalMonths` — what should already be held. */
  readonly requiredToday: string;
  /** True when a still-`planned` cost's due date has passed. */
  readonly pastDue: boolean;
}

/**
 * The household-level requirement over the horizon (ADR-045 §5).
 *
 * `requiredToday` and `perMonth` are **sums of the per-cost figures**, so the
 * page's itemized table always adds up to its own header. A reader who checks
 * the arithmetic has to be able to — PLAN17's "a waterfall that does not add up
 * is not a waterfall", applied to a table.
 */
export interface SinkingRequirement {
  /** Inclusive horizon start, normally today. */
  readonly horizonFrom: string;
  /** Inclusive horizon end: 12 months out (ADR-045 §5). */
  readonly horizonTo: string;
  /** Itemized, in the stream's deterministic order. */
  readonly costs: readonly AccruedCost[];
  readonly requiredToday: string;
  readonly perMonth: string;
  /** How many costs contributed. Drives the "N known costs" copy. */
  readonly costCount: number;
  readonly pastDueCount: number;
}

/**
 * What the household actually has against that requirement (ADR-046 §1/§2).
 *
 * **"Available" is the reserve tier ABOVE the emergency-fund target**, not the
 * whole reserve: money already doing the emergency fund's job cannot also be
 * doing the sinking fund's. Every field is `null` when it genuinely cannot be
 * computed — a missing essential baseline makes the target unknowable, and an
 * unknown target makes `available` unknowable with it. `null` is never
 * substituted with `"0.00"`; the two are different statements and the UI renders
 * them differently (the rule [advice/statistics.ts](../advice/statistics.ts)
 * carries the whole advice phase on).
 *
 * `gap` and `surplus` are mutually exclusive and both non-negative — exactly one
 * is non-zero, and which one it is is the answer the page leads with.
 */
export interface SinkingAvailability {
  /** `cash.reserve.total` — the reserve tier's balance. */
  readonly reserveTotal: string;
  /** `essentials.monthly × reserveMonthsFor(...)`, or `null`. */
  readonly emergencyTarget: string | null;
  /** `max(0, reserveTotal − emergencyTarget)`, or `null` when the target is. */
  readonly available: string | null;
  /** `max(0, requiredToday − available)`, or `null`. */
  readonly gap: string | null;
  /** `max(0, available − requiredToday)`, or `null`. */
  readonly surplus: string | null;
}

/**
 * Why a figure is or is not available (ADR-046 §4/§5).
 *
 * One vocabulary, resolved by the one function in [status.ts](./status.ts), so
 * the page and the advice rule cannot disagree about *why* something is missing.
 *
 * `no_costs_recorded` is **not** success. A household that has recorded nothing
 * has an unknown requirement, not a met one, and ADR-046 §5 makes the rule emit
 * `unknown_input` rather than `ok` for exactly that case — reporting "you're on
 * track" to someone who has not told the app about their roof is the one failure
 * mode that would make this feature actively harmful.
 */
export type SinkingStatus = "ok" | "no_costs_recorded" | "no_baseline";

/**
 * A planned expense that looks like an obligation occurrence (ADR-045 §4).
 *
 * The same cost entered twice would double the requirement, and the household
 * would have no way to tell from the total. So entry warns — and that is all it
 * does. **This never merges, never filters, and never changes a total**: a
 * genuine coincidence (two $400 costs in the same week) is common enough that
 * silently dropping one would be worse than showing both, and the app cannot
 * know which case it is looking at. The form names the colliding obligation,
 * links to it, and offers "record it anyway" as a first-class path.
 */
export interface CostCollision {
  /** The label the user just typed. PII — never logged. */
  readonly plannedLabel: string;
  readonly obligationId: string;
  readonly obligationLabel: string;
  /** The colliding occurrence's due date. */
  readonly dueDate: string;
  /** The occurrence's expected amount. */
  readonly amount: string;
}
