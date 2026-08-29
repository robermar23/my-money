import { loadCandidates } from "@/lib/cashflow/candidate-loader.ts";
import type { Job } from "bullmq";

/**
 * P16-26 — weekly recurring-obligation detection.
 *
 * Runs {@link loadCandidates} over the trailing detection window and **writes
 * nothing**. That is not an omission; it is the job's entire contract.
 *
 * ── "Persist candidates only" ──────────────────────────────────────────────
 * PLAN16 phrases this task as "persist **candidates only** (never obligations —
 * ADR-036 §2)". There is no candidates table, and Batch 2 deliberately did not
 * add one: candidates are computed on read, the same posture ADR-032 §3 took
 * for recommendations, because a stored candidate is one that goes stale
 * silently while re-deriving it from transactions is cheap and carries its own
 * evidence. So that line reads as *persist ONLY candidates — never an
 * obligation* — the ADR-036 §2 guarantee, not a schema requirement. Adding a
 * third table to hold derived rows would contradict the phase's own posture and
 * would need a migration plus an ADR amendment, not a quiet decision inside a
 * worker file.
 *
 * ── Then what is a job that writes nothing FOR? ────────────────────────────
 * Two things, and they are worth being explicit about rather than leaving the
 * job to look like ceremony:
 *
 *   1. **It is the canary on detection.** `detectObligations` walks two years of
 *      transactions through date and Money arithmetic. If a regression, a
 *      malformed row, or a schema change breaks it, the only person who finds
 *      out today is the user opening the review page and getting a 500. A
 *      scheduled run turns that into a failed BullMQ job with a stack trace,
 *      before anyone is looking at it.
 *   2. **It reports the counts.** The return value — how many series are
 *      proposed and how many of them are strong — is what the review surface
 *      and any future badge are counting, derived by exactly the code path the
 *      page uses, so the two can never disagree.
 *
 * It deliberately does NOT raise an alert. "You have four suggestions to
 * review" is app housekeeping, not a change in the household's money, and
 * `adviceAlerts` already made this call for `unknown_input`: alerting on a fact
 * about the app's own data turns the honest path into a nag, and a nagged user
 * stops reading the alerts page before the night it matters.
 *
 * Sunday 06:30 — after the 06:00 Sunday fundamentals refresh, in a slot nothing
 * else occupies. Weekly rather than nightly because a recurring series does not
 * become detectable overnight: the detector needs several occurrences, and the
 * soonest a new one can appear is the next cadence period.
 *
 * No payee, label, or amount is logged (CLAUDE.md §Privacy) — the return value
 * is counts, and a count is not a statement about anyone's money.
 */

export interface DetectObligationsWeeklyResult {
  /** Series the detector proposed and the user has not yet settled. */
  readonly candidates: number;
  /** Of those, the ones graded `high` — what "confirm all strong matches" acts on. */
  readonly highConfidence: number;
}

export interface DetectObligationsWeeklyDeps {
  /** Injected for tests; production reads the real transaction history. */
  readonly load?: typeof loadCandidates;
  readonly now?: () => Date;
}

const isoDate = (d: Date): string => d.toISOString().slice(0, 10);

/**
 * Detect recurring obligations and report how many are waiting on an answer.
 *
 * @param _job - The BullMQ job. Carries no payload.
 * @param deps - Test seams; production passes nothing.
 * @returns The candidate counts. Nothing is written to the database.
 */
export async function detectObligationsWeeklyProcessor(
  _job: Job | undefined,
  deps: DetectObligationsWeeklyDeps = {},
): Promise<DetectObligationsWeeklyResult> {
  const now = (deps.now ?? (() => new Date()))();
  const candidates = await (deps.load ?? loadCandidates)({ today: isoDate(now), now });

  return {
    candidates: candidates.length,
    highConfidence: candidates.filter((candidate) => candidate.confidence === "high").length,
  };
}
