import type { ObligationCadence } from "./cadence.ts";

/**
 * Occurrence-date expansion — the ONE implementation (P16-02, ADR-036 §5).
 *
 * Pure, I/O-free date math: given a cadence and an anchor date, enumerate every
 * occurrence inside an inclusive `[from, to]` window. Both the income
 * materializer (via `payDatesBetween`, which delegates here) and the obligation
 * materializer walk these dates, so a drift bug here would silently mis-date
 * years of cost basis AND every projected bill — hence the test-first treatment
 * (CLAUDE.md §Testing Philosophy: date math is an always-test surface).
 *
 * This module is the generalization of what used to live inside
 * [income/schedule.ts](../income/schedule.ts). The internals moved verbatim; the
 * only additions are the three long cadences obligations need (`quarterly`,
 * `semiannual`, `annual`), which reuse the same clamping and the same
 * bidirectional-from-anchor rule. There is deliberately no second copy: two
 * implementations of clamping date math is how a month-length or DST bug ends up
 * fixed in one place and not the other.
 *
 * Two invariants worth stating up front:
 *
 *   1. **The anchor phases the schedule; it does not bound it.** Dates are
 *      generated in BOTH directions from the anchor, so a user who anchors on
 *      the most recent occurrence still gets correct historical dates. The lower
 *      bound is the caller's `from`.
 *   2. **All arithmetic is UTC-midnight**, on `YYYY-MM-DD` strings, never on
 *      local `Date` clock time. A DST transition cannot move a pay date, and it
 *      cannot move a due date either. No value ever round-trips through a float.
 *
 * Month-based cadences CLAMP rather than drift: a monthly schedule anchored on
 * the 31st runs Jan 31 → Feb 28 → Mar 31, because the day always comes from the
 * anchor and never from the previous (clamped) result. The same holds at three,
 * six, and twelve-month steps — a quarterly bill anchored Jan 31 falls Apr 30
 * and then returns to Jul 31.
 */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MS_PER_DAY = 86_400_000;

/** Format a UTC-midnight epoch ms back to `YYYY-MM-DD`. */
function formatIsoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Parse a `YYYY-MM-DD` string to its UTC-midnight epoch ms, validating strictly.
 *
 * Exported because the calendar dimension needs exactly one strict ISO-date
 * parser, for the same reason it needs exactly one occurrence expander: a second
 * copy is how "2026-02-30" ends up rejected in one place and silently rolled
 * over in another. `detectPeriodicity` (P16-09) reads gaps in whole days from
 * the values this returns.
 *
 * @param iso - The candidate date string.
 * @param label - Field name used in the thrown message.
 * @returns UTC-midnight epoch milliseconds.
 * @throws If `iso` is not a real `YYYY-MM-DD` calendar date.
 */
export function parseIsoDate(iso: string, label: string): number {
  if (!ISO_DATE.test(iso)) {
    throw new Error(`${label} must be a YYYY-MM-DD date, got: ${iso}`);
  }
  const ms = Date.parse(`${iso}T00:00:00Z`);
  if (Number.isNaN(ms)) {
    throw new Error(`${label} is not a real date: ${iso}`);
  }
  // Date.parse accepts "2026-02-30" in some engines by rolling over; reject that
  // so a typo cannot silently shift a whole schedule.
  if (formatIsoDate(ms) !== iso) {
    throw new Error(`${label} is not a real date: ${iso}`);
  }
  return ms;
}

