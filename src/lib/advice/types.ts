import type { AdviceInput } from "./snapshot.ts";

/**
 * The rules-engine contract (Phase 15, PLAN15 P15-13, ADR-032 §2).
 *
 * Everything the advice layer produces is described here, once. Batch 3's rules,
 * Batch 4's budget rules, the engine, the dashboard card and the `/advice` page
 * all speak these shapes and nothing else.
 *
 * ── Why the shape is this shape ────────────────────────────────────────────
 * ADR-032 §2 requires every recommendation to be **auditable**: it names the
 * heuristic it implements and shows the inputs it read, so a user who disagrees
 * can find the *wrong input* rather than concluding the whole feature is
 * untrustworthy. That is why {@link InputUsed} is a first-class part of the
 * contract rather than a debugging afterthought, and why it carries an optional
 * `href` — an input the user can see is an input the user can go fix.
 *
 * ── Degrading honestly is a first-class outcome ────────────────────────────
 * {@link RecommendationStatus} has four members, and three of them are not "do
 * this". A rule whose inputs are missing emits `unknown_input`; a rule the
 * household has already satisfied emits `ok`; a rule the install is too young to
 * answer is gated out entirely by the engine (ADR-034 §7). None of those is an
 * error path — on a fresh install they are the *normal* path, and the UI renders
 * them as plainly as it renders an action. ADR-032 consequence 1: rule quality
 * is bounded by input quality, and that must show.
 *
 * ── Money discipline ───────────────────────────────────────────────────────
 * Every money-valued field is a `numeric` string (CLAUDE.md §Money). `impact` is
 * money because the engine sorts on it through {@link Money}; `confidence` and
 * `severity` are ordinals, not numbers, so nothing is tempted to average them.
 *
 * `AdviceInput` is imported **as a type only**. It is declared in
 * [snapshot.ts](./snapshot.ts), which is `server-only`; the type import is erased
 * at compile time, so a rule module that imports this file gets the shape without
 * ever pulling the database client into its bundle. That erasure is what keeps
 * "every rule is I/O-free" (ADR-032 §1) true at the module-graph level, not just
 * by convention.
 */

/** Ordinal urgency, matching the shipped `alerts.severity` vocabulary. */
export type Severity = "critical" | "warning" | "info";

/** Sort weight for {@link Severity}. Lower sorts first. */
export const SEVERITY_ORDER: Readonly<Record<Severity, number>> = {
  critical: 0,
  warning: 1,
  info: 2,
};

/**
 * How much the household should trust the figure.
 *
 * `low` is not a hedge — it is what a rule says when it read a baseline built on
 * three months of history, or on spend that is 40% unclassified. The UI shows it
 * next to the number rather than suppressing the number.
 */
export type Confidence = "high" | "medium" | "low";

/**
 * What a rule concluded.
 *
 *   - `action` — something is worth doing, with a concrete amount.
 *   - `ok` — the rule was evaluable and the household already satisfies it. Shown
 *     (not hidden), because "your reserve is funded" is worth reading.
 *   - `unknown_input` — a required input is not recorded. Names what is missing
 *     and links to where it is entered. **Never** a guessed value.
 *   - `insufficient_history` — the install is too young for this rule to answer
 *     honestly (ADR-021's precedent, generalized by ADR-034 §7). Produced by the
 *     engine's gating, not usually by a rule itself.
 */
export type RecommendationStatus = "action" | "ok" | "unknown_input" | "insufficient_history";

/**
 * Every rule the engine can run.
 *
 * These strings are persisted in `recommendation_dismissals.rule_id` as plain
 * text (never a FK), so renaming one orphans a dismissal row rather than
 * breaking a migration — the deliberate trade in
 * [recommendation-dismissals.ts](../../db/schema/recommendation-dismissals.ts).
 * Rename only with a reason.
 */
export type RuleId =
  | "emergency_fund"
  | "employer_match"
  | "high_interest_debt"
  | "credit_utilization"
  | "cash_drag"
  | "contribution_pacing"
  | "waterfall"
  /** Batch 4 (P15-25). Declared here so the union has one home. */
  | "budget_coverage"
  /** Batch 4 (P15-26). */
  | "needs_wants_split";

/** How an {@link InputUsed} value should be rendered. Not a unit conversion. */
export type InputKind = "money" | "percent" | "months" | "count" | "date" | "text";

/**
 * One input a recommendation read, as the UI renders it (ADR-032 §2).
 *
 * This is the audit trail. A user who thinks "my essential expenses are nowhere
 * near that" can see the figure, see that it came from a 12-month median, see
 * that 40% of their spend is unclassified, and follow `href` to fix it.
 */
export interface InputUsed {
  /** Human label: "Essential monthly expenses". */
  readonly label: string;
  /**
   * The value as a display string, or `null` when the input is **not recorded**.
   * `null` and `"0.00"` are different statements and the UI renders them
   * differently — see [statistics.ts](./statistics.ts) on why that distinction
   * carries the whole phase.
   */
  readonly value: string | null;
  readonly kind: InputKind;
  /** Where the figure came from: "Median of 12 months of essential spend". */
  readonly source: string;
  /** True when this input is the one blocking the rule. Drives the "fix" affordance. */
  readonly missing?: boolean;
  /** In-app route where the user can correct it, e.g. `/settings/household`. */
  readonly href?: string;
}

