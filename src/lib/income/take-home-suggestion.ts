import type { IncomeCadence } from "@/db/schema/income-sources.ts";
import { medianMoney } from "@/lib/advice/statistics.ts";
import { normalizePayee } from "@/lib/importers/normalize.ts";
import { Money } from "@/lib/money/money.ts";
import { parseIsoDate } from "@/lib/schedule/occurrences.ts";
import { payDatesBetween } from "./schedule.ts";

/**
 * Suggest a source's take-home per paycheck from deposits that already landed
 * (ADR-049 §2).
 *
 * `income_sources.net_per_period` is a figure the household STATES; this module
 * only proposes one. It never writes, and the form shows every candidate with
 * its payee and hit count so the user confirms a deposit stream rather than
 * accepting a number.
 *
 * ── How a deposit stream is matched to a schedule ──────────────────────────
 *   1. Deposits are grouped by {@link normalizePayee}, then split by amount: two
 *      payments from one payer on one day (two SSA benefits, a paycheck split
 *      across two accounts) are two streams, not one blended median.
 *   2. Each payday the source's own cadence produces is paired with the closest
 *      unused deposit of the stream within {@link TOLERANCE_DAYS} — paydays on a
 *      weekend or holiday post a day or three early.
 *   3. A stream is a candidate only if it covers at least half the paydays AND
 *      most of its deposits landed on a payday. The second test is what stops a
 *      weekly deposit from passing for a monthly paycheck.
 *
 * ── Ranking ────────────────────────────────────────────────────────────────
 * Coverage first. Ties — the common case when two sources share a payday — are
 * broken by distance from the source's gross. That is an ORDERING hint between
 * real deposit streams, never an amount: the suggested figure is always the
 * median of observed deposits, so ADR-038 §3's ban on projecting gross holds.
 *
 * Pure and I/O-free; the deposits arrive from `listIncomeDeposits`.
 */

const CURRENCY = "USD";

/** How far a deposit may land from its payday and still count as that payday. */
export const TOLERANCE_DAYS = 3;
/** How far back deposits are read. Six months is long enough for every cadence. */
export const LOOKBACK_DAYS = 180;
/** How many of the most recent matched deposits the suggested median covers. */
const RECENT_MATCHES = 6;
/** Two amounts more than this ratio apart are different streams. */
const SAME_STREAM_RATIO = "1.25";
const MIN_COVERAGE = 0.5;
const MIN_PRECISION = 0.75;
const MAX_CANDIDATES = 3;
const DAY_MS = 86_400_000;

/** A positive deposit in an income category. */
export interface IncomeDeposit {
  readonly postedAt: string;
  /** Positive magnitude, a `numeric(18,2)` string. */
  readonly amount: string;
  readonly name: string;
}

/** The schedule fields the match reads. */
export interface SuggestionSchedule {
  readonly cadence: IncomeCadence;
  readonly anchorDate: string;
  readonly startDate: string;
  readonly endDate: string | null;
  /** Ranking hint only — see the module header. Blank or absent is fine. */
  readonly grossPerPeriod?: string | null;
}

/** One deposit stream that lines up with the schedule. */
export interface TakeHomeCandidate {
  /** Normalized payee the stream was grouped by. */
  readonly payee: string;
  /** Median of the most recent matched deposits — the suggested take-home. */
  readonly amount: string;
  readonly latestAmount: string;
  readonly latestDate: string;
  readonly matchedPaydays: number;
  readonly expectedPaydays: number;
}

/**
 * Propose take-home candidates for one schedule.
 *
 * @param schedule - The source's cadence, anchor and lifespan.
 * @param deposits - Positive income deposits, any order.
 * @param today - `YYYY-MM-DD`; paydays after it are not expected yet.
 * @returns Up to three candidates, best first. Empty when no stream lines up
 *   or the source has had no payday inside the lookback window.
 * @throws If a schedule date is not a real `YYYY-MM-DD` date.
 */
export function suggestTakeHome(
  schedule: SuggestionSchedule,
  deposits: readonly IncomeDeposit[],
  today: string,
): TakeHomeCandidate[] {
  const lookback = shiftIso(today, -LOOKBACK_DAYS);
  const from = schedule.startDate > lookback ? schedule.startDate : lookback;
  const to = schedule.endDate !== null && schedule.endDate < today ? schedule.endDate : today;
  if (from > to) return [];

  const paydays = payDatesBetween(schedule.cadence, schedule.anchorDate, from, to);
  if (paydays.length === 0) return [];

  const lo = shiftIso(from, -TOLERANCE_DAYS);
  const hi = shiftIso(to, TOLERANCE_DAYS);
  const inWindow = deposits.filter((d) => {
    if (d.postedAt < lo || d.postedAt > hi) return false;
    const amount = Money.fromString(d.amount, CURRENCY);
    return !amount.isNegative() && !amount.isZero();
  });

  const candidates: TakeHomeCandidate[] = [];
  for (const [payee, stream] of streams(inWindow)) {
    const candidate = matchStream(payee, stream, paydays);
    if (candidate !== null) candidates.push(candidate);
  }
  return candidates.sort(byRank(schedule.grossPerPeriod ?? null)).slice(0, MAX_CANDIDATES);
}

