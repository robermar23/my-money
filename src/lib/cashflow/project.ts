import { Money } from "@/lib/money/money.ts";
import { parseIsoDate } from "@/lib/schedule/occurrences.ts";
import type { ResidualRate } from "./residual.ts";
import { safeToSpend } from "./safe-to-spend.ts";
import type {
  CashFlowEvent,
  DailyProjectionPoint,
  DatedCashFlowEvent,
  DiscretionaryEvent,
  InputUsed,
  LowWaterMark,
  ProjectionResult,
  ProjectionStatus,
} from "./types.ts";

/**
 * The daily balance walk (P16-17, ADR-038).
 *
 * Pure and I/O-free. One day at a time from `from` to `to`: apply the day's
 * inflows, apply its outflows plus one day of the residual rate, and carry the
 * closing balance into the next day's opening.
 *
 * ── Money discipline is load-bearing here, not ceremonial ──────────────────
 * This is **the longest sequential money-arithmetic chain in the codebase** —
 * longer than PLAN15's payoff simulator (CLAUDE.md §Money, ADR-038). A float
 * would not merely round: subtracting an unrepresentable daily rate 365 times
 * drifts MONOTONICALLY, always in the same direction, into a number that still
 * looks like money and that the household makes a spending decision on. Every
 * value in this file is a `numeric` string moved through {@link Money}. There is
 * no `Number()` anywhere in the walk, and `project.test.ts` proves the float
 * version really does disagree.
 *
 * ── Why the residual is an EVENT ───────────────────────────────────────────
 * The daily rate could have been subtracted invisibly inside the loop. It is
 * emitted as a {@link DiscretionaryEvent} instead, so a day's `events[]`
 * accounts for its own `inflow`/`outflow` exactly. A user who adds up a day and
 * gets a different total has found a bug and should be able to; a projection
 * whose arithmetic is not visible on the surface is the kind a household stops
 * believing. The event is omitted when the rate is zero, because a "$0.00
 * everyday spending" row on all 365 days buries the real ones.
 *
 * ── Why `events` cannot contain a discretionary event ──────────────────────
 * The input type accepts {@link DatedCashFlowEvent} — the full
 * {@link CashFlowEvent} union MINUS the discretionary member. The residual is
 * the walk's own contribution; a caller that could also pass one would be able
 * to double-count discretionary spend, which is the very defect ADR-038 §2
 * exists to prevent, reintroduced by a different door. The compiler closes that
 * door.
 *
 * P18-28 widened this from a hand-listed `IncomeEvent | ObligationEvent` for a
 * reason worth keeping: a hand-listed pair meant the fourth event kind
 * type-checked everywhere, reached the walk nowhere, and silently went missing
 * from the projection — which is precisely the overstatement ADR-038 §3 calls
 * the dangerous direction. Subtracting the one excluded kind states the actual
 * rule, so a fifth kind is admitted by default and only the residual is named.
 *
 * ── Why `coverage` is read off the residual ────────────────────────────────
 * The result reports `input.residual.coverage` rather than taking coverage as a
 * separate parameter. A projection whose stated coverage disagreed with the rate
 * it actually walked would be an audit trail that lies, and a second field is
 * how that happens. Structurally impossible is better than carefully maintained.
 *
 * ── What this function does NOT decide ─────────────────────────────────────
 * The horizon, the floor, the status and the audit trail are inputs and are
 * echoed unchanged. Assembling them is [loader.ts](./loader.ts)'s job (P16-30);
 * deciding the status is [status.ts](./status.ts)'s (P16-19). The walk stays a
 * walk.
 */

const CURRENCY = "USD";
const MS_PER_DAY = 86_400_000;

/** Label on the residual event. Exported so the UI and its tests agree on it. */
export const DISCRETIONARY_LABEL = "Everyday spending";

/** Everything the walk needs, and nothing it merely passes through untouched. */
export interface ProjectionInput {
  /** Inclusive horizon start, `YYYY-MM-DD`. Day zero opens on `openingBalance`. */
  readonly from: string;
  /** Inclusive horizon end, `YYYY-MM-DD`. */
  readonly to: string;
  /**
   * Operating cash at the close of the day before `from`. Signed: a household
   * can start a horizon overdrawn, and pretending otherwise would hide it.
   */
  readonly openingBalance: string;
  /**
   * Dated income, obligation and planned-expense events, in any order. Events
   * outside the horizon are ignored. See the header on why discretionary events
   * are not accepted here.
   */
  readonly events: readonly DatedCashFlowEvent[];
  /** The residual rate and its coverage, from {@link residualDailyRate}. */
  readonly residual: ResidualRate;
  /** The household's stated buffer. Echoed, and subtracted by safe-to-spend. */
  readonly cashFloor: string;
  /** The honesty level, from {@link import("./status.ts").projectionStatus}. */
  readonly status: ProjectionStatus;
  /** The audit trail (ADR-038 §8). Echoed unchanged. */
  readonly inputsUsed: readonly InputUsed[];
}

