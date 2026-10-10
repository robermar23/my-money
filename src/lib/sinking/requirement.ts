import { Money } from "@/lib/money/money.ts";
import { parseIsoDate } from "@/lib/schedule/occurrences.ts";
import { accrue } from "./accrual.ts";
import { SINKING_HORIZON_MONTHS } from "./constants.ts";
import type { AccruedCost, KnownFutureCost, SinkingRequirement } from "./types.ts";

/**
 * The household-level requirement (P18-14, ADR-045 §5).
 *
 * `accrue` mapped over the stream, then totalled. There is deliberately almost
 * nothing else here: the accrual identity lives in
 * [accrual.ts](./accrual.ts), the double-count gate lives in
 * [cadence.ts](./cadence.ts), and what is left for this module is the one
 * property the page's credibility rests on.
 *
 * ── The total is the sum of the rows shown beneath it ─────────────────────
 * `/plan/sinking` prints a headline figure over an itemized table, so a reader
 * who adds the column up must get the headline — PLAN17's *"a waterfall that
 * does not add up is not a waterfall"*, applied to a table. That is why both
 * totals are `Money.sum` over the **per-cost figures already computed** rather
 * than a second pass over the amounts. A tidier-looking
 * `Σamount × elapsed ÷ total` would round once instead of N times and would
 * therefore disagree with its own table by a cent or two, which costs the reader
 * exactly the confidence the itemization was supposed to buy (ADR-045 §4(a)
 * leans on that itemization to make a double-counted cost visible, so the table
 * is load-bearing rather than decorative).
 *
 * The same reasoning applies to `perMonth`, and there it is more than cosmetic:
 * the per-cost `perMonth` is a fair split that may differ from
 * `requiredToday ÷ elapsed` by a cent — [accrual.ts](./accrual.ts)'s header says
 * why — so the two household totals are **independent sums of independent
 * columns**, and neither is derived from the other.
 *
 * ── Nothing is re-sorted and nothing is re-filtered ──────────────────────
 * `buildCostStream` already decided which costs are in the horizon and in what
 * order (`(dueDate, label, sourceId)`). Re-sorting here would be a second
 * opinion about row order, and the page would show one while the rule explained
 * the other. Re-filtering would be a second horizon.
 *
 * ── Why `costCount` is counted and not `costs.length` ────────────────────
 * ADR-044 §7: a `paid` or `cancelled` cost accrues `"0.00"` and is excluded from
 * every total while staying **visible with its own status**. So the itemized
 * array can be longer than the count behind the headline. In practice
 * `buildCostStream` admits only `planned` rows and the two are equal, but
 * `costCount` drives the words *"N known costs"* printed next to a figure, and a
 * header that promises four costs behind a total built from three is the
 * itemization claim broken at the top of the page.
 *
 * Pure and I/O-free (ADR-032 §1), and nothing it computes is stored (ADR-032 §3)
 * — the requirement is relative to `today`, so a persisted copy would answer no
 * question correctly the morning after it was written.
 */

/**
 * The window the requirement is stated over, and the currency it is stated in.
 *
 * The edges are **passed in rather than derived from `today`**: they are the
 * same edges [costs.ts](./costs.ts) filtered the stream on, and the page's copy
 * ("costs due in the next 12 months") has to name the window that was actually
 * looked at. Re-deriving them here would be a second horizon that could drift
 * from the first by a day and quietly change which costs are in the total.
 *
 * `currency` rides along because a total has to be stated in *some* currency
 * even when there is nothing to total, and the empty stream is precisely the
 * case a fresh install shows. The alternative — a module-level `const CURRENCY =
 * "USD"` as [advice/snapshot.ts](../advice/snapshot.ts) carries — would hardcode
 * the assumption in the one place a non-USD household's figures pass through.
 */
export interface SinkingHorizon {
  /** Inclusive `YYYY-MM-DD` start, normally today. */
  readonly from: string;
  /** Inclusive `YYYY-MM-DD` end: 12 months out (ADR-045 §5). */
  readonly to: string;
  /** The currency the totals are stated in, from the household's snapshot. */
  readonly currency: string;
}

