import "server-only";

import { db } from "@/db/client.ts";
import type { ObligationAmountMode, ObligationDirection } from "@/db/schema/index.ts";
import {
  accounts,
  obligationOccurrences,
  scheduledObligations,
  transactions,
} from "@/db/schema/index.ts";
import type { ObligationCadence } from "@/lib/schedule/cadence.ts";
import { and, asc, eq, gte, inArray, isNotNull, isNull, lte } from "drizzle-orm";
import type { AmountChangeInput, MissedOccurrenceInput } from "./alerts.ts";
import {
  DEFAULT_MATCH_TOLERANCE,
  type MatchTolerance,
  type MatchableOccurrence,
  type MatchableTransaction,
  matchOccurrences,
} from "./match.ts";
import type { MaterializableObligation } from "./materialize.ts";
import { payeeKey } from "./payee-key.ts";

/**
 * The match sweep's persistence half (P16-27, ADR-037 §6).
 *
 * [match.ts](./match.ts) decides; this module reads the rows, hands them over,
 * and writes the answer back. The split is the same one the advice layer uses
 * (ADR-032 §1) and it is what keeps the whole matching contract testable without
 * a database.
 *
 * ── Why a match is written down rather than recomputed ─────────────────────
 * A match is a durable fact with a timestamp. Recomputing it on every read would
 * let it flicker as an import adds transactions around it, and the residual
 * subtraction that safe-to-spend rests on would move with the flicker (ADR-038
 * §2).
 *
 * ── Why the whole persist step is ONE transaction ──────────────────────────
 * P16-29 asks that a sweep which throws must not leave occurrences half-swept.
 * The literal answer is a transaction: either every decision this run made
 * lands, or none of it does and the next run decides the same rows the same way
 * (the matcher is deterministic, so it will). A per-row loop would leave a
 * partially reconciled calendar behind, and the residual attribution would read
 * it as a household that paid some of its bills.
 *
 * Each update additionally carries `WHERE status = 'scheduled'`, so a row some
 * other run has already decided is never re-decided — the same guard the pure
 * matcher applies to terminal states, enforced a second time at the write.
 *
 * ── Why already-claimed transactions leave the pool ────────────────────────
 * The pure matcher guarantees one transaction per occurrence WITHIN a run. It
 * cannot know about the run before it. Without excluding transactions already
 * recorded as `matched_transaction_id`, a later sweep could attribute the same
 * $2,150 payment to a second occurrence, over-subtract, and INFLATE
 * safe-to-spend — the dangerous direction (ADR-038 §5). There is a test.
 *
 * ── Why undecided occurrences have no lower date bound ─────────────────────
 * A `scheduled` occurrence from before the last run is still undecided, and a
 * lookback window would leave it undecided forever after an outage. The sweep
 * therefore reaches back as far as the undecided rows go, which self-heals a
 * NAS that was switched off for a month. What IS bounded is which misses
 * produce an alert — see {@link MISS_ALERT_WINDOW_DAYS}.
 *
 * Nothing here logs a figure, a payee, or a label (CLAUDE.md §Privacy).
 */

const MS_PER_DAY = 86_400_000;

/**
 * How recent a miss must be to be worth an interruption.
 *
 * The sweep marks every undecided past occurrence `missed`, however old — that
 * is the truthful state. But a household coming back from a month-long outage
 * should not be handed thirty alerts about bills it has long since dealt with. A
 * bill missed four months ago is history; a bill missed last week is news.
 */
export const MISS_ALERT_WINDOW_DAYS = 45;

export interface SweepOptions {
  /** `YYYY-MM-DD` the sweep is run for. Explicit, like the matcher's own. */
  readonly today: string;
  /** Overridable for tests; production uses the shipped default. */
  readonly tolerance?: MatchTolerance;
  /** Instant recorded on a match. Defaults to now. */
  readonly now?: Date;
}

export interface SweepResult {
  /** Undecided occurrences considered this run. */
  readonly considered: number;
  /** Occurrences moved to `matched`. */
  readonly matched: number;
  /** Occurrences moved to `missed`. */
  readonly missed: number;
  /** Occurrences left `scheduled` because their window is still open. */
  readonly pending: number;
  /** Newly missed occurrences recent enough to alert on (P16-28). */
  readonly missAlerts: readonly MissedOccurrenceInput[];
  /** Newly matched occurrences, with their deltas, for the amount-change rule. */
  readonly amountChanges: readonly AmountChangeInput[];
}

