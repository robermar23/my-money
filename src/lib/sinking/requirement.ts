import { Money } from "@/lib/money/money.ts";
import { accrue } from "./accrual.ts";
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