/** Bucket events by `YYYY-MM-DD`, preserving the caller's order within a day. */
function groupByDate(events: readonly DatedCashFlowEvent[]): Map<string, DatedCashFlowEvent[]> {
  const byDate = new Map<string, DatedCashFlowEvent[]>();
  for (const event of events) {
    const bucket = byDate.get(event.date);
    if (bucket === undefined) {
      byDate.set(event.date, [event]);
    } else {
      bucket.push(event);
    }
  }
  return byDate;
}

/**
 * Walk a horizon one day at a time and produce the projection.
 *
 * @param input - The horizon, the opening balance, the dated events, the
 *   residual rate, and the figures to echo.
 * @returns Points for every day inclusive, the low-water mark, safe-to-spend,
 *   and the echoed horizon/floor/coverage/status/audit trail.
 * @throws If the horizon is inverted, a date is not a real `YYYY-MM-DD`, or the
 *   residual rate is negative. An inverted horizon returning an empty
 *   projection would report safe-to-spend zero, which reads to a user as a
 *   shortfall rather than as the caller bug it is.
 */
export function projectDailyBalance(input: ProjectionInput): ProjectionResult {
  const fromMs = parseIsoDate(input.from, "from");
  const toMs = parseIsoDate(input.to, "to");
  if (fromMs > toMs) {
    throw new Error(`projectDailyBalance: horizon is inverted (${input.from} → ${input.to})`);
  }

  const dailyRate = Money.fromString(input.residual.dailyRate, CURRENCY);
  if (dailyRate.isNegative()) {
    throw new Error("projectDailyBalance: residual daily rate must be non-negative");
  }
  const hasResidual = !dailyRate.isZero();

  const byDate = groupByDate(input.events);
  const points: DailyProjectionPoint[] = [];
  let balance = Money.fromString(input.openingBalance, CURRENCY);
  let lowWaterMark: LowWaterMark | null = null;

  for (let cursor = fromMs; cursor <= toMs; cursor += MS_PER_DAY) {
    const date = new Date(cursor).toISOString().slice(0, 10);
    const opening = balance;

    const events: CashFlowEvent[] = [...(byDate.get(date) ?? [])];
    if (hasResidual) {
      const residualEvent: DiscretionaryEvent = {
        kind: "discretionary",
        date,
        amount: dailyRate.toString(),
        direction: "outflow",
        label: DISCRETIONARY_LABEL,
      };
      events.push(residualEvent);
    }

    let inflow = Money.zero(CURRENCY);
    let outflow = Money.zero(CURRENCY);
    for (const event of events) {
      const amount = Money.fromString(event.amount, CURRENCY);
      if (event.direction === "inflow") {
        inflow = inflow.add(amount);
      } else {
        outflow = outflow.add(amount);
      }
    }

    balance = opening.add(inflow).sub(outflow);

    points.push({
      date,
      opening: opening.toString(),
      inflow: inflow.toString(),
      outflow: outflow.toString(),
      closing: balance.toString(),
      events,
    });

    // STRICTLY less-than: on a repeated minimum the EARLIEST date wins, because
    // the family needs to know when it first gets tight, not the last day it
    // stays tight. A `<=` here would report a later date and read as a
    // different, less urgent problem.
    if (
      lowWaterMark === null ||
      balance.compare(Money.fromString(lowWaterMark.balance, CURRENCY)) < 0
    ) {
      lowWaterMark = { date, balance: balance.toString() };
    }
  }

  return {
    points,
    lowWaterMark,
    safeToSpend: safeToSpend({ lowWaterMark }, input.cashFloor),
    horizonDays: points.length,
    cashFloor: Money.fromString(input.cashFloor, CURRENCY).toString(),
    coverage: input.residual.coverage,
    status: input.status,
    inputsUsed: input.inputsUsed,
  };
}
