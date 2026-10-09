import { periodsPerYear } from "@/lib/income/schedule.ts";
import { Money } from "@/lib/money/money.ts";

/**
 * What each payday lands in operating cash (ADR-038 §3 as amended by ADR-049 §1).
 *
 * Two kinds of figure, in strict precedence:
 *
 *   1. **Stated** — `income_sources.net_per_period`, the take-home the household
 *      entered (usually by accepting a deposit-based suggestion). Projected
 *      exactly, on that source's own paydays.
 *   2. **Shared** — every source WITHOUT a stated figure splits what is left of
 *      `observedNetIncome`'s monthly median, annualized, after the stated
 *      sources' annual take-home is removed, evenly per pay event. This is the
 *      pre-ADR-049 behaviour, now applied only to the remainder: one household
 *      median carries no per-source information, so an even split is the only
 *      honest division of it.
 *
 * Before ADR-049 the even split covered every source, and a household with
 * unequal paychecks (two SSA benefits and a salary) saw the same figure on
 * every payday — overstating one benefit by more than half.
 *
 * When stated figures already account for the whole median (or more), the
 * remainder is not positive and unstated sources get NO events. Erring low on
 * an inflow is the safe direction, and each is named as unpriced.
 *
 * `divFloor`, as before: a rate multiplied back by its divisor must not round up.
 * Gross is not an input here, by construction — the parameter type omits it.
 */

const CURRENCY = "USD";

/** The four income cadences, via the allowlisted schedule module (P16-36). */
type IncomeCadence = Parameters<typeof periodsPerYear>[0];

/** A source as the split reads it. */
export interface TakeHomeSource {
  readonly id: string;
  readonly cadence: IncomeCadence;
  /** Stated take-home per period, or `null`. */
  readonly netPerPeriod: string | null;
}

/** The split, plus what the inputs panel reports about it. */
export interface TakeHomeSplit {
  /** Source id → per-period take-home. Absent = not projected. */
  readonly perPeriod: ReadonlyMap<string, string>;
  /** Sources with a stated figure. */
  readonly stated: number;
  /** Unstated sources priced from the shared remainder. */
  readonly shared: number;
  /** Unstated sources left unpriced (no median, or nothing left of it). */
  readonly unpriced: number;
}

/**
 * Price every active source's paycheck.
 *
 * @param sources - Active income sources.
 * @param monthlyMedian - `observedNetIncome`'s trailing median, or `null`.
 * @returns Per-source amounts and the counts behind them.
 */
export function splitTakeHome(
  sources: readonly TakeHomeSource[],
  monthlyMedian: string | null,
): TakeHomeSplit {
  const perPeriod = new Map<string, string>();
  const unstated: TakeHomeSource[] = [];
  let statedAnnual = Money.zero(CURRENCY);

  for (const source of sources) {
    if (source.netPerPeriod === null) {
      unstated.push(source);
      continue;
    }
    const net = Money.fromString(source.netPerPeriod, CURRENCY);
    perPeriod.set(source.id, net.toString());
    statedAnnual = statedAnnual.add(net.mul(periodsPerYear(source.cadence)));
  }
  const stated = sources.length - unstated.length;

  const remainder = sharedAnnual(monthlyMedian, statedAnnual);
  let eventsPerYear = 0;
  for (const source of unstated) eventsPerYear += periodsPerYear(source.cadence);
  if (remainder === null || eventsPerYear === 0) {
    return { perPeriod, stated, shared: 0, unpriced: unstated.length };
  }

  const perEvent = remainder.divFloor(eventsPerYear).toString();
  for (const source of unstated) perPeriod.set(source.id, perEvent);
  return { perPeriod, stated, shared: unstated.length, unpriced: 0 };
}

/** Annual observed take-home left for unstated sources, or `null` if none. */
function sharedAnnual(monthlyMedian: string | null, statedAnnual: Money): Money | null {
  if (monthlyMedian === null) return null;
  const left = Money.fromString(monthlyMedian, CURRENCY).mul(12).sub(statedAnnual);
  return left.isNegative() || left.isZero() ? null : left;
}