/** Group by payee, then split each payee's deposits into amount bands. */
function streams(deposits: readonly IncomeDeposit[]): [string, IncomeDeposit[]][] {
  const byPayee = new Map<string, IncomeDeposit[]>();
  for (const deposit of deposits) {
    const key = normalizePayee(deposit.name);
    const list = byPayee.get(key) ?? [];
    list.push(deposit);
    byPayee.set(key, list);
  }

  const out: [string, IncomeDeposit[]][] = [];
  for (const [payee, list] of byPayee) {
    const sorted = [...list].sort((a, b) =>
      Money.fromString(a.amount, CURRENCY).compare(Money.fromString(b.amount, CURRENCY)),
    );
    let band: IncomeDeposit[] = [];
    let ceiling: Money | null = null;
    for (const deposit of sorted) {
      const amount = Money.fromString(deposit.amount, CURRENCY);
      if (ceiling !== null && amount.compare(ceiling) > 0) {
        out.push([payee, band]);
        band = [];
        ceiling = null;
      }
      if (ceiling === null) ceiling = amount.mul(SAME_STREAM_RATIO);
      band.push(deposit);
    }
    if (band.length > 0) out.push([payee, band]);
  }
  return out;
}

/** Pair paydays with a stream's deposits; `null` when the stream does not fit. */
function matchStream(
  payee: string,
  stream: readonly IncomeDeposit[],
  paydays: readonly string[],
): TakeHomeCandidate | null {
  const used = new Set<number>();
  const matched: IncomeDeposit[] = [];
  for (const payday of paydays) {
    const payMs = parseIsoDate(payday, "payday");
    let best = -1;
    let bestGap = Number.POSITIVE_INFINITY;
    for (let i = 0; i < stream.length; i++) {
      if (used.has(i)) continue;
      const deposit = stream[i] as IncomeDeposit;
      const gap = Math.abs(parseIsoDate(deposit.postedAt, "postedAt") - payMs) / DAY_MS;
      if (gap <= TOLERANCE_DAYS && gap < bestGap) {
        best = i;
        bestGap = gap;
      }
    }
    if (best >= 0) {
      used.add(best);
      matched.push(stream[best] as IncomeDeposit);
    }
  }

  const needed = Math.min(2, paydays.length);
  if (matched.length < needed) return null;
  if (matched.length / paydays.length < MIN_COVERAGE) return null;
  if (matched.length / stream.length < MIN_PRECISION) return null;

  const byDate = [...matched].sort((a, b) => (a.postedAt < b.postedAt ? -1 : 1));
  const recent = byDate.slice(-RECENT_MATCHES);
  const latest = byDate[byDate.length - 1] as IncomeDeposit;
  return {
    payee,
    amount: medianMoney(recent.map((d) => d.amount)) ?? latest.amount,
    latestAmount: Money.fromString(latest.amount, CURRENCY).toString(),
    latestDate: latest.postedAt,
    matchedPaydays: matched.length,
    expectedPaydays: paydays.length,
  };
}

/** Coverage, then closeness to gross (a hint only), then hits, then payee. */
function byRank(gross: string | null) {
  const hint = gross !== null && gross.trim() !== "" ? Money.fromString(gross, CURRENCY) : null;
  return (a: TakeHomeCandidate, b: TakeHomeCandidate): number => {
    const coverage = b.matchedPaydays * a.expectedPaydays - a.matchedPaydays * b.expectedPaydays;
    if (coverage !== 0) return coverage;
    if (hint !== null) {
      const gapA = Money.fromString(a.amount, CURRENCY).sub(hint).abs();
      const gapB = Money.fromString(b.amount, CURRENCY).sub(hint).abs();
      const closeness = gapA.compare(gapB);
      if (closeness !== 0) return closeness;
    }
    if (a.matchedPaydays !== b.matchedPaydays) return b.matchedPaydays - a.matchedPaydays;
    return a.payee < b.payee ? -1 : a.payee > b.payee ? 1 : 0;
  };
}

/** `iso` shifted by whole days, as `YYYY-MM-DD`. */
function shiftIso(iso: string, days: number): string {
  return new Date(parseIsoDate(iso, "date") + days * DAY_MS).toISOString().slice(0, 10);
}
