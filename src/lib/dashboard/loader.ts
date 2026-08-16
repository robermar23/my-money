import "server-only";

import { loadPlan } from "@/lib/advice/plan.ts";
import { focusRung } from "@/lib/advice/rules/waterfall.ts";
import type { Recommendation, RungState } from "@/lib/advice/types.ts";
import { listOpenAlerts } from "@/lib/alerts/queries.ts";
import { spendingSummary } from "@/lib/analytics/spending.ts";
import { budgetVsActual, monthRange } from "@/lib/budgets/queries.ts";
import { savingsRateInputs } from "@/lib/income/queries.ts";
import { savingsRate } from "@/lib/income/savings-rate.ts";
import {
  type AllocationSlice,
  type ValuedHolding,
  allocationByAssetClass,
} from "@/lib/investments/allocation.ts";
import { type ForwardHolding, forwardIncome } from "@/lib/investments/forward-income.ts";
import {
  BENCHMARK_SYMBOL,
  type DatedFlow,
  type GainLossSeriesPoint,
  benchmarkTwr,
  externalFlow,
  gainLossSeries,
  twr,
  valueSeries,
} from "@/lib/investments/performance.ts";
import {
  benchmarkCloseSeries,
  listHoldingSnapshots,
  listInvestmentFlows,
} from "@/lib/investments/queries.ts";
import { listValuedPositions } from "@/lib/investments/valued.ts";
import { Money } from "@/lib/money/money.ts";
import {
  type NetWorthBreakdown,
  type NetWorthPoint,
  computeNetWorth,
  netWorthSeries,
} from "@/lib/net-worth/compute.ts";
import { listWatchlist } from "@/lib/watchlist/queries.ts";
import { type RangeDelta, rangeDelta } from "./delta.ts";
import { type DashboardRange, type DashboardWindow, rangeWindow } from "./range.ts";

/**
 * Dashboard data layer (Phase 13, P13-02, ADR-029).
 *
 * `loadDashboard(range)` is the *single* place the dashboard fetches data. It
 * **composes already-tested library functions** — `computeNetWorth`,
 * `netWorthSeries`, `listValuedPositions` → `allocationByAssetClass`/`forwardIncome`,
 * the `performance.ts` series + TWR, `budgetVsActual` + `spendingSummary`,
 * `listOpenAlerts`, and `listWatchlist` — and runs the independent reads in
 * parallel (`Promise.all`). It writes **no new SQL** of its own (CLAUDE.md
 * §Architecture): the dashboard's numbers are identical by construction to the
 * dedicated pages because they call the same functions.
 *
 * Every card field carries a discriminated `status` so the (dumb) card components
 * render their degraded state without re-deriving "is this empty/insufficient."
 * Server-only, zero egress; money stays in {@link Money}/string (no `Number()`).
 */

const BASE_CURRENCY = "USD";

// ── Per-card result shapes (discriminated on `status`) ───────────────────────

/** The net-worth hero — always present (the dashboard's spine). */
export interface NetWorthHero {
  readonly total: Money;
  readonly asOf: Date;
  /** History points within the active range, for the hero chart. */
  readonly series: readonly NetWorthPoint[];
  /** Value-now vs value-at-range-start (P13-03). */
  readonly delta: RangeDelta;
  /** Per-account line items, for the de-emphasized accounts table. */
  readonly accounts: NetWorthBreakdown["items"];
}

export type AllocationCard =
  | { readonly status: "ok"; readonly total: Money; readonly slices: readonly AllocationSlice[] }
  | { readonly status: "empty" };

export type PerformanceCard =
  | {
      readonly status: "ok";
      /** Time-weighted return % string for the range, or null when not computable. */
      readonly twr: string | null;
      readonly benchmarkTwr: string | null;
      /** Portfolio TWR − benchmark TWR (point-difference string), or null. */
      readonly benchmarkDelta: string | null;
      /** Gain/loss series for the sparkline. */
      readonly gainLoss: readonly GainLossSeriesPoint[];
    }
  /** Has investments, but < 2 snapshot days in range (ADR-021: no bogus %). */
  | { readonly status: "insufficient" }
  /** No investment holdings at all. */
  | { readonly status: "empty" };

export interface OverBudgetLine {
  readonly categoryId: string;
  readonly name: string;
  /** actual − target (positive = over), as Money. */
  readonly over: Money;
  /** actual ÷ target × 100 (display ratio). */
  readonly pct: number;
}

