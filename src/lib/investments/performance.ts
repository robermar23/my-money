import { Money } from "@/lib/money/money.ts";
import Decimal from "decimal.js";

/**
 * Investment performance math (PLAN9 Batch 3, ADR-021). Pure, I/O-free, and
 * `Decimal`/`Money`-based — never native float arithmetic (CLAUDE.md §Money &
 * Numeric Precision). Every figure here is a **display metric**, not tax or
 * advice: no tax-lot selection, no realized/unrealized *tax* reporting, no wash
 * sales, no 1099 (CLAUDE.md §Domain Scope, reaffirmed by Phase 9).
 *
 * Five surfaces, all unit-tested (P9-13 — the highest-TDD-payoff batch):
 *   - {@link valueSeries} / {@link gainLossSeries}: value & gain-over-time from
 *     per-holding `holding_snapshots`.
 *   - {@link externalFlow} / {@link netExternalFlows}: classify the cash that
 *     crosses the portfolio boundary (contributions/withdrawals) from
 *     `investment_transactions`.
 *   - {@link attribution}: split a period's change into contributions vs. market
 *     growth.
 *   - {@link xirr} / {@link moneyWeightedReturn}: money-weighted (personal) return.
 *   - {@link twr} / {@link benchmarkTwr}: time-weighted return + the benchmark
 *     comparison.
 */

const CURRENCY = "USD";

/** The benchmark index: a single symbol in `prices`, not a new table (ADR-021). */
export const BENCHMARK_SYMBOL = "^GSPC" as const;

// ── Value & gain/loss series (P9-09) ────────────────────────────────────────

/** A per-holding snapshot row — structural subset of `HoldingSnapshotRow`. */
export interface ValuedSnapshot {
  readonly date: string;
  readonly value: string;
  /** Resolved basis on that date; null when unknown (cash, manual, no lots). */
  readonly costBasis: string | null;
}

export interface ValueSeriesPoint {
  readonly date: string;
  /** Total portfolio value on the date (money string). */
  readonly value: string;
}

export interface GainLossSeriesPoint {
  readonly date: string;
  /** Total value across every holding that day. */
  readonly value: string;
  /** Sum of *known* cost bases, or null when none is known that day. */
  readonly costBasis: string | null;
  /** value(basis-known subset) − costBasis, or null when no basis is known. */
  readonly gain: string | null;
}

/** Ascending list of distinct dates across the snapshot rows. */
function sortedDates(snapshots: readonly { date: string }[]): string[] {
  const set = new Set<string>();
  for (const s of snapshots) set.add(s.date);
  return [...set].sort();
}

/**
 * Total portfolio value per date — the value-over-time line.
 *
 * @param snapshots - Per-holding snapshot rows (any grain; filter before calling
 *   for asset-class/security series).
 * @param currency - Currency to sum in (single-currency app; default USD).
 * @returns Ascending `{date, value}` points; `[]` for empty input (never NaN).
 */
export function valueSeries(
  snapshots: readonly ValuedSnapshot[],
  currency: string = CURRENCY,
): ValueSeriesPoint[] {
  const byDate = new Map<string, Money>();
  for (const s of snapshots) {
    const acc = byDate.get(s.date) ?? Money.zero(currency);
    byDate.set(s.date, acc.add(Money.fromString(s.value, currency)));
  }
  return sortedDates(snapshots).map((date) => ({
    date,
    value: (byDate.get(date) ?? Money.zero(currency)).toString(),
  }));
}

/**
 * Value, known cost basis, and gain (value − basis) per date.
 *
 * Mirrors {@link import('./gain-loss.ts').portfolioGainLoss}: `value` covers
 * every holding, but `gain` is computed only over the basis-known subset so
 * unknown-basis positions (cash, manual) don't silently distort the line.
 *
 * @param snapshots - Per-holding snapshot rows.
 * @param currency - Currency to sum in (default USD).
 * @returns Ascending gain/loss points; `[]` for empty input.
 */
export function gainLossSeries(
  snapshots: readonly ValuedSnapshot[],
  currency: string = CURRENCY,
): GainLossSeriesPoint[] {
  interface Acc {
    total: Money;
    knownValue: Money;
    knownBasis: Money;
    hasKnown: boolean;
  }
  const byDate = new Map<string, Acc>();
  for (const s of snapshots) {
    const acc = byDate.get(s.date) ?? {
      total: Money.zero(currency),
      knownValue: Money.zero(currency),
      knownBasis: Money.zero(currency),
      hasKnown: false,
    };
    const value = Money.fromString(s.value, currency);
    acc.total = acc.total.add(value);
    if (s.costBasis !== null) {
      acc.knownValue = acc.knownValue.add(value);
      acc.knownBasis = acc.knownBasis.add(Money.fromString(s.costBasis, currency));
      acc.hasKnown = true;
    }
    byDate.set(s.date, acc);
  }
  return sortedDates(snapshots).map((date) => {
    const acc = byDate.get(date);
    if (!acc) return { date, value: "0.00", costBasis: null, gain: null };
    return {
      date,
      value: acc.total.toString(),
      costBasis: acc.hasKnown ? acc.knownBasis.toString() : null,
      gain: acc.hasKnown ? acc.knownValue.sub(acc.knownBasis).toString() : null,
    };
  });
}

