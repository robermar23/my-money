import Decimal from "decimal.js";
import { UNCLASSIFIED_CONFIDENCE_LIMIT } from "../constants.ts";
import type { AdviceInput } from "../snapshot.ts";
import type { Confidence, InputKind, InputUsed } from "../types.ts";

/**
 * Shared helpers for the rule modules (Phase 15, Batch 3).
 *
 * Two things every rule does identically, so they are written once:
 *
 *   1. **Building `inputsUsed[]`.** ADR-032 §2 makes the audit trail part of the
 *      contract, which means every rule builds a dozen of these. Constructing
 *      them by literal invites the one mistake that matters — a `value` of
 *      `"0.00"` where the truth is "not recorded" — so {@link shown} and
 *      {@link notRecorded} make the distinction impossible to blur.
 *   2. **Deciding confidence from the baselines' own honesty.** A recommendation
 *      built on four months of history, or on spend that is 40% unclassified, is
 *      still worth making — but not with the same face as one built on a clean
 *      year. {@link baselineConfidence} reads that off the snapshot rather than
 *      leaving each rule to invent its own threshold.
 *
 * Pure and I/O-free (ADR-032 §1).
 */

/** An input the rule actually read, with its value. */
export function shown(
  label: string,
  value: string,
  kind: InputKind,
  source: string,
  href?: string,
): InputUsed {
  return href === undefined ? { label, value, kind, source } : { label, value, kind, source, href };
}

/**
 * An input the household has **not recorded**.
 *
 * `value` is `null`, never `"0.00"`. The whole phase rests on that distinction:
 * a zero flows into a target and reads as a fact, while `null` renders as "not
 * recorded" with a link to where it is entered.
 */
export function notRecorded(
  label: string,
  kind: InputKind,
  source: string,
  href?: string,
): InputUsed {
  return href === undefined
    ? { label, value: null, kind, source, missing: true }
    : { label, value: null, kind, source, missing: true, href };
}

/**
 * How much to trust a figure derived from the trailing baselines.
 *
 * `low` when the essential baseline or the cash tiering is materially
 * unclassified, or when fewer than six months sit behind the median; `medium`
 * below a full year; `high` otherwise. ADR-034 §7's `minMonthsHistory` gating
 * already removes rules that cannot speak at all — this grades the ones that can.
 *
 * @param input - The assembled snapshot.
 * @returns The confidence to attach to a recommendation built on these baselines.
 */
export function baselineConfidence(input: AdviceInput): Confidence {
  const messy =
    input.essentials.unclassifiedShare > UNCLASSIFIED_CONFIDENCE_LIMIT ||
    input.cash.unclassifiedShare > UNCLASSIFIED_CONFIDENCE_LIMIT;

  if (messy || input.essentials.basisMonths < 6) return "low";
  if (input.essentials.basisMonths < 12) return "medium";
  return "high";
}

/** The lower of two confidences, for a rule that combines two shaky inputs. */
export function worseConfidence(a: Confidence, b: Confidence): Confidence {
  const rank: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };
  return rank[a] <= rank[b] ? a : b;
}

/**
 * Fraction of the calendar year elapsed at `today`, in (0, 1].
 *
 * Both year-to-date rules annualize with this: the employer-match gap and the
 * contribution pacing projection. Floored at a single day so 1 January cannot
 * divide by zero — the projection it produces that morning is wild, which is
 * why the rules that use it also report how few pay periods are behind it.
 *
 * @param today - Reference date, `YYYY-MM-DD`.
 * @returns The elapsed fraction as a Decimal.
 */
export function yearElapsedFraction(today: string): Decimal {
  const year = Number(today.slice(0, 4));
  const start = Date.UTC(year, 0, 1);
  const end = Date.UTC(year + 1, 0, 1);
  const now = Date.UTC(year, Number(today.slice(5, 7)) - 1, Number(today.slice(8, 10)));
  return Decimal.max(
    new Decimal(now - start).dividedBy(end - start),
    new Decimal(1).dividedBy(366),
  );
}
