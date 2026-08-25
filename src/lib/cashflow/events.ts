import type {
  ObligationAmountMode,
  ObligationDirection,
} from "@/db/schema/scheduled-obligations.ts";
import { Money } from "@/lib/money/money.ts";
import type { ObligationCadence } from "@/lib/schedule/cadence.ts";
import { occurrenceDatesBetween } from "@/lib/schedule/occurrences.ts";
import type { IncomeEvent, ObligationEvent } from "./types.ts";

/**
 * Event expansion — turning schedules into dated money (P16-14, ADR-038 §1/§3).
 *
 * Pure and I/O-free. Both functions are thin lifecycle wrappers around the ONE
 * occurrence expander (`occurrenceDatesBetween`, ADR-036 §5); neither does date
 * math of its own, and that is deliberate — a second copy of clamping arithmetic
 * is how a month-length bug gets fixed on the income side and not the bill side.
 *
 * ── What these functions actually decide ───────────────────────────────────
 * Not "when does a monthly bill land" — that is the expander's answer, tested
 * there. What is decided here is which of those dates are REAL, which is the
 * `active` / `start_date` / `end_date` lifecycle:
 *
 *   - `active = false` emits nothing. A deactivated obligation is one the user
 *     deliberately turned off; projecting it is worse than forgetting it,
 *     because the household would budget around a bill it no longer pays.
 *   - `start_date` and `end_date` INTERSECT the caller's window rather than
 *     filtering its output, so the expander is never asked for dates that will
 *     be discarded. `end_date` is inclusive — the column means "the last date
 *     occurrences may be materialized through".
 *   - A lifecycle that does not meet the window yields an empty list, never an
 *     inverted one (`occurrenceDatesBetween` also returns `[]` on an inverted
 *     window, so this is belt and braces on the cheap side).
 *
 * ── Amounts ───────────────────────────────────────────────────────────────
 * Obligations project at their stated `expected_amount`, positive, with the
 * sign living in `direction` exactly as the column does. Income projects at
 * OBSERVED TAKE-HOME supplied by the caller, never at
 * `income_sources.gross_per_period` — ADR-038 §3 rules gross out because
 * projecting it into a checking account overstates every inflow by the whole
 * withholding stack, and errs in the optimistic direction that gets a household
 * into trouble rather than out of it. `gross_per_period` is deliberately not a
 * parameter of anything in this file.
 *
 * ── Ordering ──────────────────────────────────────────────────────────────
 * Output is sorted by `(date, label, id)`. The tiebreakers exist so a projection
 * is byte-identical across runs and across input orderings — a chart whose
 * same-day events reshuffle on every poll looks broken even when the arithmetic
 * is right, and a non-deterministic list makes test failures unreadable.
 */

const CURRENCY = "USD";

/** A confirmed obligation, as the projection reads it. Mirrors the table's columns. */
export interface ObligationInput {
  readonly id: string;
  readonly label: string;
  /** Positive magnitude — the sign is `direction`. */
  readonly expectedAmount: string;
  readonly direction: ObligationDirection;
  readonly amountMode: ObligationAmountMode;
  readonly cadence: ObligationCadence;
  /** A known-real occurrence date; phases the schedule. */
  readonly anchorDate: string;
  readonly startDate: string;
  /** Inclusive last date; `null` = open-ended. */
  readonly endDate: string | null;
  readonly active: boolean;
}

/** An income source, as the projection reads it. `gross_per_period` is absent by design. */
export interface IncomeSourceInput {
  readonly id: string;
  readonly name: string;
  readonly cadence: ObligationCadence;
  readonly anchorDate: string;
  readonly startDate: string;
  readonly endDate: string | null;
  readonly active: boolean;
}

/** The live window of a schedule inside a projection horizon, or `null` if they miss. */
function lifespan(
  schedule: {
    readonly startDate: string;
    readonly endDate: string | null;
    readonly active: boolean;
  },
  from: string,
  to: string,
): { from: string; to: string } | null {
  if (!schedule.active) return null;
  // ISO `YYYY-MM-DD` compares correctly as a string; no parsing needed to
  // intersect, and `occurrenceDatesBetween` validates the survivors anyway.
  const start = schedule.startDate > from ? schedule.startDate : from;
  const end = schedule.endDate !== null && schedule.endDate < to ? schedule.endDate : to;
  return start > end ? null : { from: start, to: end };
}

