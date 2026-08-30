import type { InputUsed } from "@/lib/advice/types.ts";

/**
 * Net-worth attribution — the phase's vocabulary (P17-01, ADR-039).
 *
 * Round 11's question is "why did our net worth change?", and the answer this
 * phase gives is a decomposition of a *shipped* number, not a second opinion
 * about it:
 *
 *   closing − opening
 *     = saved
 *     + retirementContributions
 *     + debtPrincipalPaid
 *     + investmentReturn
 *     + assetRevaluation
 *     + unexplained
 *
 * ── The endpoints are given; the rungs are the hypothesis ───────────────────
 * `opening` and `closing` come from {@link computeNetWorth} — the same function
 * the dashboard and the net-worth chart already read (ADR-039 §1). Nothing here
 * may recompute them a second way. If attribution disagreed with the chart the
 * user is looking at, the *chart* is what they trust, and attribution would be
 * worse than useless: it would be a second number with equal apparent authority
 * and no way to tell which is wrong.
 *
 * That asymmetry is the whole design. The delta is a fact. The five explained
 * rungs are five independent estimates, each derived from a different source
 * (transactions, an amortization schedule, holdings snapshots). They are not
 * guaranteed to add up, and {@link AttributionRungId} `'unexplained'` is where
 * the shortfall goes.
 *
 * ── `unexplained` is a first-class rung, never a defect ─────────────────────
 * It is reported at full magnitude, always, with named contributors
 * ({@link ResidualDiagnostic}) pointing at the thin inputs that produced it
 * (ADR-039 §4). It is never hidden below a threshold, never clamped to zero,
 * and never quietly folded into an adjacent rung. A residual the user cannot
 * see is a data problem the user cannot fix — and a decomposition that always
 * reconciles perfectly is one that derived a rung from the very balances it
 * claims to explain, which reconciles *by construction* and therefore says
 * nothing at all.
 *
 * ── Nothing here is stored ──────────────────────────────────────────────────
 * Computed on read, every read (ADR-039 §3, the ADR-020/031/032/036 precedent).
 * No table, no migration, no job, no dependency. A stored decomposition would
 * be a cache of a derivation over data the user edits — recategorize one
 * transaction and every stored row is silently stale.
 *
 * ── Money discipline (CLAUDE.md §Money) ─────────────────────────────────────
 * Every monetary field on every type in this file is a `numeric` string, and
 * every arithmetic step that produces one goes through {@link Money}. There is
 * no `number` field anywhere in this module: the only `number`s the phase
 * creates at all are day counts inside the pairing window, and the `Number()`
 * calls Recharts needs, which happen inside the `'use client'` island and
 * nowhere above it.
 */

/**
 * The six rungs, in the order they are presented.
 *
 * A closed `const` tuple plus a derived type — the `CATEGORY_NECESSITIES`
 * shape (ADR-018). The order is the render order of the waterfall and the sort
 * order of {@link AttributionResult.rungs}: the five explained rungs first,
 * `'unexplained'` last, because it is the balancing term and reads as one.
 */
export const ATTRIBUTION_RUNG_IDS = [
  "saved",
  "retirement",
  "debt_principal",
  "investment_return",
  "asset_revaluation",
  "unexplained",
] as const;

export type AttributionRungId = (typeof ATTRIBUTION_RUNG_IDS)[number];

/**
 * One term of the decomposition.
 *
 * `amount` is signed and every rung can legitimately be negative: a household
 * can spend more than it earns (`saved`), a market can fall
 * (`investment_return`), a house can be revalued down (`asset_revaluation`),
 * and `unexplained` takes whichever sign the shortfall has. Only
 * `debt_principal` and `retirement` are non-negative by construction, and that
 * is a property of their sources rather than a clamp applied here.
 */
