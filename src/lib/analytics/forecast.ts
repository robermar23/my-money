import { Money } from "@/lib/money/money.ts";
import type { MonthlyTotals } from "./spending.ts";

/**
 * Deterministic spend forecasting (P8-21, ADR-018 §7).
 *
 * Two pure, I/O-free projections — both unit-tested (P8-23):
 *   - {@link forecastMonthlySpend}: next-month spend per category as the mean of
 *     the trailing N months (skipping the leading run of empty months before the
 *     account had any activity; middle gap months are real zeros and stay in the
 *     window). No ML, no recurring-merchant detection — a flat trailing average.
 *   - {@link runRateToMonthEnd}: projected end-of-month total for the *current*
 *     in-progress month, extrapolated from month-to-date spend at the elapsed
 *     run-rate. Feeds the budgets-page "projected" marker.
 *
 * Money discipline (CLAUDE.md §Money): every sum/mean goes through {@link Money}
 * (decimal.js, penny-exact); the only consumers that touch `Number()` are the
 * display-edge chart islands. USD assumed (single-currency app).
 */

const CURRENCY = "USD";

/** Tuning for {@link forecastMonthlySpend}. */
export interface ForecastOptions {
  /** Trailing months to average. Default 3 (ADR-018 §7); floored to ≥ 1. */
  readonly months?: number;
}

/** Projected next-month totals derived from a trailing average. */
export interface MonthlyForecast {
  /** Projected expense magnitude per category id (positive money strings). */
  readonly byCategory: Record<string, string>;
  /** Projected total expense (positive money string). */
  readonly expense: string;
  /** Projected total income (positive money string). */
  readonly income: string;
  /** Projected net = income − expense (positive = saved). */
  readonly net: string;
  /** Trailing months actually averaged; 0 when there is no activity (→ all zero). */
  readonly basisMonths: number;
}

/** A month with no income and no expense — i.e. no activity at all. */
function isEmptyMonth(m: MonthlyTotals): boolean {
  return (
    Money.fromString(m.income, CURRENCY).isZero() && Money.fromString(m.expense, CURRENCY).isZero()
  );
}

/** Mean of money strings over a fixed divisor (penny-exact via {@link Money}). */
function mean(values: readonly string[], divisor: number): Money {
  return Money.sum(
    values.map((v) => Money.fromString(v, CURRENCY)),
    CURRENCY,
  ).div(divisor);
}

/**
 * Project next month's spend as the mean of the trailing N months.
 *
 * Leading empty months (before any activity) are dropped so a freshly-imported
 * history doesn't dilute the average toward zero; gap months *after* activity
 * began are genuine zeros and remain in the averaging window. The divisor is the
 * window length (≥ 1 once any activity exists), so there is never a divide-by-zero
 * — an all-empty (or empty) history returns all zeros with `basisMonths = 0`.
 *
 * @param history - Ascending monthly totals (e.g. from `spendByMonth`).
 * @param options - Trailing window size (default 3).
 * @returns Per-category projection plus income/expense/net and the basis count.
 */
export function forecastMonthlySpend(
  history: readonly MonthlyTotals[],
  options: ForecastOptions = {},
): MonthlyForecast {
  const n = Math.max(1, Math.floor(options.months ?? 3));
  const zero: MonthlyForecast = {
    byCategory: {},
    expense: "0.00",
    income: "0.00",
    net: "0.00",
    basisMonths: 0,
  };

  // Drop the leading run of empty months; keep everything from first activity on.
  const firstActive = history.findIndex((m) => !isEmptyMonth(m));
  if (firstActive === -1) return zero; // no activity anywhere → flat zero, no /0
  const active = history.slice(firstActive);

  // Trailing window: the last min(n, available) months. Divisor = window length.
  const window = active.slice(Math.max(0, active.length - n));
  const divisor = window.length; // guaranteed ≥ 1

  // Per-category mean over every id seen anywhere in the window (missing = 0).
  const catIds = new Set<string>();
  for (const m of window) {
    for (const id of Object.keys(m.byCategory)) catIds.add(id);
  }
  const byCategory: Record<string, string> = {};
  for (const id of catIds) {
    byCategory[id] = mean(
      window.map((m) => m.byCategory[id] ?? "0"),
      divisor,
    ).toString();
  }

  const expense = mean(
    window.map((m) => m.expense),
    divisor,
  );
  const income = mean(
    window.map((m) => m.income),
    divisor,
  );

  return {
    byCategory,
    expense: expense.toString(),
    income: income.toString(),
    net: income.sub(expense).toString(),
    basisMonths: divisor,
  };
}

/** Inclusive last day-of-month number for a `YYYY-MM` key (UTC). */
function daysInMonth(month: string): number {
  const year = Number(month.slice(0, 4));
  const mon = Number(month.slice(5, 7)); // 1-12
  return new Date(Date.UTC(year, mon, 0)).getUTCDate();
}

/**
 * Extrapolate month-to-date spend to a projected end-of-month total at the
 * current run-rate: `mtd × daysInMonth / dayOfMonth`.
 *
 * Only meaningful for the *in-progress* month — the calendar month containing
 * `now`. For any other month it returns `null`: past months are already final
 * (their actual *is* the total) and future months have no data to extrapolate.
 *
 * @param mtd - Month-to-date actual magnitude (money string).
 * @param month - `YYYY-MM` the actual covers.
 * @param now - Reference "today" (injected for tests). Defaults to `new Date()`.
 * @returns Projected full-month money string, or `null` when not in-progress.
 */
export function runRateToMonthEnd(
  mtd: string,
  month: string,
  now: Date = new Date(),
): string | null {
  const nowMonth = now.toISOString().slice(0, 7);
  if (nowMonth !== month) return null; // only the current, in-progress month

  const total = daysInMonth(month);
  const elapsed = now.getUTCDate();
  if (elapsed >= total) return Money.fromString(mtd, CURRENCY).toString(); // last day → final

  return Money.fromString(mtd, CURRENCY).mul(total).div(elapsed).toString();
}