/**
 * A single recommendation (ADR-032 §2).
 *
 * Computed on read and never stored (ADR-032 §3) — the only persisted advice
 * state is a dismissal.
 */
export interface Recommendation {
  /**
   * Stable identity, `${ruleId}:${subjectKey}`. Stable across runs so the UI can
   * key a list and an animation does not reshuffle on every poll.
   */
  readonly id: string;
  readonly ruleId: RuleId;
  /**
   * The per-subject discriminator — an account id, a category id, or `''` for a
   * whole-rule recommendation. Matches `recommendation_dismissals.subject_key`
   * exactly, so dismissing "no budget for Groceries" does not dismiss "no budget
   * for Auto".
   */
  readonly subjectKey: string;
  readonly severity: Severity;
  readonly status: RecommendationStatus;
  /** One line, no raw amounts beyond what the authenticated UI already shows. */
  readonly title: string;
  /** Why this is being said, in the user's terms. */
  readonly rationale: string;
  /**
   * The conventional heuristic being implemented, named plainly ("3–6 months of
   * essential expenses"). ADR-032 §2 requires this: an unnamed heuristic is an
   * unfalsifiable one.
   */
  readonly heuristic: string;
  /** The benchmark figure, as a display string. `null` when the rule has none. */
  readonly benchmark: string | null;
  /** Where the household is now. */
  readonly currentValue: string | null;
  /** Where the heuristic says they should be. `null` for `unknown_input`. */
  readonly suggestedValue: string | null;
  /**
   * Money magnitude used to rank within a severity — the gap to close, the
   * dollars left on the table, the interest avoidable. `null` sorts last, which
   * is the right place for a recommendation whose size we could not compute.
   */
  readonly impact: string | null;
  readonly inputsUsed: readonly InputUsed[];
  readonly confidence: Confidence;
}

/** The waterfall rungs, in ADR-034 §4 order. `order` is the index below. */
export type RungId =
  | "starter_buffer"
  | "employer_match"
  | "high_interest_debt"
  | "full_reserve"
  | "ira_hsa"
  | "workplace_plan"
  | "taxable_medium_term";

/**
 * A rung's state (ADR-034 §4).
 *
 *   - `done` — satisfied. **Never reported on absent data**; a rung with a
 *     missing input is `unknown_input`, not `done`. P15-22 tests that property
 *     directly, because "done" on a blank install is the single most damaging
 *     thing this feature could say.
 *   - `in_progress` — the current focus. Exactly one rung holds this at a time.
 *   - `blocked` — comes after an unfinished rung. Not a failure; an ordering
 *     statement ("fund the match before the taxable account").
 *   - `unknown_input` — an input the rung needs is not recorded.
 */
export type RungStatus = "done" | "in_progress" | "blocked" | "unknown_input";

export interface RungState {
  readonly rung: RungId;
  /** Position in the fixed ADR-034 §4 ordering, 0-based. */
  readonly order: number;
  readonly label: string;
  readonly status: RungStatus;
  /** Why the rung is in this state, in one sentence. Always present. */
  readonly reason: string;
  /** The rung's target amount, when it has one. */
  readonly target: string | null;
  /** What the household has against that target. */
  readonly current: string | null;
  /** `max(0, target − current)`. `null` when either side is unknown. */
  readonly gap: string | null;
  /**
   * Whether finishing this rung is a precondition for the ones below it.
   *
   * Almost always `true` — that is what makes a waterfall a waterfall. The
   * exception is a rung the app **structurally cannot verify** rather than one
   * the user has not filled in yet: the IRA/HSA rung reads payroll contributions
   * only, and an IRA funded by a bank transfer leaves no record it can see. Such
   * a rung is reported honestly as `unknown_input` and stepped over, because
   * "we cannot see this" must not permanently block every rung beneath it.
   */
  readonly blocking: boolean;
  readonly inputsUsed: readonly InputUsed[];
}

/**
 * A rule: an id, a history requirement, and a pure evaluation.
 *
 * `evaluate` takes {@link AdviceInput} and **nothing else** — no clock, no
 * database, no environment. The reference date lives on the input so every rule
 * is deterministic and every test is reproducible.
 */
export interface Rule {
  readonly id: RuleId;
  /** Short human name, for the gating notice and the dismissed-items view. */
  readonly title: string;
  /**
   * Months of transaction history below which this rule must not speak
   * (ADR-034 §7). `0` for rules that read only recorded terms — a credit card's
   * APR is just as true on install day as it is a year later.
   */
  readonly minMonthsHistory: number;
  evaluate(input: AdviceInput): Recommendation[];
}

/** Build the stable `${ruleId}:${subjectKey}` identity. */
export function recommendationId(ruleId: RuleId, subjectKey: string): string {
  return `${ruleId}:${subjectKey}`;
}
