import type { ObligationConfidence } from "@/db/schema/scheduled-obligations.ts";
import type { ObligationCadence } from "@/lib/schedule/cadence.ts";
import { parseIsoDate } from "@/lib/schedule/occurrences.ts";

/**
 * detectPeriodicity: does a list of dates describe a recurring schedule?
 * (P16-09, ADR-036 §4.)
 *
 * Pure and I/O-free. Given the dates on which one payee was seen in one
 * account, decide whether they form a series and, if so, which cadence and
 * which anchor. The answer feeds a CANDIDATE the user must confirm (ADR-036
 * §2) — nothing here writes an obligation, and nothing here is allowed to
 * guess: when the dates do not fit, this returns `null` rather than the nearest
 * plausible cadence.
 *
 * ── Median, not mean ───────────────────────────────────────────────────────
 * The verdict comes from the MEDIAN inter-arrival gap. A single missed month
 * turns one 30-day gap into a 61-day gap; a mean would drag the answer toward
 * quarterly and mislabel a mortgage. A median ignores it entirely, which is the
 * whole reason for the choice.
 *
 * ── Stated tolerances ──────────────────────────────────────────────────────
 * Every bucket below is an explicit day range, not a fuzzy score, because a
 * tolerance a user cannot read is a tolerance nobody can debug:
 *
 *   weekly 6–8 · biweekly 12–16 · semimonthly 13–18 · monthly 28–31 ·
 *   quarterly 89–93 · semiannual 178–187 · annual 360–370
 *
 * Three independent conditions must all hold, or the answer is `null`:
 *
 *   1. **At least three occurrences.** Two dates give one gap, and one gap
 *      cannot disagree with anything — every pair of transactions "fits" some
 *      cadence. Three is the fewest that can corroborate.
 *   2. **The median gap falls in a bucket.**
 *   3. **A majority of the individual gaps fit too** — either inside the bucket
 *      or close to a small whole multiple of it (a skipped occurrence). This is
 *      the condition that rejects a random series whose median happens to land
 *      on 30 by coincidence, which the median alone cannot catch.
 *
 * ── Biweekly vs. semimonthly ───────────────────────────────────────────────
 * The classic confusion: 26 payments a year and 24 payments a year both have a
 * median gap near 15, so the buckets deliberately overlap and a tie is broken
 * by SHAPE rather than by size:
 *
 *   - biweekly gaps are exactly 14 days, forever, including across a skipped
 *     payment (28, 42);
 *   - semimonthly gaps alternate — 16/15/13/15 — and the series lands twice in
 *     every calendar month, which a 14-day series does not.
 *
 * Getting this wrong is not cosmetic. Biweekly projects 26 outflows a year and
 * semimonthly 24; on a $2,000 mortgage the difference is $4,000 of imaginary
 * or missing money over a year, in the number a family spends against.
 *
 * ── Anchors ────────────────────────────────────────────────────────────────
 * The anchor is picked so that re-expanding it through `occurrenceDatesBetween`
 * reproduces the dates that were observed (there is a test asserting exactly
 * that for all seven cadences). Two cases need care:
 *
 *   - **Month-end clamping.** A schedule on the 31st is observed as 31, 28, 31,
 *     30 — clamping only ever REDUCES the day, so the true day is at least the
 *     largest one seen. Anchoring on the most recent date would silently move
 *     every future long-month bill a day early, so the largest observed day
 *     wins whenever it looks like clamping (≥ 29).
 *   - **Semimonthly.** The expander derives the second date as `anchorDay + 15`,
 *     so only the earlier of the two days is recoverable; the anchor is taken
 *     from the earlier half of the month. Where the observed pair is not exactly
 *     15 days apart (a 1st-and-15th series), the second projected date lands up
 *     to two days off. That is a stated tolerance, and it is inside the match
 *     window P16-22 uses — it is not a silent error.
 *
 * Money is not involved here at all; amounts are graded separately by
 * [amount-stability.ts](./amount-stability.ts). Dates only.
 */

/** A detected schedule, or the shape returned when the dates do form a series. */
export interface PeriodicityResult {
  /** The cadence the gaps fit, expandable by `occurrenceDatesBetween`. */
  readonly cadence: ObligationCadence;
  /** A `YYYY-MM-DD` observed date that phases the schedule correctly. */
  readonly anchorDate: string;
  /** How well the dates corroborate the verdict — see `gradeConfidence`. */
  readonly confidence: ObligationConfidence;
}

/** One cadence's accepted gap range, in whole days. */
interface CadenceBucket {
  readonly cadence: ObligationCadence;
  /** The gap a perfectly regular series of this cadence produces. */
  readonly nominal: number;
  readonly minDays: number;
  readonly maxDays: number;
}

