import type { IncomeCadence } from "@/db/schema/income-sources.ts";

/**
 * Pay-schedule expansion (P14-05, ADR-031).
 *
 * Pure, I/O-free date math: given a cadence and an anchor pay date, enumerate
 * every pay date inside an inclusive `[from, to]` window. This is what the
 * materialization job and the backfill both walk, so a drift bug here would
 * silently mis-date cost basis for years of history — hence the test-first
 * treatment (CLAUDE.md §Testing Philosophy: date math is an always-test surface).
 *
 * Two invariants worth stating up front:
 *
 *   1. **The anchor phases the schedule; it does not bound it.** Pay dates are
 *      generated in BOTH directions from the anchor, so a user who anchors on
 *      their most recent payday still backfills correct historical dates. The
 *      lower bound is the caller's `from` (the income source's `start_date`).
 *   2. **All arithmetic is UTC-midnight**, on `YYYY-MM-DD` strings, never on
 *      local `Date` clock time. A DST transition cannot move a pay date, and no
 *      value ever round-trips through a float.
 *
 * Day-of-month cadences CLAMP rather than drift: a monthly schedule anchored on
 * the 31st pays Jan 31 → Feb 28 → Mar 31, because the day always comes from the
 * anchor and never from the previous (clamped) result.
 */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MS_PER_DAY = 86_400_000;

/** Conventional pay periods per year, by cadence — the savings-rate annualizer. */
const PERIODS_PER_YEAR: Record<IncomeCadence, number> = {
  weekly: 52,
  biweekly: 26,
  semimonthly: 24,
  monthly: 12,
};

/**
 * Pay periods in a year for a cadence.
 *
 * @param cadence - The income source's cadence.
 * @returns 52 / 26 / 24 / 12.
 * @throws If the cadence is not one of the four known values.
 */
export function periodsPerYear(cadence: IncomeCadence): number {
  const periods = PERIODS_PER_YEAR[cadence];
  if (periods === undefined) {
    throw new Error(`Unknown income cadence: ${cadence}`);
  }
  return periods;
}

/** Parse a `YYYY-MM-DD` string to its UTC-midnight epoch ms, validating strictly. */
function parseIsoDate(iso: string, label: string): number {
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

/** Format a UTC-midnight epoch ms back to `YYYY-MM-DD`. */
function formatIsoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
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

/** Day-of-month cadences: iterate calendar months, emitting each pay day. */
function monthlyDates(fromMs: number, toMs: number, daysOfMonth: readonly number[]): string[] {
  const dates: string[] = [];
  const from = new Date(fromMs);
  const to = new Date(toMs);
  const fromIso = formatIsoDate(fromMs);
  const toIso = formatIsoDate(toMs);
  const endMonth = to.getUTCFullYear() * 12 + to.getUTCMonth();
  let year = from.getUTCFullYear();
  let monthIndex = from.getUTCMonth();

  while (year * 12 + monthIndex <= endMonth) {
    for (const day of daysOfMonth) {
      const iso = dayOfMonthIso(year, monthIndex, day);
      // The month loop is inclusive at both ends, so the first and last months
      // still need a day-level bound check.
      if (iso >= fromIso && iso <= toIso) {
        dates.push(iso);
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

/**
 * Expand a pay schedule across an inclusive window.
 *
 * Cadence semantics:
 *   - `weekly` / `biweekly` — every 7 / 14 days from the anchor, in both
 *     directions, so the anchor's weekday is preserved forever.
 *   - `semimonthly` — twice a month on days `d` and `d + 15`, where `d` is the
 *     anchor's day-of-month normalised into 1–15 (a 30th anchor and a 15th
 *     anchor describe the same schedule). Days past the month's length clamp to
 *     its last day, so a 31st anchor pays the 16th and the last day of month.
 *   - `monthly` — the anchor's day-of-month, clamped to each month's length.
 *
 * @param cadence - How often the source pays.
 * @param anchorDate - A known pay date, `YYYY-MM-DD`. Phases the schedule.
 * @param from - Inclusive window start, `YYYY-MM-DD`.
 * @param to - Inclusive window end, `YYYY-MM-DD`.
 * @returns Ascending, de-duplicated pay dates inside the window. Empty when the
 *   window is inverted or contains no pay date.
 * @throws If any date is not a real `YYYY-MM-DD` value, or the cadence is unknown.
 */
export function payDatesBetween(
  cadence: IncomeCadence,
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
      return monthlyDates(fromMs, toMs, [first, first + 15]);
    }
    case "monthly":
      return monthlyDates(fromMs, toMs, [new Date(anchorMs).getUTCDate()]);
    default:
      throw new Error(`Unknown income cadence: ${cadence}`);
  }
}
