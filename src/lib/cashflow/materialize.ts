import "server-only";

import { db } from "@/db/client.ts";
import { obligationOccurrences } from "@/db/schema/index.ts";
import type { ObligationCadence } from "@/lib/schedule/cadence.ts";
import { occurrenceDatesBetween, parseIsoDate } from "@/lib/schedule/occurrences.ts";
import { desc, eq } from "drizzle-orm";

/**
 * Materialization — turning a schedule into durable rows (P16-21, ADR-037 §5).
 *
 * ── Why materialize at all ─────────────────────────────────────────────────
 * Because a match, a skip and a miss need somewhere to live. If due dates were
 * expanded on read, "the mortgage did not post" would be a recomputed inference
 * that flickers as the data around it changes, and there would be no row on
 * which to record that the user deliberately skipped a payment. A match is a
 * fact with a timestamp, not a query result.
 *
 * ── Idempotent by construction, not by bookkeeping ─────────────────────────
 * Every write is `ON CONFLICT (obligation_id, due_date) DO NOTHING`. The UNIQUE
 * index — not application logic — is what makes a re-run a no-op, which is the
 * property the unattended nightly job depends on (CLAUDE.md §Background Jobs):
 * a run that dies halfway is safely resumable, a Redis retry writes nothing new,
 * and extending the horizon adds only the tail.
 *
 * **DO NOTHING, never DO UPDATE.** An upsert would look harmless and would wipe
 * `status`, `matched_transaction_id` and `matched_amount` on every nightly run,
 * erasing the reconciliation the residual subtraction reads (ADR-038 §2) and
 * resurrecting occurrences the user deliberately skipped. There is a test for
 * exactly that.
 *
 * ── The amount is SNAPSHOTTED ──────────────────────────────────────────────
 * Copied at materialization, never read through the FK. Raising the rent in June
 * must not retroactively claim the household paid the new figure in March, and
 * an `amount_mode='trailing_median'` obligation re-prices over time — the
 * estimate actually used for a given due date is the auditable one.
 *
 * ── Where a run starts ─────────────────────────────────────────────────────
 * At the last materialized due date (not the day after it), so the conflict
 * clause absorbs the one guaranteed duplicate and no off-by-one can skip a
 * month. Before the first run there is nothing, so it starts at `start_date`.
 *
 * A consequence worth stating: changing an obligation's CADENCE does not
 * retroactively re-materialize the past under the new schedule. Past occurrences
 * describe what was actually expected at the time, which is the same reason the
 * amount is snapshotted — and re-writing them would silently change every
 * residual window that included those months.
 */

/** The obligation columns materialization reads. Nothing else is needed. */
export interface MaterializableObligation {
  readonly id: string;
  readonly cadence: ObligationCadence;
  /** A known-real occurrence date; phases the schedule. */
  readonly anchorDate: string;
  readonly startDate: string;
  /** Inclusive last date; `null` = open-ended. */
  readonly endDate: string | null;
  /** Positive magnitude, snapshotted onto every row this run writes. */
  readonly expectedAmount: string;
  readonly active: boolean;
}

export interface MaterializeResult {
  /** Rows actually inserted. Zero means every due date already existed. */
  readonly created: number;
  /** The window walked, or `null` when the obligation contributed nothing. */
  readonly from: string | null;
  readonly to: string | null;
}

const NOTHING: MaterializeResult = { created: 0, from: null, to: null };

/**
 * Write one occurrence per due date, from where the last run stopped through
 * the horizon.
 *
 * @param obligation - The schedule to expand. Inactive obligations write nothing.
 * @param through - Inclusive horizon end, `YYYY-MM-DD` (typically
 *   `today + projection_horizon_days`).
 * @returns How many rows were created, and the window walked.
 * @throws If `through`, or any of the obligation's dates, is not a real
 *   `YYYY-MM-DD` — a bad date fails loudly rather than writing a partial
 *   calendar that later reads as a household that stopped paying its bills.
 */
export async function materializeOccurrences(
  obligation: MaterializableObligation,
  through: string,
): Promise<MaterializeResult> {
  // Validate the horizon before touching the database, so a typo cannot leave a
  // half-written calendar behind.
  const throughMs = parseIsoDate(through, "through");
  if (!obligation.active) return NOTHING;

  const endMs =
    obligation.endDate === null
      ? throughMs
      : Math.min(throughMs, parseIsoDate(obligation.endDate, "endDate"));
  if (endMs < parseIsoDate(obligation.startDate, "startDate")) return NOTHING;
  const to = new Date(endMs).toISOString().slice(0, 10);

  const from = (await lastDueDate(obligation.id)) ?? obligation.startDate;
  if (from > to) return NOTHING;

  const dates = occurrenceDatesBetween(obligation.cadence, obligation.anchorDate, from, to);
  if (dates.length === 0) return { created: 0, from, to };

  const inserted = await db
    .insert(obligationOccurrences)
    .values(
      dates.map((dueDate) => ({
        obligationId: obligation.id,
        dueDate,
        expectedAmount: obligation.expectedAmount,
      })),
    )
    // The idempotency key (ADR-037 §2). DO NOTHING — see the header on why an
    // upsert here would destroy the reconciliation.
    .onConflictDoNothing({
      target: [obligationOccurrences.obligationId, obligationOccurrences.dueDate],
    })
    .returning({ id: obligationOccurrences.id });

  return { created: inserted.length, from, to };
}

/** The newest due date already materialized for an obligation, or `null`. */
async function lastDueDate(obligationId: string): Promise<string | null> {
  const [row] = await db
    .select({ dueDate: obligationOccurrences.dueDate })
    .from(obligationOccurrences)
    .where(eq(obligationOccurrences.obligationId, obligationId))
    .orderBy(desc(obligationOccurrences.dueDate))
    .limit(1);
  return row?.dueDate ?? null;
}
