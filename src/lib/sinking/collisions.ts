import type { ObligationDirection } from "@/db/schema/scheduled-obligations.ts";
import { Money } from "@/lib/money/money.ts";
import type { ObligationCadence } from "@/lib/schedule/cadence.ts";
import { parseIsoDate } from "@/lib/schedule/occurrences.ts";
import { isSinkingEligible } from "./cadence.ts";
import type { CostCollision } from "./types.ts";

/**
 * Duplicate-entry detection (P18-13, ADR-045 §4) — a warning, and nothing else.
 *
 * The same cost can legitimately exist in both tables: $1,340 of car insurance
 * entered as a one-off planned expense, and the same premium already confirmed
 * as an `annual` obligation. The requirement would then count it twice and the
 * household would have no way to tell from the total.
 *
 * ── What this function does NOT do ────────────────────────────────────────
 * It never merges, never filters, never blocks, and **never changes a total**.
 * No structural rule distinguishes a duplicate from two genuinely different
 * costs on one day for one amount — two $400 costs in the same week is an
 * ordinary thing for a household to have — and the app cannot know which case it
 * is looking at. Silently dropping a real cost from a total is strictly worse
 * than showing it twice next to its own name, so the output is a sentence the
 * entry form renders beside a first-class *"record it anyway"* path (P18-24),
 * which is ADR-036 §2's preview-and-confirm posture applied literally.
 *
 * Matching is on `(amount, due date)` only. **Label similarity is deliberately
 * not computed** — "Auto insurance" versus "Car insurance" versus "State Farm"
 * is exactly the brittle string guess ADR-040 §2 rejected, and getting it wrong
 * in the quiet direction (no warning) is invisible.
 *
 * ── The same eligibility gate as the stream ───────────────────────────────
 * A monthly obligation is not in the cost stream, so it cannot be
 * double-counted, so it is not a collision — however exactly the amounts line
 * up. Re-applying {@link isSinkingEligible} here rather than taking a
 * pre-filtered list keeps the warning and the total agreeing about what is
 * duplicable, and makes the exclusion a test rather than an inherited
 * assumption. A warning that a planned roof *"looks like your Rent"* would be
 * noise, and noise teaches a user to dismiss the warning that matters.
 *
 * ── Tolerances are STATED, not tuned ──────────────────────────────────────
 * {@link COLLISION_TOLERANCE} is exported with the reasoning for each number
 * attached to it, following ADR-040 consequence 2's discipline: these are
 * numbers chosen from how households actually type, not numbers adjusted until
 * the output looked tidy. There is no real series to tune against, and they are
 * a parameter precisely so they can be moved when there is.
 *
 * Pure, I/O-free, and no figure is logged — `label` is household free text
 * (P18-33).
 */

/** How close two costs must be to be worth asking the user about. */
export interface CollisionTolerance {
  /** Days either side of the occurrence's due date. */
  readonly days: number;
  /** Fractional amount tolerance, e.g. `"0.10"`. */
  readonly amountPct: string;
  /** Absolute floor on the amount tolerance, in the occurrence's currency. */
  readonly amountAbs: string;
}

/**
 * The default tolerance.
 *
 * **±10 days**, which is wider than the matcher's ±5
 * ([match.ts](../cashflow/match.ts)) **on purpose**: the matcher compares a
 * posted transaction to a schedule, both machine-dated, while this compares a
 * person's memory of when a bill lands to a schedule phased off an anchor date.
 * "The insurance is due at the start of March" and a schedule that says the 10th
 * are the same bill. Still well short of a month, so two costs in adjacent
 * months are never conflated.
 *
 * **10%**, because a household recalling an annual premium rounds it — "about
 * $1,300" against $1,340 is 3% — while a $440 cost is genuinely not a $400 one.
 *
 * **$5.00 floor**, for the reason the matcher states: a percentage is
 * meaningless on small bills, where 10% of a $40 domain renewal is $4 and a
 * routine price rise would read as a different cost.
 *
 * The asymmetry of the error matters in choosing these: a false warning costs
 * one dismissible sentence, while a missed warning costs a silently
 * double-counted cost. So they are deliberately generous.
 */
export const COLLISION_TOLERANCE: CollisionTolerance = {
  days: 10,
  amountPct: "0.10",
  amountAbs: "5.00",
};

