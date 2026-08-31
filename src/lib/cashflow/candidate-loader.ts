import "server-only";

import { db } from "@/db/client.ts";
import type { CategoryKind } from "@/db/schema/categories.ts";
import {
  accounts,
  categories,
  liabilities,
  recommendationDismissals,
  transactions,
} from "@/db/schema/index.ts";
import { and, eq, gte, inArray, isNull } from "drizzle-orm";
import { filterCandidates, filterLiabilityCandidates } from "./candidates.ts";
import { type ObligationCandidate, detectObligations } from "./detect.ts";
import {
  type LiabilityCandidate,
  OBSERVED_PAYMENT_WINDOW_MONTHS,
  liabilityCandidates,
} from "./liability-obligations.ts";
import { payeeKey } from "./payee-key.ts";
import { listObligations, listOperatingAccounts } from "./queries.ts";

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

/**
 * The prefix that marks a dismissal as belonging to a LIABILITY candidate.
 *
 * A literal rather than a uuid, so the two kinds of subject key are told apart
 * by inspection: `"<accountId> <detectionKey>"` for a detected series,
 * `"liability <liabilityId>"` for a stated loan schedule (ADR-047 §5). No
 * account id can collide with it, because account ids are uuids.
 */
const LIABILITY_SUBJECT_PREFIX = "liability";

/** The subject key a candidate dismissal is stored under. */
export function candidateSubjectKey(accountId: string, detectionKey: string): string {
  return `${accountId} ${detectionKey}`;
}

/** The subject key a liability-candidate dismissal is stored under. */
export function liabilitySubjectKey(liabilityId: string): string {
  return `${LIABILITY_SUBJECT_PREFIX} ${liabilityId}`;
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
  const accountId = subjectKey.slice(0, space);
  // Liability dismissals share the rule id, so they arrive in the same result
  // set. Skipping them here is belt-and-braces rather than load-bearing —
  // "liability" is not a uuid, so it could never match a real account — but a
  // key that parses into a nonsense account is the kind of thing a future
  // reader debugs twice before concluding it was harmless.
  if (accountId === LIABILITY_SUBJECT_PREFIX) return null;
  return { accountId, detectionKey: subjectKey.slice(space + 1) };
}

/** `"liability <liabilityId>"` back into the id, or `null` when it is not one. */
function splitLiabilitySubjectKey(subjectKey: string): string | null {
  const prefix = `${LIABILITY_SUBJECT_PREFIX} `;
  if (!subjectKey.startsWith(prefix)) return null;
  const liabilityId = subjectKey.slice(prefix.length);
  return liabilityId.length === 0 ? null : liabilityId;
}

/**
 * Propose a schedule for every loan whose terms the household has stated
 * (CF-A4, ADR-047).
 *
 * Computed on read, exactly like detection — see the header. Nothing is stored,
 * and nothing reaches `scheduled_obligations` without a confirm click.
 *
 * The observed-payment window is deliberately narrower than detection's: six
 * months of outflows on the operating accounts, which is long enough for a
 * stable median and recent enough to reflect the current escrow. See
 * {@link OBSERVED_PAYMENT_WINDOW_MONTHS}.
 *
 * @param options - `today`, and optionally the instant snoozes are measured
 *   against.
 * @returns Candidates in `liabilityCandidates`' stable order, with confirmed and
 *   dismissed loans removed. Empty when no loan has stated terms.
 */
export async function loadLiabilityCandidates(
  options: LoadCandidatesOptions,
): Promise<LiabilityCandidate[]> {
  const [terms, operating] = await Promise.all([
    db
      .select({
        id: liabilities.id,
        accountId: liabilities.accountId,
        name: liabilities.name,
        principalAtOrigination: liabilities.principalAtOrigination,
        annualRate: liabilities.annualRate,
        termMonths: liabilities.termMonths,
        startDate: liabilities.startDate,
      })
      .from(liabilities)
      .innerJoin(accounts, eq(accounts.id, liabilities.accountId))
      // A closed loan account is a paid-off or refinanced loan; dating its
      // payment would invent an outflow the household will never see.
      .where(and(eq(accounts.type, "loan"), isNull(accounts.closedAt))),
    listOperatingAccounts(),
  ]);
  if (terms.length === 0) return [];

  const [outflows, confirmed, dismissals] = await Promise.all([
    operating.length === 0
      ? Promise.resolve([])
      : db
          .select({
            accountId: transactions.accountId,
            name: transactions.name,
            postedAt: transactions.postedAt,
            amount: transactions.amount,
          })
          .from(transactions)
          .where(
            and(
              inArray(
                transactions.accountId,
                operating.map((row) => row.accountId),
              ),
              gte(transactions.postedAt, monthsBack(options.today, OBSERVED_PAYMENT_WINDOW_MONTHS)),
            ),
          ),
    // Active AND inactive, for the same reason detection reads both: a
    // deactivated obligation is one the user deliberately turned off.
    listObligations({ includeInactive: true }),
    db
      .select({
        subjectKey: recommendationDismissals.subjectKey,
        snoozeUntil: recommendationDismissals.snoozeUntil,
      })
      .from(recommendationDismissals)
      .where(eq(recommendationDismissals.ruleId, CANDIDATE_DISMISSAL_RULE_ID)),
  ]);

  const candidates = liabilityCandidates({
    liabilities: terms,
    operatingAccounts: operating,
    observedOutflows: outflows.map((row) => ({
      accountId: row.accountId,
      payeeKey: payeeKey(row.name),
      name: row.name,
      postedAt: row.postedAt,
      amount: row.amount,
    })),
    today: options.today,
  });

  return filterLiabilityCandidates(candidates, {
    confirmed: confirmed.map((row) => row.liabilityId),
    dismissed: dismissals.flatMap((row) => {
      const liabilityId = splitLiabilitySubjectKey(row.subjectKey);
      return liabilityId === null ? [] : [{ liabilityId, snoozeUntil: row.snoozeUntil }];
    }),
    now: options.now ?? new Date(),
  });
}

/**
 * Re-derive one liability candidate server-side, for the confirm action.
 *
 * The same guarantee `findCandidate` gives for a detected series: the form
 * supplies the user's EDITS, the server supplies the PROVENANCE. Without it a
 * hand-crafted POST could write a `source='liability'` row pointing at a loan
 * that proposes nothing at all.
 *
 * @param liabilityId - The loan the candidate belongs to.
 * @param options - `today`, so the derivation matches what the page rendered.
 * @returns The candidate, or `undefined` if it is no longer proposed.
 */
export async function findLiabilityCandidate(
  liabilityId: string,
  options: LoadCandidatesOptions,
): Promise<LiabilityCandidate | undefined> {
  const candidates = await loadLiabilityCandidates(options);
  return candidates.find((candidate) => candidate.liabilityId === liabilityId);
}

/** `today` minus whole months, as `YYYY-MM-DD`. */
function monthsBack(today: string, months: number): string {
  const date = new Date(`${today}T00:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() - months);
  return date.toISOString().slice(0, 10);
}
