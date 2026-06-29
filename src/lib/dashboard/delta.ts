import { Money } from "@/lib/money/money.ts";
import Decimal from "decimal.js";
import { type DashboardRange, rangeWindow } from "./range.ts";

/**
 * Net-worth range-delta math (Phase 13, P13-03, ADR-029).
 *
 * The hero card shows "how much did net worth move over the selected range" —
 * the value now vs. the value at the range start. This is **display math on
 * money**, so it goes through {@link Money} (decimal.js, penny-exact) and never
 * native float (CLAUDE.md §Money & Numeric Precision); the percentage is the one
 * unavoidable ratio, computed with {@link Decimal}.
 *
 * Pure + I/O-free (the series is fetched by the loader and passed in), so it is
 * unit-tested directly (P13-03). Mirrors the ADR-021 "no bogus number" rule: an
 * empty or single-point window yields a flat, percent-less delta rather than a
 * fabricated move.
 */

/** Direction of a range delta. `flat` covers no-change *and* insufficient data. */
export type DeltaDirection = "up" | "down" | "flat";

/** A dated net-worth value — structural subset of `NetWorthPoint`. */
export interface SeriesPoint {
  readonly date: string;
  readonly value: string;
}

export interface RangeDelta {
  /** end − start, as a signed {@link Money}. Zero when insufficient data. */
  readonly abs: Money;
  /** (end − start) / start × 100, 2dp signed string; null when start is 0 or unknown. */
  readonly pct: string | null;
  /** up / down / flat (flat also when the window has < 2 points). */
  readonly direction: DeltaDirection;
}

/**
 * Compute the net-worth change over a range from the net-worth series.
 *
 * The window is resolved from `range` (so the same `?range=` that slices the hero
 * chart drives the delta); points outside `[from, to]` are ignored. "Start" is
 * the first in-window point, "now" the last. With fewer than two in-window points
 * the delta is `flat` with `pct: null` (no fabricated percentage).
 *
 * @param series - Ascending `{date, value}` net-worth points (full series; this
 *   function does the windowing). Order is not assumed — it sorts defensively.
 * @param range - The active dashboard range.
 * @param currency - Currency for the `abs` Money (single-currency app; default USD).
 * @param now - Reference "today" for the window (injected for tests).
 * @returns The absolute move, percentage (or null), and direction.
 */
export function rangeDelta(
  series: readonly SeriesPoint[],
  range: DashboardRange,
  currency = "USD",
  now: Date = new Date(),
): RangeDelta {
  const flat: RangeDelta = { abs: Money.zero(currency), pct: null, direction: "flat" };

  const { from, to } = rangeWindow(range, now);
  const inWindow = series
    .filter((p) => p.date >= from && p.date <= to)
    .sort((a, b) => a.date.localeCompare(b.date));
  if (inWindow.length < 2) return flat;

  const start = inWindow[0];
  const end = inWindow.at(-1);
  if (!start || !end) return flat;

  const startMoney = Money.fromString(start.value, currency);
  const abs = Money.fromString(end.value, currency).sub(startMoney);
  const direction: DeltaDirection = abs.isZero() ? "flat" : abs.isNegative() ? "down" : "up";

  // Percentage is null when the baseline is zero (division undefined) — the hero
  // shows the absolute move alone rather than an infinite/meaningless percent.
  const startDec = new Decimal(start.value);
  const pct = startDec.isZero()
    ? null
    : new Decimal(abs.toString()).dividedBy(startDec).times(100).toDecimalPlaces(2).toFixed(2);

  return { abs, pct, direction };
}