/** The planned expense the user is about to record. */
export interface CollisionCandidate {
  /** What the user typed. PII — never logged, never parsed. */
  readonly label: string;
  readonly amount: string;
  readonly currency: string;
  readonly dueDate: string;
}

/** An occurrence joined to the obligation columns a collision needs. */
export interface CollidableOccurrence {
  readonly obligationId: string;
  readonly obligationLabel: string;
  readonly cadence: ObligationCadence;
  readonly direction: ObligationDirection;
  readonly active: boolean;
  readonly dueDate: string;
  /** The snapshotted `expected_amount`, the fixed reference for the tolerance. */
  readonly expectedAmount: string;
  readonly currency: string;
}

export interface DetectCollisionsOptions {
  readonly tolerance?: CollisionTolerance;
}

const MS_PER_DAY = 86_400_000;

/**
 * Whole days between two `YYYY-MM-DD` dates, unsigned.
 *
 * Through the one shipped ISO parser, so `2027-02-30` throws here exactly as it
 * would anywhere else in the app — the same private-helper shape
 * [cashflow/detect.ts](../cashflow/detect.ts) uses, and deliberately not a new
 * exported date utility (ADR-036 §5).
 */
function daysApart(a: string, b: string): number {
  return Math.abs(parseIsoDate(a, "candidate due date") - parseIsoDate(b, "due date")) / MS_PER_DAY;
}

/** Stable order: due date, then obligation label, then obligation id. */
function byDueDateLabelId(a: CostCollision, b: CostCollision): number {
  if (a.dueDate !== b.dueDate) return a.dueDate < b.dueDate ? -1 : 1;
  if (a.obligationLabel !== b.obligationLabel)
    return a.obligationLabel < b.obligationLabel ? -1 : 1;
  return a.obligationId === b.obligationId ? 0 : a.obligationId < b.obligationId ? -1 : 1;
}

/**
 * Find the eligible obligation occurrences a candidate planned expense looks
 * like a duplicate of.
 *
 * @param candidate - The planned expense the user is about to record.
 * @param occurrences - Occurrences joined to their obligations. Ineligible,
 *   inactive and inflow rows are filtered here rather than by the caller.
 * @param options - Optional tolerance override; defaults to
 *   {@link COLLISION_TOLERANCE}.
 * @returns One collision per colliding obligation occurrence, ascending by
 *   `(dueDate, obligationLabel, obligationId)`. Empty when nothing is close.
 *   **Never affects any total** — the caller renders this as a warning.
 * @throws If a date is not a real `YYYY-MM-DD`, or an amount is not a parsable
 *   decimal — both from the shipped helpers.
 */
export function detectCollisions(
  candidate: CollisionCandidate,
  occurrences: readonly CollidableOccurrence[],
  options: DetectCollisionsOptions = {},
): readonly CostCollision[] {
  const tolerance = options.tolerance ?? COLLISION_TOLERANCE;
  const collisions: CostCollision[] = [];

  for (const row of occurrences) {
    if (!row.active) continue;
    if (row.direction !== "outflow") continue;
    // The same gate as the cost stream's — see the header.
    if (!isSinkingEligible(row.cadence)) continue;
    // Cross-currency comparison would need an `fx_rates` lookup at the due date
    // (CLAUDE.md §Money), and a warning is not worth inventing a rate for.
    // Comparing the raw magnitudes would read €1,340 as the same cost as $1,340.
    if (row.currency !== candidate.currency) continue;

    if (daysApart(candidate.dueDate, row.dueDate) > tolerance.days) continue;

    const expected = Money.fromString(row.expectedAmount, row.currency);
    const typed = Money.fromString(candidate.amount, candidate.currency);
    // The percentage is of the SCHEDULE's figure, not the typed one, so the
    // verdict does not depend on which way the user rounded.
    const pct = expected.abs().mul(tolerance.amountPct);
    const floor = Money.fromString(tolerance.amountAbs, row.currency);
    const allowed = pct.compare(floor) >= 0 ? pct : floor;
    if (typed.sub(expected).abs().compare(allowed) > 0) continue;

    collisions.push({
      plannedLabel: candidate.label,
      obligationId: row.obligationId,
      obligationLabel: row.obligationLabel,
      dueDate: row.dueDate,
      amount: expected.toString(),
    });
  }

  return collisions.sort(byDueDateLabelId);
}