export type SpendingCard =
  | {
      readonly status: "ok";
      readonly month: string;
      readonly totalSpend: Money;
      readonly totalBudget: Money;
      /** Run-rate end-of-month projection (in-progress month only), or null. */
      readonly projected: Money | null;
      /** Whether any budget is set this month (drives the "Set budgets" nudge). */
      readonly hasBudgets: boolean;
      /** Top over-budget categories, largest overage first (≤ 3). */
      readonly overBudget: readonly OverBudgetLine[];
      /** Income/expense/net + uncategorized context for the month. */
      readonly summary: {
        readonly income: Money;
        readonly expense: Money;
        readonly net: Money;
        readonly uncategorizedCount: number;
      };
    }
  /** No spend recorded this month and no budgets set. */
  | { readonly status: "empty" };

export interface ForwardPayer {
  readonly holdingId: string;
  readonly symbol: string;
  readonly annualIncome: Money;
}

export type IncomeCard =
  | {
      readonly status: "ok";
      readonly forward12mo: Money;
      readonly yieldOnCost: string | null;
      /** A few of the largest forward-income holdings ("next likely payers"). */
      readonly topPayers: readonly ForwardPayer[];
    }
  /** No dividend-paying holdings. */
  | { readonly status: "empty" };

export interface AlertSummary {
  readonly id: string;
  readonly title: string;
  readonly detectedAt: Date;
}

export type AlertsCard =
  | { readonly status: "ok"; readonly count: number; readonly recent: readonly AlertSummary[] }
  /** No open alerts — a calm, good-news state. */
  | { readonly status: "empty" };

export interface Mover {
  readonly id: string;
  readonly symbol: string;
  readonly label: string | null;
  /** Paper gain/loss percent string (signed). */
  readonly percent: string;
  /** Paper gain/loss absolute. */
  readonly gain: Money;
}

export type MoversCard =
  | { readonly status: "ok"; readonly movers: readonly Mover[] }
  /** No watchlist items with a valuable (priced) paper position. */
  | { readonly status: "empty" };

/**
 * Savings-rate card data — the seam reserved in P13-13, filled in by P14-17.
 *
 * The figures come straight from `savingsRate` (P14-07, ADR-031 §4): the rate is
 * derived on every read and never stored. `window` travels with them because the
 * two halves of the ratio are measured differently — `annualGross` is *projected*
 * forward from the current paycheck, while the contribution totals are *measured*
 * sums over that window. The card states this rather than presenting the number
 * as a fact (the plan's "estimate framing"), and carrying the window means the
 * copy stays true if the loader's window ever changes.
 */
export type SavingsRateCard =
  | {
      readonly status: "ok";
      /** Employee contributions ÷ annual gross × 100; null when gross is zero. */
      readonly ratePct: string | null;
      readonly annualGross: Money;
      readonly annualEmployee: Money;
      readonly annualEmployer: Money;
      /** The contribution window the two totals were summed over. */
      readonly window: DashboardWindow;
    }
  /** No income source defined yet. */
  | { readonly status: "empty" };

/**
 * Household-guidance card data (Phase 15, P15-35, ADR-032).
 *
 * **One** recommendation, not a list. The dashboard's job is to say what is worth
 * looking at; the ranked list lives on `/plan`, and a card that reproduced five
 * of them would be a second, competing guidance surface with its own drift.
 *
 * It comes from the same `loadPlan()` composition `/plan` calls, so the card and
 * the page can never name a different top priority — the two would be read side
 * by side, and disagreeing would discredit both.
 */
export type AdviceCard =
  | {
      readonly status: "ok";
      /** The single highest-severity open recommendation. */
      readonly top: Recommendation;
      /** The rung the household is working on, or `null` when all are done. */
      readonly focus: RungState | null;
      /** How many open recommendations there are in total, for the "+N more". */
      readonly total: number;
    }
  /** Recommendations exist but nothing is open — the calm, good-news state. */
  | { readonly status: "clear"; readonly focus: RungState | null }
  /** Not enough recorded to say anything; `reason` names the missing input. */
  | { readonly status: "empty"; readonly reason: string; readonly href: string };

