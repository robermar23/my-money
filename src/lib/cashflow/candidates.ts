import type { ObligationCandidate } from "./detect.ts";

/**
 * filterCandidates: decide which proposals the user should actually see
 * (P16-12, ADR-036 §2).
 *
 * Pure and I/O-free. [detect.ts](./detect.ts) answers "what looks recurring?";
 * this answers "what has the user not already settled?". Keeping them apart
 * matters because the detector's answer depends only on the transactions, so it
 * stays reproducible and explainable, while this step depends on state the user
 * has changed since — and that state should never be able to alter what the
 * detector found, only what is shown.
 *
 * ── The two grounds for suppression ────────────────────────────────────────
 *   1. **Already confirmed.** The candidate matches a `scheduled_obligation` on
 *      `(account_id, detection_key)` — the same pair the partial UNIQUE index
 *      in ADR-037 §1 enforces. Re-proposing a confirmed series would ask the
 *      user to answer a question they have answered, and accepting it would hit
 *      that index anyway.
 *   2. **Dismissed.** "I have consciously rejected this" is user intent, not a
 *      derived figure — the same distinction `recommendation_dismissals` was
 *      created for (ADR-032 §3). A dismissal suppresses indefinitely; a snooze
 *      suppresses only until it lapses, after which the candidate returns on its
 *      own. A snooze that never ended would be a dismissal wearing a different
 *      name, so the boundary is exclusive: at the snooze instant it is over.
 *
 * ── Manual obligations suppress nothing ────────────────────────────────────
 * `detection_key` is NULL for anything the user typed in by hand. NULL
 * identifies no series — it is precisely why the unique index is partial — so a
 * manual obligation is skipped here rather than being allowed to swallow every
 * candidate on its account.
 *
 * ── What the caller should pass as `confirmed` ─────────────────────────────
 * ALL obligations on the account, active or not. A deactivated obligation is
 * one the user deliberately turned off; proposing it back to them is the
 * re-nagging ADR-026 rejected for price targets. If a stopped series genuinely
 * restarts, reactivating the existing obligation is the correct route, because
 * it preserves the occurrence history that explains the past.
 *
 * Where dismissals are stored is Batch 5's decision (P16-24). This function is
 * deliberately agnostic: it takes keys, not rows.
 */

/** The identity of a confirmed obligation, as the unique index sees it. */
export interface ConfirmedObligationKey {
  readonly accountId: string;
  /** NULL for a manual obligation, which identifies no detected series. */
  readonly detectionKey: string | null;
}

/** A candidate the user has rejected, indefinitely or for a while. */
export interface DismissedCandidateKey {
  readonly accountId: string;
  readonly detectionKey: string;
  /** NULL = rejected indefinitely; a timestamp = suppressed only until then. */
  readonly snoozeUntil: Date | null;
}

export interface FilterCandidatesOptions {
  /** Every obligation on the household's accounts — see the header. */
  readonly confirmed: readonly ConfirmedObligationKey[];
  readonly dismissed: readonly DismissedCandidateKey[];
  /**
   * The instant to evaluate snoozes against. Explicit rather than read from the
   * clock, so a filtered list is reproducible and testable without fake timers
   * — the same posture `detectObligations` takes with `today`.
   */
  readonly now: Date;
}

/** Compose the pair that identifies a series. Not persisted; local to this pass. */
function seriesKey(accountId: string, detectionKey: string): string {
  return `${accountId} ${detectionKey}`;
}

/**
 * Remove candidates the user has already confirmed or rejected.
 *
 * @param candidates - Proposals from `detectObligations`, in its ranked order.
 * @param options - Confirmed obligation keys, dismissals, and the instant to
 *   evaluate snoozes against.
 * @returns The surviving candidates, in the order they were given. Neither the
 *   candidates nor the option lists are mutated.
 */
export function filterCandidates(
  candidates: readonly ObligationCandidate[],
  options: FilterCandidatesOptions,
): ObligationCandidate[] {
  const suppressed = new Set<string>();

  for (const obligation of options.confirmed) {
    if (obligation.detectionKey === null) continue;
    suppressed.add(seriesKey(obligation.accountId, obligation.detectionKey));
  }

  for (const dismissal of options.dismissed) {
    // An expired snooze is not a suppression — the candidate is due to come
    // back, which is the entire difference between a snooze and a dismissal.
    if (
      dismissal.snoozeUntil !== null &&
      dismissal.snoozeUntil.getTime() <= options.now.getTime()
    ) {
      continue;
    }
    suppressed.add(seriesKey(dismissal.accountId, dismissal.detectionKey));
  }

  return candidates.filter(
    (candidate) => !suppressed.has(seriesKey(candidate.accountId, candidate.payeeKey)),
  );
}
