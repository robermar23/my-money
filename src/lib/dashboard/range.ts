/**
 * Dashboard time-range resolution (Phase 13, P13-01, ADR-029).
 *
 * A single `?range=` URL param drives the dashboard's time-series cards (the
 * net-worth hero history + the performance card). It is intentionally a *coarser*
 * control than the analysis page's {@link import('../analytics/range.ts').resolveRange}
 * (which offers calendar-month windows + custom dates): the dashboard wants quick,
 * recognizable presets — `1M`/`3M`/`6M`/`1Y`/`YTD`/`ALL` — not a date picker.
 *
 * Pure functions — no I/O, no DB — so the param → `{from,to}` mapping is unit
 * testable (P13-01). All math is UTC; the app stores dates as `YYYY-MM-DD`
 * strings and these helpers stay in that space (no local-timezone drift).
 */

/** The preset windows the dashboard range toggle offers. */
export type DashboardRange = "1M" | "3M" | "6M" | "1Y" | "YTD" | "ALL";

/** Presets shown in the toggle, in display order. */
export const DASHBOARD_RANGES: readonly { key: DashboardRange; label: string }[] = [
  { key: "1M", label: "1M" },
  { key: "3M", label: "3M" },
  { key: "6M", label: "6M" },
  { key: "1Y", label: "1Y" },
  { key: "YTD", label: "YTD" },
  { key: "ALL", label: "All" },
] as const;

/** Default window for missing/garbage `?range=` (ADR-029 §3). */
export const DEFAULT_RANGE: DashboardRange = "1Y";

/**
 * Sentinel lower bound for the `ALL` window — earlier than any plausible
 * `account_snapshots` row, so filtering `date >= from` keeps the entire series.
 */
const ALL_FROM = "0001-01-01";

const VALID = new Set<DashboardRange>(DASHBOARD_RANGES.map((r) => r.key));

/** Inclusive `{from, to}` window, both `YYYY-MM-DD`. */
export interface DashboardWindow {
  readonly from: string;
  readonly to: string;
}

/** Format a Date as a UTC `YYYY-MM-DD` string. */
function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * `monthsBack` whole months before `ref`, preserving the day-of-month (UTC).
 * Day overflow normalizes the JS way (e.g. Mar 31 − 1mo → Mar 3) — acceptable
 * for a coarse dashboard window where the boundary day is not load-bearing.
 */
function monthsBack(ref: Date, months: number): string {
  const d = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth() - months, ref.getUTCDate()));
  return isoDate(d);
}

/**
 * Parse a raw `?range=` value into a {@link DashboardRange}.
 *
 * Recognized values are the six presets (case-insensitive); anything missing or
 * unrecognized falls back to {@link DEFAULT_RANGE} (`1Y`).
 *
 * @param raw - The raw query-param string (or undefined).
 * @returns A valid {@link DashboardRange}.
 */
export function parseDashboardRange(raw: string | undefined): DashboardRange {
  if (raw === undefined) return DEFAULT_RANGE;
  const upper = raw.trim().toUpperCase() as DashboardRange;
  return VALID.has(upper) ? upper : DEFAULT_RANGE;
}

/**
 * Resolve a {@link DashboardRange} into a concrete inclusive `{from, to}` window.
 *
 * `to` is always "today" (`now`). `from` is:
 *   - `1M`/`3M`/`6M`/`1Y` → N months back from today (day-preserving);
 *   - `YTD` → January 1st of the current year;
 *   - `ALL` → a far-past sentinel so no point is excluded.
 *
 * @param range - The resolved range key.
 * @param now - Reference "today" (injected for tests). Defaults to `new Date()`.
 * @returns The inclusive window.
 */
export function rangeWindow(range: DashboardRange, now: Date = new Date()): DashboardWindow {
  const to = isoDate(now);
  switch (range) {
    case "1M":
      return { from: monthsBack(now, 1), to };
    case "3M":
      return { from: monthsBack(now, 3), to };
    case "6M":
      return { from: monthsBack(now, 6), to };
    case "1Y":
      return { from: monthsBack(now, 12), to };
    case "YTD":
      return { from: `${now.getUTCFullYear()}-01-01`, to };
    case "ALL":
      return { from: ALL_FROM, to };
  }
}