/** Everything the curated dashboard renders, one field per card. */
export interface DashboardData {
  readonly range: DashboardRange;
  readonly window: DashboardWindow;
  readonly baseCurrency: string;
  /** False on a brand-new install (no accounts) → page shows the first-run prompt. */
  readonly hasAnyAccount: boolean;
  readonly netWorth: NetWorthHero;
  readonly allocation: AllocationCard;
  readonly performance: PerformanceCard;
  readonly spending: SpendingCard;
  readonly income: IncomeCard;
  readonly alerts: AlertsCard;
  readonly movers: MoversCard;
  /**
   * The savings-rate card (P13-13 seam, populated by P14-17). Stays optional:
   * the loader always sets it now, but the field's optionality is what let the
   * card arrive a phase later without a breaking type change.
   */
  readonly savingsRate?: SavingsRateCard;
  /**
   * Household guidance (P15-35). Optional for the same reason `savingsRate` is:
   * it lets the loader's contract absorb a new card without breaking every
   * existing caller and test on the day it lands.
   */
  readonly advice?: AdviceCard;
}

// ── Composition ──────────────────────────────────────────────────────────────

/**
 * Load every figure the curated dashboard renders for the given range.
 *
 * @param range - The active dashboard range (drives the time-series cards).
 * @param now - Reference "today" (injected for tests). Defaults to `new Date()`.
 * @returns Typed, per-card data with discriminated empty/insufficient states.
 */
export async function loadDashboard(
  range: DashboardRange,
  now: Date = new Date(),
): Promise<DashboardData> {
  const window = rangeWindow(range, now);
  const month = now.toISOString().slice(0, 7);
  const today = now.toISOString().slice(0, 10);
  const monthBounds = monthRange(month);

  // The savings rate is annual by definition, so it reads a trailing 12 months
  // regardless of the selected range — a "1M" view of a yearly ratio would be a
  // different (and misleading) number, not a zoomed-in one.
  const savingsWindow = rangeWindow("1Y", now);

  // Independent reads fan out in parallel — one round-trip of concurrent queries.
  const [
    nw,
    series,
    valued,
    snapshots,
    flowTxns,
    benchCloses,
    budget,
    summary,
    openAlerts,
    watch,
    incomeInputs,
    plan,
  ] = await Promise.all([
    computeNetWorth(now, BASE_CURRENCY),
    // Windowed at the database, not in JS. `rangeDelta` re-derives the same
    // `rangeWindow(range, now)` and filters to it internally, so it can never
    // read a point outside `window` — passing a pre-windowed series is exactly
    // equivalent to filtering the full one, minus the full-history query.
    netWorthSeries(BASE_CURRENCY, { from: window.from, to: window.to }),
    listValuedPositions(today),
    listHoldingSnapshots({ from: window.from, to: window.to }),
    listInvestmentFlows({ from: window.from, to: window.to }),
    benchmarkCloseSeries(BENCHMARK_SYMBOL, { from: window.from, to: window.to }),
    budgetVsActual(month, now),
    spendingSummary({ from: monthBounds.from, to: monthBounds.to }),
    listOpenAlerts(),
    listWatchlist(),
    savingsRateInputs(savingsWindow),
    // The guidance snapshot is the heaviest read in this fan-out, but it runs
    // alongside the others rather than after them, and reusing `loadPlan` is
    // what guarantees the card agrees with `/plan` (P15-35).
    loadPlan({ today }, now),
  ]);

  const netWorth: NetWorthHero = {
    total: nw.total,
    asOf: nw.asOf,
    series,
    delta: rangeDelta(series, range, BASE_CURRENCY, now),
    accounts: nw.items,
  };

  return {
    range,
    window,
    baseCurrency: BASE_CURRENCY,
    hasAnyAccount: nw.items.length > 0,
    netWorth,
    allocation: buildAllocation(valued),
    performance: buildPerformance(valued, snapshots, flowTxns, benchCloses),
    spending: buildSpending(budget, summary),
    income: buildIncome(valued),
    alerts: buildAlerts(openAlerts),
    movers: buildMovers(watch),
    savingsRate: buildSavingsRate(incomeInputs, savingsWindow),
    advice: buildAdvice(plan),
  };
}

type Valued = Awaited<ReturnType<typeof listValuedPositions>>;

/** Whether the book has any investment value to slice/measure. */
function hasInvestments(valued: Valued): boolean {
  return valued.positions.length > 0 || valued.balanceOnly.length > 0;
}

