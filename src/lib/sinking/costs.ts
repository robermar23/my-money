import type { ObligationOccurrenceStatus } from "@/db/schema/obligation-occurrences.ts";
import type { PlannedExpenseStatus } from "@/db/schema/planned-expenses.ts";
import type { ObligationDirection } from "@/db/schema/scheduled-obligations.ts";
import { Money } from "@/lib/money/money.ts";
import type { ObligationCadence } from "@/lib/schedule/cadence.ts";
import { isSinkingEligible } from "./cadence.ts";
import type { KnownFutureCost } from "./types.ts";

/**
 * The known-future-cost stream (P18-10, ADR-045) — the union of the two tables
 * that can state a dated cost, mapped into one shape.
 *
 * Pure and I/O-free, over ALREADY-FETCHED rows. The parameter types below are
 * structural subsets of the real tables rather than Drizzle inferences, the
 * `FlowTxn` precedent from P17-02: this module imports no table object, so it
 * pulls no `drizzle-orm/pg-core` into anything that transitively imports it, and
 * a test can state a cost in six lines instead of inserting one.
 *
 * ── Why the stream spans two sources ──────────────────────────────────────
 * Round 12's own sentence — *"$2,180 against the four known costs in the next 12
 * months"* — opens with $1,340 of car insurance every March, which is an
 * `annual` **obligation**, not a planned expense. A requirement over
 * `planned_expenses` alone would omit the very bill that motivated the feature.
 * So (a) one-off `planned_expenses` and (b) non-monthly `obligation_occurrences`
 * both map into {@link KnownFutureCost}, and everything downstream — the
 * accrual, the total, the rule, the page — sees one shape and never learns which
 * table a row came from.
 *
 * ── The double-count gate ─────────────────────────────────────────────────
 * Eligibility is {@link isSinkingEligible}'s decision, not this module's, and
 * [cadence.ts](./cadence.ts) states the $16,000 arithmetic behind it. What
 * matters here is that the filter is a **type predicate**, so the exclusion is
 * carried in the type rather than re-asserted — and that
 * [costs.test.ts](./costs.test.ts) asserts a monthly obligation's absence BY
 * NAME, because a length assertion would survive a widening of the set.
 *
 * ── Occurrences are read, never re-expanded ───────────────────────────────
 * ADR-045 rejected re-expanding schedules here: two answers to "when is this
 * due" is how they drift. The consequence is that the stream sees only as far as
 * the materializer has written, which at the shipped cash-flow defaults is about
 * 90 days against a 365-day horizon — so [coverage.ts](./coverage.ts) widens the
 * materialization lead for exactly the eligible cadences. That is P18-11, and it
 * is the difference between this feature being right and being quietly 80% low.
 *
 * ── `fundingStart`, stated or derived but never guessed ───────────────────
 *   - A planned expense carries its own stored `accrual_start_date` (ADR-044 §4).
 *   - An obligation occurrence derives it from **the previous occurrence's due
 *     date, whatever that occurrence's status** — you have had since last March
 *     to save for next March, and a skipped or missed premium still consumed the
 *     calendar time. It falls back to the horizon start when there is no earlier
 *     occurrence at all, which is the honest answer for a schedule confirmed
 *     today: *"you have had since today"*, never *"you are a year behind"*.
 *
 * The lookup therefore needs occurrence rows from BEFORE the horizon. The loader
 * (P18-19) must fetch a window wider than the horizon on the past side, or every
 * newly-covered cost silently falls back to the horizon start and over-states
 * how little time the household has had.
 *
 * ── The horizon has an upper edge only ────────────────────────────────────
 * `dueDate <= horizonTo` bounds the future: a cost thirteen months out
 * contributes nothing today (ADR-045 §5's accepted hard edge). There is
 * deliberately **no lower bound**. A still-`planned` cost whose date has passed
 * is not outside the horizon, it is OVERDUE; ADR-044 §5 requires its full amount,
 * the page gives it two actions, and dropping it here would understate the
 * requirement — the dangerous direction — while making
 * `SinkingRequirement.pastDueCount` permanently zero.
 *
 * ── Determinism ───────────────────────────────────────────────────────────
 * Output is sorted by `(dueDate, label, sourceId)`, the same argument
 * [cashflow/events.ts](../cashflow/events.ts) makes: an itemized table whose
 * same-day rows reshuffle between two reads of unchanged data looks broken even
 * when the arithmetic is right, and a non-deterministic list makes a test failure
 * unreadable. Inputs are never mutated.
 *
 * ── Privacy ───────────────────────────────────────────────────────────────
 * `label` is household free text — *"Emma's braces"* — and it is copied, sorted
 * and never parsed, logged, or sent anywhere. Nothing in this module reaches
 * `console` or the network (P18-33 enforces it).
 */

/** A `planned_expenses` row, as the stream reads it. */
export interface PlannedExpenseRow {
  readonly id: string;
  readonly label: string;
  /** Positive magnitude, a `numeric(18,2)` string. */
  readonly amount: string;
  readonly currency: string;
  readonly dueDate: string;
  /** The stored `accrual_start_date` — stated, never inferred (ADR-044 §4). */
  readonly accrualStartDate: string;
  readonly status: PlannedExpenseStatus;
  readonly categoryId: string | null;
}

/** The `scheduled_obligations` columns an occurrence's eligibility depends on. */
export interface CostStreamObligation {
  readonly id: string;
  readonly label: string;
  readonly currency: string;
  readonly cadence: ObligationCadence;
  readonly direction: ObligationDirection;
  readonly active: boolean;
  readonly categoryId: string | null;
}