export interface AttributionRung {
  readonly id: AttributionRungId;
  /** Human label as rendered: "Saved from income", "Loan principal paid". */
  readonly label: string;
  /** Signed money string. Contributes to the identity exactly as written. */
  readonly amount: string;
  /**
   * The audit trail for this rung specifically (ADR-039 §5).
   *
   * Every rung carries one, including `'unexplained'` — a number a household
   * reads as "where our money went" has to be able to say where it came from,
   * or it is a claim rather than a measurement.
   */
  readonly inputsUsed: readonly InputUsed[];
}

/**
 * How much of an answer the data supports (ADR-039, the `RecommendationStatus`
 * precedent).
 *
 * Degrading is a normal outcome, not an error path. On a fresh install
 * `'no_snapshots'` *is* the correct answer, and the UI renders it as plainly as
 * it renders a full decomposition — with the reason named, so the user knows
 * what to do about it rather than seeing an empty chart.
 */
export type AttributionStatus = "ok" | "insufficient_history" | "no_snapshots";

/**
 * The closed set of residual contributors (P17-16/17/18, ADR-039 §4).
 *
 * Closed on purpose. The residual is only useful if every cause it can name is
 * one the app knows how to explain and link to — an open-ended `string` would
 * let a future contributor add a code that the UI has no copy for and the
 * Round-16 data-contract registry cannot enumerate (ADR-039 consequence 3).
 * Adding a member here is the deliberate act of adding a cause.
 *
 * Ordered by how fundamental the problem is, which is NOT the render order —
 * diagnostics sort by magnitude (see {@link ResidualDiagnostic.magnitude}).
 */
export const RESIDUAL_DIAGNOSTIC_CODES = [
  "untracked_loan",
  "snapshot_gap",
  "manual_balance_accounts",
  "uncategorized",
  "unpaired_transfers",
  "unmatched_investment_deposits",
  "quantity_drift",
] as const;

export type ResidualDiagnosticCode = (typeof RESIDUAL_DIAGNOSTIC_CODES)[number];

/**
 * A named contributor to `unexplained`, with somewhere to go and fix it.
 *
 * The residual on its own is a verdict. The residual plus "you have $4,200 of
 * uncategorized transactions in this window" is an instruction, which is the
 * difference between a number that erodes trust and one that improves the data.
 */
export interface ResidualDiagnostic {
  /** Stable machine code from the closed set above. */
  readonly code: ResidualDiagnosticCode;
  /** Human label: "Transfers to accounts this app doesn't track". */
  readonly label: string;
  /** One sentence of specifics, including counts where they help. */
  readonly detail: string;
  /**
   * Unsigned money magnitude — how much money this contributor involves.
   *
   * Deliberately a magnitude and not a signed contribution: this is *not* a
   * claim that fixing it would move `unexplained` by exactly this much, and
   * presenting it as signed would imply an arithmetic relationship the app
   * cannot honestly assert. Diagnostics sort by it, descending.
   */
  readonly magnitude: string;
  /** In-app route where the user can act on it, e.g. `/analysis/review`. */
  readonly href?: string;
}

/** The full answer for one window. */
export interface AttributionResult {
  /** Window start, `YYYY-MM-DD`, inclusive. */
  readonly from: string;
  /** Window end, `YYYY-MM-DD`, inclusive. */
  readonly to: string;
  /** Net worth at `from`, from {@link computeNetWorth}. Never recomputed here. */
  readonly opening: string;
  /** Net worth at `to`, from {@link computeNetWorth}. Never recomputed here. */
  readonly closing: string;
  /** `closing − opening`. The fact the rungs are a hypothesis about. */
  readonly delta: string;
  /**
   * The six rungs in {@link ATTRIBUTION_RUNG_IDS} order, always all six.
   *
   * A rung is never omitted for being zero: "we checked and it was nothing"
   * and "we did not look" are different statements, and dropping the row makes
   * them indistinguishable.
   */
  readonly rungs: readonly AttributionRung[];
  /** Named contributors to `unexplained`, magnitude descending. */
  readonly diagnostics: readonly ResidualDiagnostic[];
  readonly status: AttributionStatus;
  /** Window-level inputs: the endpoints, the snapshot dates actually used. */
  readonly inputsUsed: readonly InputUsed[];
}