/** Number of days in a month (monthIndex is 0-based, as in `Date.getUTCMonth`). */
function daysInMonth(year: number, monthIndex: number): number {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

/** `YYYY-MM-DD` for a day-of-month, clamped to the month's real length. */
function dayOfMonthIso(year: number, monthIndex: number, day: number): string {
  const clamped = Math.min(day, daysInMonth(year, monthIndex));
  return formatIsoDate(Date.UTC(year, monthIndex, clamped));
}

/** Fixed-interval cadences: walk in whole days from the anchor's phase. */
function fixedIntervalDates(anchorMs: number, fromMs: number, toMs: number, stepDays: number) {
  const dates: string[] = [];
  const stepMs = stepDays * MS_PER_DAY;
  // First multiple of the step at or after `from` — Math.ceil handles windows
  // that start before the anchor (negative k) without a special case.
  const k = Math.ceil((fromMs - anchorMs) / stepMs);
  for (let cursor = anchorMs + k * stepMs; cursor <= toMs; cursor += stepMs) {
    dates.push(formatIsoDate(cursor));
  }
  return dates;
}

/**
 * Month-based cadences: iterate calendar months, emitting each due day.
 *
 * `stepMonths` selects which months are in phase with the anchor — 1 for
 * monthly and semimonthly (every month qualifies, so `anchorMonthAbs` cannot
 * change the result), and 3 / 6 / 12 for quarterly / semiannual / annual. The
 * phase test uses absolute month numbers so it behaves identically for windows
 * that start before the anchor.
 */
function monthlyDates(
  fromMs: number,
  toMs: number,
  daysOfMonth: readonly number[],
  stepMonths: number,
  anchorMonthAbs: number,
): string[] {
  const dates: string[] = [];
  const from = new Date(fromMs);
  const to = new Date(toMs);
  const fromIso = formatIsoDate(fromMs);
  const toIso = formatIsoDate(toMs);
  const endMonth = to.getUTCFullYear() * 12 + to.getUTCMonth();
  let year = from.getUTCFullYear();
  let monthIndex = from.getUTCMonth();

  while (year * 12 + monthIndex <= endMonth) {
    // A negative dividend still yields 0 exactly when divisible, which is all
    // this phase test asks — the sign never needs normalising.
    const inPhase = (year * 12 + monthIndex - anchorMonthAbs) % stepMonths === 0;
    if (inPhase) {
      for (const day of daysOfMonth) {
        const iso = dayOfMonthIso(year, monthIndex, day);
        // The month loop is inclusive at both ends, so the first and last months
        // still need a day-level bound check.
        if (iso >= fromIso && iso <= toIso) {
          dates.push(iso);
        }
      }
    }
    monthIndex += 1;
    if (monthIndex > 11) {
      monthIndex = 0;
      year += 1;
    }
  }
  return dates;
}

/** Absolute month number (`year * 12 + monthIndex`) of a UTC-midnight instant. */
function monthAbs(ms: number): number {
  const date = new Date(ms);
  return date.getUTCFullYear() * 12 + date.getUTCMonth();
}

/** Whole months between occurrences, for the cadences that step by calendar month. */
const MONTH_STEPS = {
  monthly: 1,
  quarterly: 3,
  semiannual: 6,
  annual: 12,
} as const satisfies Partial<Record<ObligationCadence, number>>;

/**
 * Expand a recurrence across an inclusive window.
 *
 * Cadence semantics:
 *   - `weekly` / `biweekly` — every 7 / 14 days from the anchor, in both
 *     directions, so the anchor's weekday is preserved forever.
 *   - `semimonthly` — twice a month on days `d` and `d + 15`, where `d` is the
 *     anchor's day-of-month normalised into 1–15 (a 30th anchor and a 15th
 *     anchor describe the same schedule). Days past the month's length clamp to
 *     its last day, so a 31st anchor falls on the 16th and the last day of month.
 *   - `monthly` / `quarterly` / `semiannual` / `annual` — the anchor's
 *     day-of-month every 1 / 3 / 6 / 12 calendar months, in both directions,
 *     clamped to each month's length.
 *
 * @param cadence - How often the schedule recurs.
 * @param anchorDate - A known-real occurrence date, `YYYY-MM-DD`. Phases the schedule.
 * @param from - Inclusive window start, `YYYY-MM-DD`.
 * @param to - Inclusive window end, `YYYY-MM-DD`.
 * @returns Ascending, de-duplicated occurrence dates inside the window. Empty
 *   when the window is inverted or contains no occurrence.
 * @throws If any date is not a real `YYYY-MM-DD` value, or the cadence is unknown.
 */
export function occurrenceDatesBetween(
  cadence: ObligationCadence,
  anchorDate: string,
  from: string,
  to: string,
): string[] {
  const anchorMs = parseIsoDate(anchorDate, "anchorDate");
  const fromMs = parseIsoDate(from, "from");
  const toMs = parseIsoDate(to, "to");
  if (fromMs > toMs) return [];

  switch (cadence) {
    case "weekly":
      return fixedIntervalDates(anchorMs, fromMs, toMs, 7);
    case "biweekly":
      return fixedIntervalDates(anchorMs, fromMs, toMs, 14);
    case "semimonthly": {
      const anchorDay = new Date(anchorMs).getUTCDate();
      const first = anchorDay > 15 ? anchorDay - 15 : anchorDay;
      return monthlyDates(fromMs, toMs, [first, first + 15], 1, monthAbs(anchorMs));
    }
    case "monthly":
    case "quarterly":
    case "semiannual":
    case "annual":
      return monthlyDates(
        fromMs,
        toMs,
        [new Date(anchorMs).getUTCDate()],
        MONTH_STEPS[cadence],
        monthAbs(anchorMs),
      );
    default:
      throw new Error(`Unknown cadence: ${cadence}`);
  }
}
