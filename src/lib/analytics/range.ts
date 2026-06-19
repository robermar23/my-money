/**
 * Date-range resolution for the spending-analysis surface (P8-13).
 *
 * Pure functions — no I/O, no DB — so the URL-param → {from,to} mapping and the
 * month enumeration used by the monthly charts are unit-testable in isolation
 * (P8-16). All math is UTC; the app stores `posted_at` as a UTC `YYYY-MM-DD`
 * string and these helpers stay in that space (no local-timezone drift).
 */

/** The preset windows the range selector offers. `custom` reads explicit dates. */
export type RangeKey = "3m" | "6m" | "12m" | "ytd" | "custom";

export interface ResolvedRange {
  readonly key: RangeKey;
  /** Inclusive start date, `YYYY-MM-DD`. */
  readonly from: string;
  /** Inclusive end date, `YYYY-MM-DD`. */
  readonly to: string;
  /** Human label for the active window. */
  readonly label: string;
}

/** Presets shown in the selector, in display order. */
export const RANGE_PRESETS: readonly { key: RangeKey; label: string }[] = [
  { key: "3m", label: "Last 3 months" },
  { key: "6m", label: "Last 6 months" },
  { key: "12m", label: "Last 12 months" },
  { key: "ytd", label: "Year to date" },
] as const;

const DEFAULT_KEY: RangeKey = "12m";
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Format a Date as a UTC `YYYY-MM-DD` string. */
function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * First day of the month that is `monthsBack` whole months before `ref`'s month.
 * `monthsBack = 0` → first of the current month.
 */
function firstOfMonthBack(ref: Date, monthsBack: number): string {
  const d = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth() - monthsBack, 1));
  return isoDate(d);
}

/**
 * Resolve range URL params into a concrete `{from, to}` window.
 *
 * Recognised params:
 *   - `range`: one of {@link RangeKey}. Unknown/missing → `12m`.
 *   - `from` / `to`: `YYYY-MM-DD`. Used only when `range=custom` (or when both
 *     are present and valid). Invalid/mis-ordered custom dates fall back to 12m.
 *
 * "Last N months" means N calendar months *including* the current (possibly
 * partial) month: e.g. on 2026-06-19, `3m` → 2026-04-01 … 2026-06-19.
 *
 * @param params - Raw search params (strings or undefined).
 * @param now - Reference "today" (injected for tests). Defaults to `new Date()`.
 * @returns The resolved, inclusive range.
 */
export function resolveRange(
  params: { range?: string; from?: string; to?: string } | undefined,
  now: Date = new Date(),
): ResolvedRange {
  const to = isoDate(now);
  const requested = params?.range;

  // Explicit custom window (also auto-detected when both dates are supplied).
  if (
    requested === "custom" ||
    (requested === undefined && params?.from !== undefined && params?.to !== undefined)
  ) {
    const cFrom = params?.from;
    const cTo = params?.to;
    if (cFrom && cTo && ISO_DATE.test(cFrom) && ISO_DATE.test(cTo) && cFrom <= cTo) {
      return { key: "custom", from: cFrom, to: cTo, label: `${cFrom} → ${cTo}` };
    }
    // fall through to default on invalid custom input
  }

  switch (requested) {
    case "3m":
      return { key: "3m", from: firstOfMonthBack(now, 2), to, label: "Last 3 months" };
    case "6m":
      return { key: "6m", from: firstOfMonthBack(now, 5), to, label: "Last 6 months" };
    case "12m":
      return { key: "12m", from: firstOfMonthBack(now, 11), to, label: "Last 12 months" };
    case "ytd":
      return {
        key: "ytd",
        from: `${now.getUTCFullYear()}-01-01`,
        to,
        label: "Year to date",
      };
    default:
      return { key: DEFAULT_KEY, from: firstOfMonthBack(now, 11), to, label: "Last 12 months" };
  }
}

/**
 * Enumerate every `YYYY-MM` month touched by an inclusive `[from, to]` date
 * range, so monthly charts render continuous buckets (no gaps for zero-spend
 * months). Empty/zero months are the caller's to fill.
 *
 * @param from - Inclusive start, `YYYY-MM-DD`.
 * @param to - Inclusive end, `YYYY-MM-DD`.
 * @returns Ascending list of `YYYY-MM` strings (at least one element when valid).
 */
export function enumerateMonths(from: string, to: string): string[] {
  const start = new Date(`${from.slice(0, 7)}-01T00:00:00Z`);
  const end = new Date(`${to.slice(0, 7)}-01T00:00:00Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) {
    return [];
  }
  const months: string[] = [];
  const cursor = new Date(start);
  while (cursor <= end) {
    months.push(cursor.toISOString().slice(0, 7));
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return months;
}