const EMPTY: SweepResult = {
  considered: 0,
  matched: 0,
  missed: 0,
  pending: 0,
  missAlerts: [],
  amountChanges: [],
};

/** One undecided occurrence joined to the obligation columns matching needs. */
interface UndecidedRow extends MatchableOccurrence {
  readonly label: string;
}

/**
 * Reconcile every undecided occurrence against what actually posted.
 *
 * @param options - The reference date, and optionally a tolerance and clock.
 * @returns Counts plus the two alert-input lists for {@link cashFlowAlerts}.
 * @throws Whatever the matcher throws on a malformed date — a bad row stops the
 *   run loudly rather than silently reporting a household's bills as missed.
 */
export async function sweepOccurrences(options: SweepOptions): Promise<SweepResult> {
  const tolerance = options.tolerance ?? DEFAULT_MATCH_TOLERANCE;
  const now = options.now ?? new Date();
  const horizon = shiftDays(options.today, tolerance.days);

  const undecided = await loadUndecided(horizon);
  if (undecided.length === 0) return EMPTY;

  const candidates = await loadCandidateTransactions(undecided, tolerance.days);
  const result = matchOccurrences(undecided, candidates, { tolerance, today: options.today });

  const byId = new Map(undecided.map((row) => [row.id, row]));
  const txnById = new Map(candidates.map((row) => [row.id, row]));

  // One transaction for the whole decision set — see the header on why.
  await db.transaction(async (tx) => {
    for (const match of result.matched) {
      await tx
        .update(obligationOccurrences)
        .set({
          status: "matched",
          matchedTransactionId: match.transactionId,
          matchedAmount: match.matchedAmount,
          matchedAt: now,
        })
        .where(
          and(
            eq(obligationOccurrences.id, match.occurrenceId),
            // Never re-decide a row another run already settled.
            eq(obligationOccurrences.status, "scheduled"),
          ),
        );
    }
    for (const miss of result.missed) {
      await tx
        .update(obligationOccurrences)
        .set({ status: "missed" })
        .where(
          and(
            eq(obligationOccurrences.id, miss.occurrenceId),
            eq(obligationOccurrences.status, "scheduled"),
          ),
        );
    }
  });

  const alertFloor = shiftDays(options.today, -MISS_ALERT_WINDOW_DAYS);

  const missAlerts: MissedOccurrenceInput[] = [];
  for (const miss of result.missed) {
    const row = byId.get(miss.occurrenceId);
    if (row === undefined || row.dueDate < alertFloor) continue;
    missAlerts.push({
      occurrenceId: row.id,
      obligationId: row.obligationId,
      label: row.label,
      dueDate: row.dueDate,
      expectedAmount: row.expectedAmount,
      direction: row.direction,
    });
  }

  const amountChanges: AmountChangeInput[] = [];
  for (const match of result.matched) {
    const row = byId.get(match.occurrenceId);
    if (row === undefined) continue;
    amountChanges.push({
      occurrenceId: row.id,
      obligationId: row.obligationId,
      label: row.label,
      dueDate: row.dueDate,
      expectedAmount: row.expectedAmount,
      matchedAmount: txnById.get(match.transactionId)?.amount ?? match.matchedAmount,
      amountDelta: match.amountDelta,
      amountMode: row.amountMode,
    });
  }

  return {
    considered: undecided.length,
    matched: result.matched.length,
    missed: result.missed.length,
    pending: result.pending.length,
    missAlerts,
    amountChanges,
  };
}

/**
 * Every occurrence still awaiting a decision, up to the far edge of the window.
 *
 * @param horizon - `today + tolerance.days`; nothing beyond it can be decided.
 * @returns Undecided rows ascending by due date, joined to their obligation.
 */