// ── External cash flows (P9-10) ─────────────────────────────────────────────

export interface DatedFlow {
  readonly date: string;
  /** Portfolio convention: positive = contributed IN, negative = withdrawn OUT. */
  readonly amount: string;
}

/** The investment-transaction fields the flow classifier reads. */
export interface FlowTxn {
  readonly type: string;
  readonly subtype: string | null;
  /** App convention: positive = cash inflow to the account. */
  readonly amount: string;
  readonly date: string;
}

/**
 * Classify a transaction as an external flow crossing the portfolio boundary.
 *
 * "External" = money the owner put in or took out — what TWR/XIRR must neutralize
 * and attribution must subtract. Per ADR-021 the set is buys/deposits (in) and
 * sells/withdrawals (out); dividends, interest, and fees are *internal* (income
 * earned / cost incurred on money already inside) and return null.
 *
 * Magnitude uses `|amount|` so the result is robust to the upstream sign of the
 * Plaid `amount` (which means different things for a buy vs. a deposit); the
 * direction comes from the transaction `type`/`subtype`, not the sign.
 *
 * @param txn - A mapped investment-transaction row.
 * @returns A portfolio-convention dated flow, or null when not an external flow.
 */
export function externalFlow(txn: FlowTxn): DatedFlow | null {
  const magnitude = Money.fromString(txn.amount, CURRENCY);
  const abs = magnitude.isNegative() ? magnitude.negate() : magnitude;
  const inflow = (): DatedFlow => ({ date: txn.date, amount: abs.toString() });
  const outflow = (): DatedFlow => ({ date: txn.date, amount: abs.negate().toString() });

  switch (txn.type) {
    case "buy":
      return inflow();
    case "sell":
      return outflow();
    case "cash":
      if (txn.subtype === "deposit") return inflow();
      if (txn.subtype === "withdrawal") return outflow();
      return null; // dividend/interest in cash → internal income, not a flow
    default:
      return null; // fee, transfer, cancel → not an external contribution
  }
}

/** Net external flow over a set of already-classified dated flows. */
export function netExternalFlows(flows: readonly DatedFlow[], currency: string = CURRENCY): Money {
  return Money.sum(
    flows.map((f) => Money.fromString(f.amount, currency)),
    currency,
  );
}

// ── Contributions vs. market growth (P9-10) ─────────────────────────────────

export interface Attribution {
  readonly startValue: string;
  readonly endValue: string;
  /** Σ external flows (positive = net contributed in). */
  readonly netFlows: string;
  /** (endValue − startValue) − netFlows: the part that is *market*, not deposits. */
  readonly marketGrowth: string;
}

/**
 * Split a period's value change into contributions vs. market growth.
 *
 * `marketGrowth = (endValue − startValue) − netFlows`. A flat market with a
 * deposit ⇒ marketGrowth ≈ 0; appreciation with no flows ⇒ marketGrowth = Δvalue.
 *
 * @param startValue - Portfolio value at the range start (money string).
 * @param endValue - Portfolio value at the range end (money string).
 * @param flows - External flows within the range (portfolio convention).
 * @param currency - Currency (default USD).
 * @returns The four figures as money strings.
 */
export function attribution(
  startValue: string,
  endValue: string,
  flows: readonly DatedFlow[],
  currency: string = CURRENCY,
): Attribution {
  const start = Money.fromString(startValue, currency);
  const end = Money.fromString(endValue, currency);
  const netFlows = netExternalFlows(flows, currency);
  const marketGrowth = end.sub(start).sub(netFlows);
  return {
    startValue: start.toString(),
    endValue: end.toString(),
    netFlows: netFlows.toString(),
    marketGrowth: marketGrowth.toString(),
  };
}

// ── Money-weighted return / XIRR (P9-11) ────────────────────────────────────

const DAYS_PER_YEAR = 365;
const MS_PER_DAY = 86_400_000;

/** Whole-day difference (ACT/365 basis) between two `YYYY-MM-DD` dates. */
function yearsBetween(from: string, to: string): Decimal {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  const days = (b - a) / MS_PER_DAY;
  return new Decimal(days).dividedBy(DAYS_PER_YEAR);
}