/** Asset-class allocation over priced positions + balance-only "other" buckets. */
function buildAllocation(valued: Valued): AllocationCard {
  if (!hasInvestments(valued)) return { status: "empty" };

  const holdings: ValuedHolding[] = [
    ...valued.positions.map((r) => ({
      assetClass: r.position.holding.assetClass,
      accountId: r.position.accountId,
      value: r.value,
      sector: r.position.sector,
      region: r.position.region,
      assetType: r.position.assetType,
    })),
    ...valued.balanceOnly
      .filter((a) => a.currency === BASE_CURRENCY)
      .map((a) => ({
        assetClass: "other",
        accountId: a.accountId,
        value: Money.fromString(a.balance, BASE_CURRENCY),
        sector: null,
        region: null,
        assetType: null,
      })),
  ];

  const slices = allocationByAssetClass(holdings, BASE_CURRENCY);
  if (slices.length === 0) return { status: "empty" };
  const total = Money.sum(
    holdings.map((h) => h.value),
    BASE_CURRENCY,
  );
  return { status: "ok", total, slices };
}

/** TWR + benchmark + gain/loss sparkline; degrades to insufficient/empty. */
function buildPerformance(
  valued: Valued,
  snapshots: Awaited<ReturnType<typeof listHoldingSnapshots>>,
  flowTxns: Awaited<ReturnType<typeof listInvestmentFlows>>,
  benchCloses: Awaited<ReturnType<typeof benchmarkCloseSeries>>,
): PerformanceCard {
  if (!hasInvestments(valued)) return { status: "empty" };

  const values = valueSeries(snapshots, BASE_CURRENCY);
  if (values.length < 2) return { status: "insufficient" };

  const gains = gainLossSeries(snapshots, BASE_CURRENCY);
  const flows: DatedFlow[] = flowTxns.map(externalFlow).filter((f): f is DatedFlow => f !== null);
  const portfolioTwr = twr(values, flows);
  const benchTwr = benchmarkTwr(benchCloses);
  // Mirror the performance page's point-difference of the two %-strings.
  const benchmarkDelta =
    portfolioTwr !== null && benchTwr !== null
      ? Money.fromString(portfolioTwr, BASE_CURRENCY)
          .sub(Money.fromString(benchTwr, BASE_CURRENCY))
          .toString()
      : null;

  return {
    status: "ok",
    twr: portfolioTwr,
    benchmarkTwr: benchTwr,
    benchmarkDelta,
    gainLoss: gains,
  };
}

/** This month's spend-vs-budget + top overages; degrades to empty. */
function buildSpending(
  budget: Awaited<ReturnType<typeof budgetVsActual>>,
  summary: Awaited<ReturnType<typeof spendingSummary>>,
): SpendingCard {
  const totalSpend = Money.fromString(budget.totals.actual, BASE_CURRENCY);
  const totalBudget = Money.fromString(budget.totals.target, BASE_CURRENCY);
  const hasBudgets = budget.lines.some((l) => l.hasBudget);
  const expense = Money.fromString(summary.expense, BASE_CURRENCY);

  // Nothing budgeted and nothing spent → the calm empty state.
  if (!hasBudgets && totalSpend.isZero() && expense.isZero()) return { status: "empty" };

  const overBudget: OverBudgetLine[] = budget.lines
    .filter((l) => l.hasBudget)
    .map((l) => ({
      categoryId: l.categoryId,
      name: l.name,
      over: Money.fromString(l.actual, BASE_CURRENCY).sub(
        Money.fromString(l.target, BASE_CURRENCY),
      ),
      pct: l.pct,
    }))
    .filter((l) => !l.over.isZero() && !l.over.isNegative())
    .sort((a, b) => (b.over.sub(a.over).isNegative() ? -1 : 1))
    .slice(0, 3);

  return {
    status: "ok",
    month: budget.month,
    totalSpend,
    totalBudget,
    projected:
      budget.totals.projected === null
        ? null
        : Money.fromString(budget.totals.projected, BASE_CURRENCY),
    hasBudgets,
    overBudget,
    summary: {
      income: Money.fromString(summary.income, BASE_CURRENCY),
      expense,
      net: Money.fromString(summary.net, BASE_CURRENCY),
      uncategorizedCount: summary.uncategorizedCount,
    },
  };
}

/** Forward 12-month dividend income + yield-on-cost; degrades to empty. */
function buildIncome(valued: Valued): IncomeCard {
  const forwardHoldings: ForwardHolding[] = valued.positions.map((r) => ({
    holdingId: r.position.holding.id,
    symbol: r.position.holding.symbol,
    accountId: r.position.accountId,
    accountName: r.position.accountName,
    quantity: r.position.holding.quantity,
    dividendRate: r.position.dividendRate,
    costBasis: r.costBasis ? r.costBasis.toString() : null,
  }));

  const fwd = forwardIncome(forwardHoldings, BASE_CURRENCY);
  if (fwd.rows.length === 0) return { status: "empty" };

  return {
    status: "ok",
    forward12mo: fwd.total,
    yieldOnCost: fwd.yieldOnCost,
    topPayers: fwd.rows.slice(0, 3).map((r) => ({
      holdingId: r.holdingId,
      symbol: r.symbol,
      annualIncome: r.annualIncome,
    })),
  };
}