async function loadUndecided(horizon: string): Promise<UndecidedRow[]> {
  const rows = await db
    .select({
      id: obligationOccurrences.id,
      obligationId: obligationOccurrences.obligationId,
      accountId: scheduledObligations.accountId,
      payeeKey: scheduledObligations.detectionKey,
      label: scheduledObligations.label,
      dueDate: obligationOccurrences.dueDate,
      expectedAmount: obligationOccurrences.expectedAmount,
      direction: scheduledObligations.direction,
      amountMode: scheduledObligations.amountMode,
      status: obligationOccurrences.status,
    })
    .from(obligationOccurrences)
    .innerJoin(
      scheduledObligations,
      eq(scheduledObligations.id, obligationOccurrences.obligationId),
    )
    .where(
      and(
        eq(obligationOccurrences.status, "scheduled"),
        lte(obligationOccurrences.dueDate, horizon),
      ),
    );

  return rows.map((row) => ({
    ...row,
    direction: row.direction as ObligationDirection,
    amountMode: row.amountMode as ObligationAmountMode,
    status: "scheduled" as const,
  }));
}

/**
 * Transactions that could plausibly satisfy the undecided occurrences.
 *
 * Restricted to the accounts those occurrences belong to and the date span they
 * could reach, and with every transaction already claimed by a recorded match
 * removed from the pool.
 *
 * @param undecided - The occurrences being decided this run.
 * @param toleranceDays - How far a posting may sit from its due date.
 * @returns Candidate transactions with their normalized payee keys.
 */
async function loadCandidateTransactions(
  undecided: readonly UndecidedRow[],
  toleranceDays: number,
): Promise<MatchableTransaction[]> {
  const accountIds = [...new Set(undecided.map((row) => row.accountId))];
  const dueDates = undecided.map((row) => row.dueDate).sort();
  const from = shiftDays(dueDates[0] as string, -toleranceDays);
  const to = shiftDays(dueDates[dueDates.length - 1] as string, toleranceDays);

  const [rows, claimed] = await Promise.all([
    db
      .select({
        id: transactions.id,
        accountId: transactions.accountId,
        name: transactions.name,
        postedAt: transactions.postedAt,
        amount: transactions.amount,
      })
      .from(transactions)
      .innerJoin(accounts, eq(accounts.id, transactions.accountId))
      .where(
        and(
          inArray(transactions.accountId, accountIds),
          gte(transactions.postedAt, from),
          lte(transactions.postedAt, to),
          // A closed account pays no bills. Its historical rows are still real,
          // but an occurrence due today cannot have been paid from it, and
          // letting one match would attribute spending that is not happening.
          isNull(accounts.closedAt),
        ),
      ),
    db
      .select({ transactionId: obligationOccurrences.matchedTransactionId })
      .from(obligationOccurrences)
      .where(isNotNull(obligationOccurrences.matchedTransactionId)),
  ]);

  const alreadyClaimed = new Set(claimed.map((row) => row.transactionId));

  return rows
    .filter((row) => !alreadyClaimed.has(row.id))
    .map((row) => ({
      id: row.id,
      accountId: row.accountId,
      payeeKey: payeeKey(row.name),
      postedAt: row.postedAt,
      amount: row.amount,
    }));
}

/** `iso` shifted by whole UTC days. A DST transition cannot move a due date. */
function shiftDays(iso: string, days: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + days * MS_PER_DAY).toISOString().slice(0, 10);
}

/** Re-exported so the job and its tests speak one tolerance. */
export { DEFAULT_MATCH_TOLERANCE };

/**
 * The active obligations the nightly materializer walks.
 *
 * Only `active` ones: pausing an obligation stops its calendar growing, which
 * is exactly what "Stop" means on the review page. Its existing occurrences stay
 * put, because they explain past months (P16-25).
 *
 * @returns Obligations in {@link MaterializableObligation} shape, narrowed from
 *   the `text` cadence column its CHECK already constrains.
 */
export async function listMaterializableObligations(): Promise<MaterializableObligation[]> {
  const rows = await db
    .select({
      id: scheduledObligations.id,
      cadence: scheduledObligations.cadence,
      anchorDate: scheduledObligations.anchorDate,
      startDate: scheduledObligations.startDate,
      endDate: scheduledObligations.endDate,
      expectedAmount: scheduledObligations.expectedAmount,
      active: scheduledObligations.active,
    })
    .from(scheduledObligations)
    .where(eq(scheduledObligations.active, true))
    .orderBy(asc(scheduledObligations.id));

  return rows.map((row) => ({ ...row, cadence: row.cadence as ObligationCadence }));
}