/** NPV of investor-convention flows at rate `r` (decimal, e.g. 0.1 = 10%). */
function npv(flows: readonly { years: Decimal; amount: Decimal }[], r: Decimal): Decimal {
  const base = r.plus(1);
  let total = new Decimal(0);
  for (const f of flows) {
    total = total.plus(f.amount.dividedBy(base.pow(f.years)));
  }
  return total;
}

/** d/dr NPV — used by Newton–Raphson. */
function npvDerivative(flows: readonly { years: Decimal; amount: Decimal }[], r: Decimal): Decimal {
  const base = r.plus(1);
  let total = new Decimal(0);
  for (const f of flows) {
    // d/dr [cf·(1+r)^-t] = -t·cf·(1+r)^(-t-1)
    total = total.plus(f.amount.times(f.years.negated()).dividedBy(base.pow(f.years.plus(1))));
  }
  return total;
}

/**
 * Money-weighted (internal) rate of return over dated cash flows — XIRR.
 *
 * Flows are in **investor convention**: negative = money paid in (a purchase /
 * the starting value), positive = money received (a withdrawal / the ending
 * value). Solves `Σ amount / (1+r)^years = 0` by Newton–Raphson with a bisection
 * fallback for non-convergence, all on `Decimal`.
 *
 * @param flows - Dated cash flows (investor convention). Needs ≥ 2 flows with at
 *   least one sign change, otherwise the IRR is undefined.
 * @returns Annualized return as a 2dp percent string (e.g. "10.00"), or null
 *   when undefined / non-convergent.
 */
export function xirr(flows: readonly DatedFlow[]): string | null {
  if (flows.length < 2) return null;

  const sorted = [...flows].sort((a, b) => a.date.localeCompare(b.date));
  const base = sorted[0]?.date;
  if (base === undefined) return null;

  const terms = sorted.map((f) => ({
    years: yearsBetween(base, f.date),
    amount: new Decimal(f.amount),
  }));

  // No sign change ⇒ no root (all contributions or all withdrawals).
  const hasPos = terms.some((t) => t.amount.greaterThan(0));
  const hasNeg = terms.some((t) => t.amount.lessThan(0));
  if (!hasPos || !hasNeg) return null;
  // All flows on one day ⇒ no time span to annualize over.
  if (terms.every((t) => t.years.isZero())) return null;

  // Newton–Raphson from a 10% guess.
  let r = new Decimal(0.1);
  const TOL = new Decimal("1e-9");
  for (let i = 0; i < 100; i++) {
    const f = npv(terms, r);
    if (f.abs().lessThan(TOL)) return annualPercent(r);
    const fp = npvDerivative(terms, r);
    if (fp.isZero()) break;
    const next = r.minus(f.dividedBy(fp));
    if (next.lessThanOrEqualTo(-1)) break; // left the valid domain → bisect
    if (next.minus(r).abs().lessThan(TOL)) return annualPercent(next);
    r = next;
  }

  // Bisection fallback on a wide bracket where NPV changes sign.
  return bisectIrr(terms);
}

/** Bracketed bisection over (−0.9999, 100] for a sign change in NPV. */
function bisectIrr(flows: readonly { years: Decimal; amount: Decimal }[]): string | null {
  let lo = new Decimal("-0.9999");
  let hi = new Decimal(100);
  let flo = npv(flows, lo);
  let fhi = npv(flows, hi);
  if (flo.times(fhi).greaterThan(0)) return null; // no sign change in the bracket

  const TOL = new Decimal("1e-9");
  for (let i = 0; i < 200; i++) {
    const mid = lo.plus(hi).dividedBy(2);
    const fmid = npv(flows, mid);
    if (fmid.abs().lessThan(TOL) || hi.minus(lo).abs().lessThan(TOL)) {
      return annualPercent(mid);
    }
    if (flo.times(fmid).lessThan(0)) {
      hi = mid;
      fhi = fmid;
    } else {
      lo = mid;
      flo = fmid;
    }
  }
  return annualPercent(lo.plus(hi).dividedBy(2));
}

/** A decimal rate (0.1) → a 2dp percent string ("10.00"). */
function annualPercent(rate: Decimal): string {
  return rate.times(100).toDecimalPlaces(2).toFixed(2);
}

/**
 * Money-weighted return for a portfolio over a range, given its start/end value
 * and the external flows between. A thin wrapper over {@link xirr} that builds
 * the investor-convention flow list: the starting value is a purchase
 * (−startValue at startDate), each contribution is money paid in (−amount), each
 * withdrawal is money received (−amount, which is positive), and the ending value
 * is the liquidation (+endValue at endDate).
 *
 * @returns Annualized money-weighted return percent string, or null when the
 *   range carries no usable history.
 */