/**
 * Derive the horizon a sinking figure is stated over (P18-19).
 *
 * **The one derivation, shared by every caller**, and that is the whole reason
 * it is exported rather than inlined three times. The loader filters the cost
 * stream on these edges; the `sinking_fund` rule totals the stream it is handed
 * and has to name the same window; `/plan/sinking` prints it. Three copies of
 * `today + 12 months` is how a page comes to show costs the rule's own header
 * says are out of scope — and the drift would be a day wide, which is exactly
 * the size nobody notices.
 *
 * ── The leap-day clamp ────────────────────────────────────────────────────
 * The end is the same day-of-month twelve months out, **clamped to the target
 * month's real length** rather than allowed to roll forward: 2028-02-29 + 12
 * months is 2029-02-28, not 2029-03-01. The alternative lets the horizon grow
 * by a day once every four years, which would quietly pull one extra cost into
 * the total on one specific morning. Clamping matches what
 * [schedule/occurrences.ts](../schedule/occurrences.ts) already does when it
 * walks a monthly cadence onto a short month, so the two never disagree about
 * where "a month later" is.
 *
 * @param today - Inclusive `YYYY-MM-DD` start, normally the snapshot's date.
 * @param currency - The household's currency, for the totals.
 * @param months - Horizon depth. Defaults to {@link SINKING_HORIZON_MONTHS} and
 *   should be left alone outside tests: a caller that narrows the stream's
 *   window while the rule still derives twelve months would state a total over
 *   one window beneath a sentence naming another.
 * @returns The inclusive window and its currency.
 * @throws If `today` is not a real calendar date — through the one shipped
 *   parser, so this module still writes no date validation of its own.
 */
export function sinkingHorizon(
  today: string,
  currency: string,
  months: number = SINKING_HORIZON_MONTHS,
): SinkingHorizon {
  return { from: today, to: sinkingHorizonEnd(today, months), currency };
}

/**
 * The horizon's inclusive far edge, without a currency.
 *
 * Split out for the one caller that has no business naming a currency: the
 * loader ([sinking/queries.ts](./queries.ts)) needs this date to bound two
 * queries and never totals anything, so requiring a currency there would mean
 * hardcoding `"USD"` in a server module — the module-level constant
 * {@link sinkingHorizon}'s header declines. Same arithmetic, one derivation.
 *
 * @param today - Inclusive `YYYY-MM-DD` start.
 * @param months - Horizon depth. Defaults to {@link SINKING_HORIZON_MONTHS}.
 * @returns The inclusive end date, day-of-month clamped — see above.
 * @throws If `today` is not a real calendar date.
 */
export function sinkingHorizonEnd(today: string, months: number = SINKING_HORIZON_MONTHS): string {
  parseIsoDate(today, "today");
  const year = Number(today.slice(0, 4));
  const monthIndex = Number(today.slice(5, 7)) - 1;
  const day = Number(today.slice(8, 10));

  // Day 0 of the following month is the last day of this one (UTC, no TZ
  // drift) — the repository's existing idiom for "how long is this month".
  const endMonth = new Date(Date.UTC(year, monthIndex + months, 1));
  const endYear = endMonth.getUTCFullYear();
  const endMonthIndex = endMonth.getUTCMonth();
  const lastDay = new Date(Date.UTC(endYear, endMonthIndex + 1, 0)).getUTCDate();
  const pad = (value: number): string => String(value).padStart(2, "0");

  return `${endYear}-${pad(endMonthIndex + 1)}-${pad(Math.min(day, lastDay))}`;
}

/**
 * Resolve the whole stream into one requirement.
 *
 * @param costs - The cost stream, already filtered and ordered by
 *   {@link ../sinking/costs.ts buildCostStream}. Never mutated.
 * @param today - Inclusive `YYYY-MM-DD` evaluation date, passed in rather than
 *   read from the clock so the figure is deterministic and testable.
 * @param horizon - The window the stream was built over, and the currency to
 *   state the totals in.
 * @returns The itemized accruals and their totals.
 * @throws If any date is not a real calendar date, or if a cost is denominated
 *   in a currency other than `horizon.currency` — cross-currency arithmetic has
 *   to go through `fx_rates` (CLAUDE.md §Money) and this phase has no rate
 *   lookup, so `Money.sum` is left to reject the mixture rather than silently
 *   adding magnitudes and reporting €1,000 + $1,000 as $2,000. Loud beats wrong:
 *   the fix, if a household ever needs it, is a conversion in the loader, not a
 *   relabelled string here.
 */
export function sinkingRequirement(
  costs: readonly KnownFutureCost[],
  today: string,
  horizon: SinkingHorizon,
): SinkingRequirement {
  const accrued: AccruedCost[] = costs.map((cost) => accrue(cost, today));

  // Each figure is parsed in the COST's own currency, not the horizon's, so a
  // stray EUR row reaches `Money.sum` as EUR and trips its currency check
  // instead of being quietly relabelled as dollars by the parse.
  const requiredToday = Money.sum(
    accrued.map((a) => Money.fromString(a.requiredToday, a.cost.currency)),
    horizon.currency,
  );
  const perMonth = Money.sum(
    accrued.map((a) => Money.fromString(a.perMonth, a.cost.currency)),
    horizon.currency,
  );

  return {
    horizonFrom: horizon.from,
    horizonTo: horizon.to,
    costs: accrued,
    requiredToday: requiredToday.toString(),
    perMonth: perMonth.toString(),
    costCount: accrued.filter((a) => a.cost.status === "planned").length,
    pastDueCount: accrued.filter((a) => a.pastDue).length,
  };
}