/**
 * The stated tolerances, in the order they are tested.
 *
 * `biweekly` and `semimonthly` overlap ON PURPOSE — see the header. Everything
 * else is disjoint, so at most one bucket can claim a median outside 13–16.
 */
const CADENCE_BUCKETS: readonly CadenceBucket[] = [
  { cadence: "weekly", nominal: 7, minDays: 6, maxDays: 8 },
  { cadence: "biweekly", nominal: 14, minDays: 12, maxDays: 16 },
  { cadence: "semimonthly", nominal: 15, minDays: 13, maxDays: 18 },
  { cadence: "monthly", nominal: 30, minDays: 28, maxDays: 31 },
  { cadence: "quarterly", nominal: 91, minDays: 89, maxDays: 93 },
  { cadence: "semiannual", nominal: 182, minDays: 178, maxDays: 187 },
  { cadence: "annual", nominal: 365, minDays: 360, maxDays: 370 },
] as const;

/**
 * The typical gap, in whole days, between two occurrences of a cadence.
 *
 * Exported so staleness ("has this series stopped?") is measured against the
 * SAME nominal periods the detector matched against. A second table of
 * approximate period lengths elsewhere would drift from this one silently.
 *
 * @param cadence - The cadence to measure.
 * @returns Nominal days between occurrences. Calendar months vary; this is the
 *   representative length the buckets are centred on, not an exact figure.
 */
export function nominalGapDays(cadence: ObligationCadence): number {
  const bucket = CADENCE_BUCKETS.find((candidate) => candidate.cadence === cadence);
  if (!bucket) throw new Error(`Unknown cadence: ${cadence}`);
  return bucket.nominal;
}

/** The fewest occurrences that can corroborate a cadence (see header, §1). */
const MIN_OCCURRENCES = 3;

/** How many consecutive occurrences a gap may skip and still count as a fit. */
const MAX_SKIPPED_OCCURRENCES = 4;

/** Below this share of fitting gaps the dates are not a series at all. */
const MIN_FIT_SHARE = 0.5;

const MS_PER_DAY = 86_400_000;

/** Median of a non-empty numeric list. Averages the middle pair when even. */
function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  if (sorted.length % 2 === 1) return sorted[mid] as number;
  return ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

/** Half the bucket width, floored at one day so exact cadences still admit skips. */
function halfWidth(bucket: CadenceBucket): number {
  return Math.max(1, (bucket.maxDays - bucket.minDays) / 2);
}

/** How a single gap relates to the candidate bucket. */
type GapFit = "exact" | "skip" | "outlier";

/**
 * Classify one gap: inside the bucket, near a small multiple of it (one or more
 * missed occurrences), or neither.
 *
 * The tolerance grows with the multiple, because two nominal months are two
 * months of month-length variation, not one.
 */
function classifyGap(gap: number, bucket: CadenceBucket): GapFit {
  if (gap >= bucket.minDays && gap <= bucket.maxDays) return "exact";
  for (let k = 2; k <= MAX_SKIPPED_OCCURRENCES; k += 1) {
    if (Math.abs(gap - k * bucket.nominal) <= k * halfWidth(bucket)) return "skip";
  }
  return "outlier";
}

/**
 * Biweekly or semimonthly? Decided by shape, never by the median (they overlap).
 *
 * @param gaps - Inter-arrival gaps in whole days.
 * @param dateMs - The occurrence instants, ascending.
 * @returns The cadence the shape supports.
 */
function disambiguateShortCadence(
  gaps: readonly number[],
  dateMs: readonly number[],
): ObligationCadence {
  // A 14-day series stays a 14-day series across skipped payments, so whole
  // multiples of 14 are the signature rather than the literal number 14.
  if (gaps.every((gap) => gap % 14 === 0)) return "biweekly";

  // Otherwise: does the series land twice in a typical calendar month? Only
  // interior months are counted — the first and last are partial by definition
  // and would understate the rate.
  const perMonth = new Map<number, number>();
  for (const ms of dateMs) {
    const date = new Date(ms);
    const key = date.getUTCFullYear() * 12 + date.getUTCMonth();
    perMonth.set(key, (perMonth.get(key) ?? 0) + 1);
  }
  const months = [...perMonth.keys()].sort((a, b) => a - b);
  const interior = months.slice(1, -1);
  const counted = (interior.length > 0 ? interior : months).map(
    (month) => perMonth.get(month) as number,
  );
  if (median(counted) === 2) return "semimonthly";

  // Neither signature is present — fall back to whichever nominal is nearer.
  return median(gaps) <= 14 ? "biweekly" : "semimonthly";
}

