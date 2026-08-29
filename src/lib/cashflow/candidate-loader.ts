import "server-only";

import { db } from "@/db/client.ts";
import type { CategoryKind } from "@/db/schema/categories.ts";
import { accounts, categories, recommendationDismissals, transactions } from "@/db/schema/index.ts";
import { and, eq, gte, inArray, isNull } from "drizzle-orm";
import { filterCandidates } from "./candidates.ts";
import { type ObligationCandidate, detectObligations } from "./detect.ts";
import { payeeKey } from "./payee-key.ts";
import { listObligations } from "./queries.ts";

/**
 * The candidate review page's one read (P16-24, ADR-036 §2).
 *
 * Detection is COMPUTED ON READ, not stored. That is the same posture ADR-032
 * §3 took for recommendations, and for the same reason: a stored candidate is a
 * candidate that goes stale silently, while re-deriving it from transactions is
 * cheap, reproducible, and explainable — the evidence travels with the proposal.
 * Phase 16 adds exactly two tables and both stay empty until the user confirms
 * something.
 *
 * **A note for Batch 6.** PLAN16 P16-26 describes the weekly job as persisting
 * "candidates only". There is no candidates table and Batch 2 deliberately did
 * not add one, so that line reads as "persist ONLY candidates, never
 * obligations" — the ADR-036 §2 guarantee — rather than as a schema requirement.
 * The job's real output is a count and, if anything, an alert. If Batch 6
 * concludes otherwise it needs a migration and an ADR amendment, not a quiet
 * table.
 *
 * ── Where a dismissal lives ────────────────────────────────────────────────
 * [candidates.ts](./candidates.ts) left this to Batch 5, and the answer is
 * `recommendation_dismissals` — no new table. A candidate dismissal is the same
 * *kind* of fact as a recommendation dismissal: consciously-expressed user
 * intent that nothing else in the system can reconstruct, which is precisely
 * what ADR-032 §3 created that table to hold. The `rule_id` is the constant
 * below and the `subject_key` is `"<accountId> <detectionKey>"`, so the existing
 * `(rule_id, subject_key)` UNIQUE index gives the dismiss action an idempotent
 * upsert for free, and the dismissed-items view (P15-34) shows these alongside
 * the rest without special-casing.
 *
 * Nothing here logs a figure or a payee (CLAUDE.md §Privacy).
 */

/** The synthetic rule id under which candidate dismissals are stored. */
export const CANDIDATE_DISMISSAL_RULE_ID = "obligation_candidate";

/**
 * How far back detection reads.
 *
 * Two years rather than one: an `annual` or `semiannual` series needs several
 * occurrences before its period can be corroborated, and a 12-month window can
 * hold at most one of an annual bill — which is indistinguishable from a
 * one-off. Bounded by the household's own transaction volume, so this is a few
 * thousand rows at most.
 */
export const DETECTION_WINDOW_MONTHS = 24;

/** Account types whose transactions can carry a recurring obligation. */
const DETECTABLE_ACCOUNT_TYPES = ["depository", "credit_card"] as const;

export interface LoadCandidatesOptions {
  /** `YYYY-MM-DD`. Injected rather than read from the clock, like detection itself. */
  readonly today: string;
  /** Instant to evaluate snoozes against. Defaults to now. */
  readonly now?: Date;
}

/** The subject key a candidate dismissal is stored under. */
export function candidateSubjectKey(accountId: string, detectionKey: string): string {
  return `${accountId} ${detectionKey}`;
}

/**
 * Detect recurring obligations and drop the ones the user has already settled.
 *
 * @param options - `today`, and optionally the instant snoozes are measured
 *   against.
 * @returns Candidates in the detector's ranked order (most credible first),
 *   with confirmed and dismissed series removed.
 */
export async function loadCandidates(
  options: LoadCandidatesOptions,
): Promise<ObligationCandidate[]> {
  const since = windowStart(options.today);

  const accountRows = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(inArray(accounts.type, [...DETECTABLE_ACCOUNT_TYPES]), isNull(accounts.closedAt)));
  if (accountRows.length === 0) return [];

  const [txnRows, confirmed, dismissals] = await Promise.all([
    db
      .select({
        id: transactions.id,
        accountId: transactions.accountId,
        postedAt: transactions.postedAt,
        amount: transactions.amount,
        name: transactions.name,
        categoryId: transactions.categoryId,
        categoryKind: categories.kind,
      })
      .from(transactions)
      .leftJoin(categories, eq(categories.id, transactions.categoryId))
      .where(
        and(
          inArray(
            transactions.accountId,
            accountRows.map((row) => row.id),
          ),
          gte(transactions.postedAt, since),
        ),
      ),
    // Active AND inactive: a deactivated obligation is one the user deliberately
    // turned off, and re-proposing it is the re-nagging ADR-026 rejected.
    listObligations({ includeInactive: true }),
    db
      .select({
        subjectKey: recommendationDismissals.subjectKey,
        snoozeUntil: recommendationDismissals.snoozeUntil,
      })
      .from(recommendationDismissals)
      .where(eq(recommendationDismissals.ruleId, CANDIDATE_DISMISSAL_RULE_ID)),
  ]);

  const candidates = detectObligations(
    txnRows.map((row) => ({
      ...row,
      categoryKind: row.categoryKind as CategoryKind | null,
    })),
    { today: options.today },
  );

  return filterCandidates(candidates, {
    confirmed: confirmed.map((row) => ({
      accountId: row.accountId,
      detectionKey: row.detectionKey,
    })),
    dismissed: dismissals.flatMap((row) => {
      const split = splitSubjectKey(row.subjectKey);
      return split === null ? [] : [{ ...split, snoozeUntil: row.snoozeUntil }];
    }),
    now: options.now ?? new Date(),
  });
}

/**
 * Confirm that a detection key really was proposed for an account, and hand back
 * the detector's own grading of it.
 *
 * The confirm action calls this instead of trusting a `confidence` field from
 * the form. How strongly the detector believed its own proposal is provenance,
 * not a user preference — a form that could assert it would let a hand-crafted
 * POST create a `source='detected'` obligation the detector never proposed.
 *
 * @param accountId - The account the candidate belongs to.
 * @param detectionKey - The candidate's `payeeKey`.
 * @param options - `today`, so the derivation matches what the page rendered.
 * @returns The candidate, or `undefined` if it is no longer proposed.
 */
export async function findCandidate(
  accountId: string,
  detectionKey: string,
  options: LoadCandidatesOptions,
): Promise<ObligationCandidate | undefined> {
  const candidates = await loadCandidates(options);
  return candidates.find((c) => c.accountId === accountId && c.payeeKey === detectionKey);
}

/**
 * The `payeeKey` for a raw bank description.
 *
 * Re-exported so the review surface and the matcher speak the same normalization
 * without importing two modules for one idea (ADR-036 §4).
 */
export { payeeKey };

/** `today` minus {@link DETECTION_WINDOW_MONTHS}, as `YYYY-MM-DD`. */
function windowStart(today: string): string {
  const date = new Date(`${today}T00:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() - DETECTION_WINDOW_MONTHS);
  return date.toISOString().slice(0, 10);
}

/** `"<accountId> <detectionKey>"` back into its parts, or `null` if malformed. */
function splitSubjectKey(subjectKey: string): { accountId: string; detectionKey: string } | null {
  const space = subjectKey.indexOf(" ");
  if (space <= 0 || space === subjectKey.length - 1) return null;
  return {
    accountId: subjectKey.slice(0, space),
    detectionKey: subjectKey.slice(space + 1),
  };
}