export function moneyWeightedReturn(args: {
  readonly startValue: string;
  readonly startDate: string;
  readonly endValue: string;
  readonly endDate: string;
  readonly flows: readonly DatedFlow[];
}): string | null {
  const start = new Decimal(args.startValue);
  const end = new Decimal(args.endValue);
  if (start.isZero() && args.flows.length === 0) return null;

  const investor: DatedFlow[] = [
    { date: args.startDate, amount: start.negated().toFixed(2) },
    ...args.flows.map((f) => ({
      date: f.date,
      amount: new Decimal(f.amount).negated().toFixed(2),
    })),
    { date: args.endDate, amount: end.toFixed(2) },
  ];
  return xirr(investor);
}

// ── Time-weighted return + benchmark (P9-12) ────────────────────────────────

/**
 * Time-weighted return over a daily value series, neutralizing the size/timing
 * of external flows by chaining per-period sub-returns.
 *
 * Flows are assumed to land at the *start* of their day (contributed then
 * invested), so the day's return is `V_t / (V_{t-1} + F_t) − 1`. With no flows
 * this collapses to `V_last / V_first − 1` (the simple return), and a pure
 * contribution day yields a 0% sub-return (no distortion).
 *
 * @param dailyValues - Ascending `{date, value}` portfolio values (≥ 2 needed).
 * @param flows - External flows by date (portfolio convention; positive = in).
 * @returns Total time-weighted return as a 2dp percent string, or null when
 *   there is insufficient history (< 2 valued days).
 */
export function twr(
  dailyValues: readonly ValueSeriesPoint[],
  flows: readonly DatedFlow[] = [],
): string | null {
  if (dailyValues.length < 2) return null;

  const flowByDate = new Map<string, Decimal>();
  for (const f of flows) {
    flowByDate.set(f.date, (flowByDate.get(f.date) ?? new Decimal(0)).plus(new Decimal(f.amount)));
  }

  let growth = new Decimal(1);
  let valid = false;
  for (let i = 1; i < dailyValues.length; i++) {
    const prev = new Decimal(dailyValues[i - 1]?.value ?? "0");
    const curr = new Decimal(dailyValues[i]?.value ?? "0");
    const flow = flowByDate.get(dailyValues[i]?.date ?? "") ?? new Decimal(0);
    const denom = prev.plus(flow);
    if (denom.lessThanOrEqualTo(0)) continue; // can't form a return across a zero base
    growth = growth.times(curr.dividedBy(denom));
    valid = true;
  }
  if (!valid) return null;
  return annualPercent(growth.minus(1));
}

/**
 * Benchmark time-weighted return: a hypothetical buy-and-hold of the index over
 * the same date axis. With no flows this is simply `lastClose / firstClose − 1`,
 * run through {@link twr} so it shares the exact same engine as the portfolio.
 *
 * @param closes - Ascending `{date, value}` benchmark closes (value = close).
 * @returns The benchmark return percent string, or null for insufficient data.
 */
export function benchmarkTwr(closes: readonly ValueSeriesPoint[]): string | null {
  return twr(closes, []);
}

/**
 * Cumulative time-weighted return as a "growth of `base`" index series — the
 * apples-to-apples line for overlaying portfolio vs. benchmark. The first point
 * is `base`; each subsequent point chains the same flow-neutralized daily
 * sub-return as {@link twr}, so the two lines start together and diverge only by
 * real performance (not contribution timing).
 *
 * @param dailyValues - Ascending `{date, value}` values.
 * @param flows - External flows by date (portfolio convention); omit for a
 *   benchmark close series.
 * @param base - Index base (default 100).
 * @returns Ascending `{date, value}` points where value = the running index
 *   (a 2dp string), or `[]` when there is nothing to index.
 */
export function twrIndexSeries(
  dailyValues: readonly ValueSeriesPoint[],
  flows: readonly DatedFlow[] = [],
  base = 100,
): ValueSeriesPoint[] {
  if (dailyValues.length === 0) return [];

  const flowByDate = new Map<string, Decimal>();
  for (const f of flows) {
    flowByDate.set(f.date, (flowByDate.get(f.date) ?? new Decimal(0)).plus(new Decimal(f.amount)));
  }

  const out: ValueSeriesPoint[] = [];
  let index = new Decimal(base);
  out.push({ date: dailyValues[0]?.date ?? "", value: index.toFixed(2) });
  for (let i = 1; i < dailyValues.length; i++) {
    const prev = new Decimal(dailyValues[i - 1]?.value ?? "0");
    const curr = new Decimal(dailyValues[i]?.value ?? "0");
    const flow = flowByDate.get(dailyValues[i]?.date ?? "") ?? new Decimal(0);
    const denom = prev.plus(flow);
    if (denom.greaterThan(0)) index = index.times(curr.dividedBy(denom));
    out.push({ date: dailyValues[i]?.date ?? "", value: index.toFixed(2) });
  }
  return out;
}