/**
 * The single most urgent recommendation plus the current waterfall rung (P15-35).
 *
 * "Most urgent" is not re-derived here: `runAdvice` already sorted by severity,
 * then actionability, then impact, so the top of the list *is* the answer. The
 * card taking `[0]` rather than running its own comparator is what keeps it
 * identical to the first row on `/plan`.
 *
 * The empty state names the missing input rather than saying "no data" — the
 * readiness report already worked out which gap matters most, and its first
 * entry is the one worth putting on the dashboard (P15-37).
 */
function buildAdvice(plan: Awaited<ReturnType<typeof loadPlan>>): AdviceCard {
  const focus = focusRung(plan.advice.waterfall);

  // No transactions at all is genuinely empty; so is a book too thin for any
  // rule to run. Both point at the same fix, and neither is an error.
  if (!plan.readiness.hasHistory || plan.advice.recommendations.length === 0) {
    const gap = plan.readiness.missing[0];
    if (!plan.readiness.hasHistory) {
      return {
        status: "empty",
        reason: "Guidance needs some recorded transactions before it can say anything.",
        href: "/transactions",
      };
    }
    if (plan.advice.recommendations.length === 0 && gap) {
      return { status: "empty", reason: gap.detail, href: gap.href };
    }
    return { status: "clear", focus };
  }

  const top = plan.advice.recommendations[0];
  // Everything the engine returned is `ok` — nothing to act on, which is worth
  // saying plainly rather than rendering an empty card.
  if (!top || plan.advice.recommendations.every((r) => r.status === "ok")) {
    return { status: "clear", focus };
  }

  return { status: "ok", top, focus, total: plan.advice.recommendations.length };
}

/** Open-alert count + the 3 most recent titles (content-free per ADR-015). */
function buildAlerts(open: Awaited<ReturnType<typeof listOpenAlerts>>): AlertsCard {
  if (open.length === 0) return { status: "empty" };
  return {
    status: "ok",
    count: open.length,
    recent: open.slice(0, 3).map((a) => ({ id: a.id, title: a.title, detectedAt: a.detectedAt })),
  };
}

/** Top ±2 watchlist paper movers by gain/loss percent; degrades to empty. */
function buildMovers(watch: Awaited<ReturnType<typeof listWatchlist>>): MoversCard {
  const rows: Mover[] = watch
    .filter((r) => r.valuation.gainLoss.percent !== null && r.valuation.gainLoss.absolute !== null)
    .map((r) => ({
      id: r.id,
      symbol: r.symbol,
      label: r.label,
      // Non-null asserted by the filter above.
      percent: r.valuation.gainLoss.percent as string,
      gain: r.valuation.gainLoss.absolute as Money,
    }))
    // Percent is a display ratio (not money) — Number() for sorting is acceptable.
    .sort((a, b) => Number(b.percent) - Number(a.percent));

  if (rows.length === 0) return { status: "empty" };

  // Top 2 gainers + bottom 2 losers, de-duplicated when fewer than 4 qualify.
  const seen = new Set<string>();
  const movers: Mover[] = [];
  for (const r of [...rows.slice(0, 2), ...rows.slice(-2)]) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    movers.push(r);
  }
  return { status: "ok", movers };
}

/**
 * Savings rate over a trailing year; empty until an income source exists.
 *
 * Delegates every figure to `savingsRate` (P14-07) — the same function the
 * `/settings/income` preview calls, so the dashboard and the rule editor can
 * never disagree about what a contribution is worth.
 */
function buildSavingsRate(
  inputs: Awaited<ReturnType<typeof savingsRateInputs>>,
  window: DashboardWindow,
): SavingsRateCard {
  // No paycheck defined is a genuinely empty card, not a 0% rate: 0% would read
  // as "you save nothing", which is a claim we have no data to make.
  if (inputs.sources.length === 0) return { status: "empty" };

  const rate = savingsRate(inputs.sources, inputs.contributions, BASE_CURRENCY);
  return {
    status: "ok",
    ratePct: rate.ratePct,
    annualGross: rate.annualGross,
    annualEmployee: rate.annualEmployee,
    annualEmployer: rate.annualEmployer,
    window,
  };
}