/** Stable order for a merged event list: by date, then label, then id. */
function byDateLabelId<T extends { date: string; label: string }>(idOf: (e: T) => string) {
  return (a: T, b: T): number => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    if (a.label !== b.label) return a.label < b.label ? -1 : 1;
    const ia = idOf(a);
    const ib = idOf(b);
    return ia === ib ? 0 : ia < ib ? -1 : 1;
  };
}

/**
 * Expand confirmed obligations into dated events across an inclusive window.
 *
 * @param obligations - Confirmed obligations. Inactive ones are skipped.
 * @param from - Inclusive horizon start, `YYYY-MM-DD`.
 * @param to - Inclusive horizon end, `YYYY-MM-DD`.
 * @returns Events ascending by `(date, label, obligationId)`. Inputs untouched.
 * @throws If any date is not a real `YYYY-MM-DD`, or a cadence is unknown
 *   (both from `occurrenceDatesBetween` — a bad schedule fails loudly rather
 *   than quietly dropping a bill out of the projection).
 */
export function expandObligationEvents(
  obligations: readonly ObligationInput[],
  from: string,
  to: string,
): ObligationEvent[] {
  const events: ObligationEvent[] = [];

  for (const obligation of obligations) {
    const window = lifespan(obligation, from, to);
    if (window === null) continue;

    // Normalize through Money so a "2150" from a hand-written fixture and a
    // "2150.00" from Postgres produce the same event.
    const amount = Money.fromString(obligation.expectedAmount, CURRENCY).abs().toString();

    for (const date of occurrenceDatesBetween(
      obligation.cadence,
      obligation.anchorDate,
      window.from,
      window.to,
    )) {
      events.push({
        kind: "obligation",
        date,
        amount,
        direction: obligation.direction,
        label: obligation.label,
        obligationId: obligation.id,
        amountMode: obligation.amountMode,
      });
    }
  }

  return events.sort(byDateLabelId((e) => e.obligationId));
}

/**
 * Expand income sources into dated paycheck events priced at observed take-home.
 *
 * A source with no entry in `netPerPeriod` is SKIPPED rather than projected at
 * zero. A source that has never deposited has no honest per-period figure, and a
 * "$0.00 paycheck" on the calendar is indistinguishable from a real one that
 * happened to be zero. The caller is responsible for naming any skipped source
 * as a missing input (ADR-038 §7/§8) — silence here, visibility there.
 *
 * @param sources - Income sources. Inactive ones are skipped.
 * @param netPerPeriod - Source id → observed take-home per period, from
 *   `observedNetIncome`'s trailing median (ADR-034 §1). Never gross.
 * @param from - Inclusive horizon start, `YYYY-MM-DD`.
 * @param to - Inclusive horizon end, `YYYY-MM-DD`.
 * @returns Events ascending by `(date, label, incomeSourceId)`. Inputs untouched.
 * @throws If a supplied per-period figure is negative. An inflow that drains the
 *   account is a data error upstream, and projecting it would move the
 *   low-water mark in the direction nobody would think to question.
 */
export function expandIncomeEvents(
  sources: readonly IncomeSourceInput[],
  netPerPeriod: ReadonlyMap<string, string>,
  from: string,
  to: string,
): IncomeEvent[] {
  const events: IncomeEvent[] = [];

  for (const source of sources) {
    const observed = netPerPeriod.get(source.id);
    if (observed === undefined) continue;

    const amount = Money.fromString(observed, CURRENCY);
    if (amount.isNegative()) {
      throw new Error(`Income source ${source.id} has a negative per-period amount`);
    }

    const window = lifespan(source, from, to);
    if (window === null) continue;

    for (const date of occurrenceDatesBetween(
      source.cadence,
      source.anchorDate,
      window.from,
      window.to,
    )) {
      events.push({
        kind: "income",
        date,
        amount: amount.toString(),
        direction: "inflow",
        label: source.name,
        incomeSourceId: source.id,
      });
    }
  }

  return events.sort(byDateLabelId((e) => e.incomeSourceId));
}