/** Cadences the expander steps in whole calendar months, where clamping applies. */
const MONTH_STEPPED: ReadonlySet<ObligationCadence> = new Set([
  "monthly",
  "quarterly",
  "semiannual",
  "annual",
]);

/** Day-of-month at or above which a short observed day looks like clamping. */
const CLAMP_SUSPECT_DAY = 29;

/**
 * Choose an observed date that phases the schedule correctly.
 *
 * @param cadence - The detected cadence.
 * @param dateMs - The occurrence instants, ascending.
 * @returns One of the observed dates, `YYYY-MM-DD`. See the header on the two
 *   cases where the most recent date is the wrong answer.
 */
function chooseAnchor(cadence: ObligationCadence, dateMs: readonly number[]): string {
  const days = dateMs.map((ms) => new Date(ms).getUTCDate());

  if (cadence === "semimonthly") {
    // Only the earlier half is recoverable from the anchor (see header).
    const earliestDay = Math.min(...days);
    for (let i = dateMs.length - 1; i >= 0; i -= 1) {
      if (days[i] === earliestDay) return isoOf(dateMs[i] as number);
    }
  }

  if (MONTH_STEPPED.has(cadence)) {
    const largestDay = Math.max(...days);
    const lastDay = days[days.length - 1] as number;
    if (largestDay >= CLAMP_SUSPECT_DAY && lastDay < largestDay) {
      for (let i = dateMs.length - 1; i >= 0; i -= 1) {
        if (days[i] === largestDay) return isoOf(dateMs[i] as number);
      }
    }
  }

  return isoOf(dateMs[dateMs.length - 1] as number);
}

/** Format a UTC-midnight instant back to `YYYY-MM-DD`. */
function isoOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Grade how strongly the dates corroborate the cadence.
 *
 * Two signals, both honest about what they mean: how many occurrences were seen
 * (three is thin evidence however clean it looks), and how many gaps were
 * imperfect. A skipped occurrence is not an error — the series is still real —
 * but it is a reason not to call the reading `high`.
 */
function gradeConfidence(occurrences: number, fits: readonly GapFit[]): ObligationConfidence {
  const outliers = fits.filter((fit) => fit === "outlier").length;
  const skips = fits.filter((fit) => fit === "skip").length;
  if (occurrences >= 6 && outliers === 0 && skips === 0) return "high";
  if (occurrences >= 4 && outliers === 0) return "medium";
  if (occurrences >= 6 && outliers / fits.length <= 0.25) return "medium";
  return "low";
}

/**
 * Decide whether occurrence dates describe a recurring schedule.
 *
 * @param dates - `YYYY-MM-DD` dates one payee was seen on, in any order.
 *   Same-day duplicates are collapsed: two charges in one day are one
 *   occurrence, not a zero-day cadence.
 * @returns The detected cadence, an anchor that reproduces the observed dates,
 *   and a confidence grade — or `null` when the dates do not fit any cadence
 *   within its stated tolerance. Never a nearest guess.
 * @throws If any entry is not a real `YYYY-MM-DD` calendar date. A malformed
 *   date is a caller bug, and silently dropping it would change a cadence.
 */
export function detectPeriodicity(dates: readonly string[]): PeriodicityResult | null {
  const unique = [...new Set(dates)];
  const dateMs = unique.map((date) => parseIsoDate(date, "occurrence date")).sort((a, b) => a - b);
  if (dateMs.length < MIN_OCCURRENCES) return null;

  const gaps: number[] = [];
  for (let i = 1; i < dateMs.length; i += 1) {
    gaps.push(((dateMs[i] as number) - (dateMs[i - 1] as number)) / MS_PER_DAY);
  }

  const medianGap = median(gaps);
  const matching = CADENCE_BUCKETS.filter(
    (bucket) => medianGap >= bucket.minDays && medianGap <= bucket.maxDays,
  );
  if (matching.length === 0) return null;

  const cadence =
    matching.length === 1
      ? (matching[0] as CadenceBucket).cadence
      : disambiguateShortCadence(gaps, dateMs);
  const bucket = CADENCE_BUCKETS.find((b) => b.cadence === cadence) as CadenceBucket;

  // The median can land in a bucket by coincidence; the individual gaps decide.
  const fits = gaps.map((gap) => classifyGap(gap, bucket));
  const fitting = fits.filter((fit) => fit !== "outlier").length;
  if (fitting / fits.length <= MIN_FIT_SHARE) return null;

  return {
    cadence,
    anchorDate: chooseAnchor(cadence, dateMs),
    confidence: gradeConfidence(dateMs.length, fits),
  };
}