/**
 * An `obligation_occurrences` row.
 *
 * `expectedAmount` is the SNAPSHOTTED figure, which is the auditable one: an
 * `amount_mode='trailing_median'` obligation re-prices over time, and the
 * estimate actually written for a given due date is the one the requirement
 * should state. That it will move is disclosed on the page, as ADR-038 already
 * discloses it for the projection.
 */
export interface OccurrenceRow {
  readonly id: string;
  readonly obligationId: string;
  readonly dueDate: string;
  readonly expectedAmount: string;
  readonly status: ObligationOccurrenceStatus;
}

export interface CostStreamInput {
  /** Inclusive horizon start, normally today. The `fundingStart` fallback. */
  readonly horizonFrom: string;
  /** Inclusive horizon end: `horizonFrom` + `SINKING_HORIZON_MONTHS`. */
  readonly horizonTo: string;
  readonly plannedExpenses: readonly PlannedExpenseRow[];
  readonly obligations: readonly CostStreamObligation[];
  /**
   * Occurrences for those obligations, INCLUDING rows before `horizonFrom` —
   * the previous one dates the accrual window. See the header.
   */
  readonly occurrences: readonly OccurrenceRow[];
}

/** Stable order: due date, then label, then the source row's id. */
function byDueDateLabelId(a: KnownFutureCost, b: KnownFutureCost): number {
  if (a.dueDate !== b.dueDate) return a.dueDate < b.dueDate ? -1 : 1;
  if (a.label !== b.label) return a.label < b.label ? -1 : 1;
  return a.sourceId === b.sourceId ? 0 : a.sourceId < b.sourceId ? -1 : 1;
}

/**
 * Build the stream of costs a household already knows about.
 *
 * @param input - The horizon and the already-fetched rows from both sources.
 * @returns Costs ascending by `(dueDate, label, sourceId)`. Inputs untouched.
 *   Every cost has `status: "planned"` — a settled planned expense and a
 *   decided occurrence are both filtered out here, and ADR-044 §7's `"0.00"` in
 *   `accrue` is the deliberately redundant second guard.
 * @throws Nothing. A malformed date is not parsed here; it surfaces in `accrue`
 *   through the one shipped `parseIsoDate`, so this module writes no date math
 *   and inherits that validation rather than duplicating it (ADR-036 §5).
 */
export function buildCostStream(input: CostStreamInput): readonly KnownFutureCost[] {
  const costs: KnownFutureCost[] = [];

  for (const row of input.plannedExpenses) {
    // ADR-045 §1a. A `paid` or `cancelled` cost is not a future cost; it stays
    // listed on the page with its status (deactivate, never delete), but it has
    // no ask.
    if (row.status !== "planned") continue;
    if (row.dueDate > input.horizonTo) continue;

    costs.push({
      source: "planned_expense",
      sourceId: row.id,
      label: row.label,
      // Normalized through Money so a hand-written "6000" and a Postgres
      // "6000.00" produce the same cost. `abs` because the column is a
      // magnitude with a non-negativity CHECK; a sign here would be a data error
      // upstream, not something to propagate into a requirement.
      amount: Money.fromString(row.amount, row.currency).abs().toString(),
      currency: row.currency,
      dueDate: row.dueDate,
      fundingStart: row.accrualStartDate,
      status: row.status,
      categoryId: row.categoryId,
    });
  }

  const obligationsById = new Map(input.obligations.map((row) => [row.id, row]));

  for (const row of input.occurrences) {
    // Only `scheduled` accrues (ADR-045 §1b): a `matched` occurrence has been
    // paid, a `missed` one closed its window, and a `skipped` one is the user
    // saying it is not happening. None of the three is a cost still to cover.
    if (row.status !== "scheduled") continue;
    if (row.dueDate > input.horizonTo) continue;

    const obligation = obligationsById.get(row.obligationId);
    // An occurrence with no parent row in the input carries no label, no
    // currency and no eligibility verdict, so it cannot become a cost. Silence
    // is right here: the loader's query joins the parent, so this is a
    // programming error rather than a household's missing input.
    if (obligation === undefined) continue;
    if (!obligation.active) continue;
    // ADR-045 §6 — money arriving needs no set-aside.
    if (obligation.direction !== "outflow") continue;
    // THE gate. See the header and [cadence.ts](./cadence.ts).
    if (!isSinkingEligible(obligation.cadence)) continue;

    costs.push({
      source: "obligation",
      sourceId: row.id,
      label: obligation.label,
      amount: Money.fromString(row.expectedAmount, obligation.currency).abs().toString(),
      currency: obligation.currency,
      dueDate: row.dueDate,
      fundingStart: previousDueDate(input.occurrences, row) ?? input.horizonFrom,
      // An occurrence in the stream is by construction still coming; the
      // settled states were filtered above, so there is nothing else it can be.
      status: "planned",
      categoryId: obligation.categoryId,
    });
  }

  return costs.sort(byDueDateLabelId);
}

/**
 * The due date of the most recent occurrence of the same obligation strictly
 * before `occurrence`, whatever its status.
 *
 * A linear scan rather than a pre-built index: the occurrence set for one
 * household's non-monthly obligations is tens of rows, and an index would
 * trade a measurable nothing for a second structure to keep correct
 * (§Performance — profile before optimizing).
 *
 * @returns The previous due date, or `null` when this is the first occurrence
 *   the obligation has.
 */
function previousDueDate(
  occurrences: readonly OccurrenceRow[],
  occurrence: OccurrenceRow,
): string | null {
  let previous: string | null = null;
  for (const row of occurrences) {
    if (row.obligationId !== occurrence.obligationId) continue;
    // ISO `YYYY-MM-DD` compares correctly as a string, so no parsing is needed
    // to order two dates.
    if (row.dueDate >= occurrence.dueDate) continue;
    if (previous === null || row.dueDate > previous) previous = row.dueDate;
  }
  return previous;
}
