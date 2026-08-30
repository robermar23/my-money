import { Money } from "@/lib/money/money.ts";

/**
 * The attribution anchor (P17-06, ADR-039 §1).
 *
 * Two `computeNetWorth` results — one at the range start, one at the range end —
 * reduced to the shape every rung reads from. Pure and I/O-free; the two calls
 * themselves belong to the loader (P17-19).
 *
 * ── The endpoints are given; the rungs are the hypothesis ───────────────────
 * `opening`, `closing` and therefore `delta` are **facts** produced by the same
 * function that draws the dashboard chart, and whose agreement with
 * `netWorthSeries` is already proven by
 * [series-parity.test.ts](./series-parity.test.ts). The five explained rungs are
 * a *claim* about what caused that delta, and `unexplained` is how wrong the
 * claim is. Everything downstream depends on keeping those two categories
 * apart: a waterfall that starts and ends anywhere other than the dashboard's
 * own number makes the app contradict itself, and the household has no way to
 * know which figure to believe.
 *
 * That is why {@link endpointsFor} copies both totals **verbatim** and never
 * re-sums `items`. `computeNetWorth` sums only the items whose currency matches
 * the base currency, so `total` is deliberately not `Σ items`; re-deriving it
 * here would produce a second valuation path — the one thing ADR-039 §1 forbids.
 *
 * ── Per-account deltas are derived once ────────────────────────────────────
 * Every rung that needs a balance change reads it from {@link
 * AttributionEndpoints.byAccount} rather than issuing its own query. Two rungs
 * disagreeing about what an account was worth would be invisible in the total —
 * the identity would still reconcile — which is exactly the class of bug this
 * phase is built to detect rather than commit.
 *
 * ── Asymmetry is recorded, not smoothed over ───────────────────────────────
 * An account present at only one endpoint gets `"0.00"` for the missing side,
 * which is arithmetically right (the app valued it at nothing then) and
 * narratively misleading (a house first entered mid-window did not appreciate by
 * its whole value). Both are true, so the entry is counted *and* listed in
 * {@link AttributionEndpoints.asymmetric} for the residual diagnostics to name.
 */

const CURRENCY = "USD";

/** One account's contribution at one endpoint — a subset of `computeNetWorth`'s item. */
export interface EndpointItem {
  readonly accountId: string;
  readonly accountName: string;
  readonly accountType: string;
  readonly currency: string;
  /** Signed money string. Liabilities are already negative here. */
  readonly balance: string;
}

/**
 * One `computeNetWorth` result, flattened to strings.
 *
 * A structural subset rather than the real `NetWorthBreakdown`, so this module
 * never imports the `server-only` compute path and stays trivially testable —
 * the `ValuedSnapshot` precedent from
 * [investments/performance.ts](../investments/performance.ts).
 */
export interface EndpointBreakdown {
  /** The as-of instant, `YYYY-MM-DD`. */
  readonly asOf: string;
  /** The authoritative total. Copied through untouched. */
  readonly total: string;
  readonly items: readonly EndpointItem[];
}

/**
 * Whether both endpoints observed the account.
 *
 * `'opened'` = absent at the start, present at the end. `'closed'` = the
 * reverse. Both mean one side of the delta is an assumption rather than a
 * measurement.
 */
export type AccountPresence = "both" | "opened" | "closed";

/** One account's change across the window. */
export interface AccountEndpoint {
  readonly accountId: string;
  readonly accountName: string;
  readonly accountType: string;
  readonly opening: string;
  readonly closing: string;
  /** `closing − opening`. Signed; never clamped. */
  readonly delta: string;
  readonly presence: AccountPresence;
}

/** The anchored window every rung is computed against. */
export interface AttributionEndpoints {
  /** Inclusive window start, `YYYY-MM-DD`. */
  readonly from: string;
  /** Inclusive window end, `YYYY-MM-DD`. */
  readonly to: string;
  /** Net worth at `from`, verbatim from `computeNetWorth`. */
  readonly opening: string;
  /** Net worth at `to`, verbatim from `computeNetWorth`. */
  readonly closing: string;
  /** `closing − opening`. The figure the five rungs must add up to. */
  readonly delta: string;
  readonly byAccount: ReadonlyMap<string, AccountEndpoint>;
  /** Accounts observed at only one endpoint, ascending by id. */
  readonly asymmetric: readonly AccountEndpoint[];
}

/**
 * Reduce two `computeNetWorth` results to the attribution anchor.
 *
 * @param opening - The breakdown at the window start.
 * @param closing - The breakdown at the window end.
 * @param currency - Currency to compute deltas in. Single-currency app; USD.
 * @returns The anchored window plus a per-account delta for every account seen
 *   at either endpoint. Inputs are never mutated.
 * @throws If the window runs backwards. Silently mirroring it would report every
 *   rung with its sign inverted while the identity still reconciled — a
 *   perfectly self-consistent lie.
 */
export function endpointsFor(
  opening: EndpointBreakdown,
  closing: EndpointBreakdown,
  currency: string = CURRENCY,
): AttributionEndpoints {
  if (opening.asOf > closing.asOf) {
    throw new Error(
      `endpointsFor: window runs backwards (${opening.asOf} → ${closing.asOf}). The opening endpoint must be on or before the closing endpoint.`,
    );
  }

  const openingById = new Map(opening.items.map((i) => [i.accountId, i]));
  const closingById = new Map(closing.items.map((i) => [i.accountId, i]));

  const byAccount = new Map<string, AccountEndpoint>();
  for (const accountId of [...openingById.keys(), ...closingById.keys()]) {
    if (byAccount.has(accountId)) continue;
    const before = openingById.get(accountId);
    const after = closingById.get(accountId);
    // The closing endpoint wins for name and type: a renamed or re-typed
    // account should read the way the household sees it today.
    const identity = after ?? before;
    if (identity === undefined) continue;

    const openingBalance = Money.fromString(before?.balance ?? "0.00", currency);
    const closingBalance = Money.fromString(after?.balance ?? "0.00", currency);
    byAccount.set(accountId, {
      accountId,
      accountName: identity.accountName,
      accountType: identity.accountType,
      opening: openingBalance.toString(),
      closing: closingBalance.toString(),
      delta: closingBalance.sub(openingBalance).toString(),
      presence: before === undefined ? "opened" : after === undefined ? "closed" : "both",
    });
  }

  const openingTotal = Money.fromString(opening.total, currency);
  const closingTotal = Money.fromString(closing.total, currency);

  return {
    from: opening.asOf,
    to: closing.asOf,
    opening: openingTotal.toString(),
    closing: closingTotal.toString(),
    delta: closingTotal.sub(openingTotal).toString(),
    byAccount,
    asymmetric: [...byAccount.values()].filter((e) => e.presence !== "both").sort(byAccountId),
  };
}

/**
 * The endpoint entries whose account type is in `types`, ascending by id.
 *
 * One implementation, because two rungs partition on account type — revaluation
 * on `property`/`personal_asset` (ADR-041 §5) and market return on
 * `investment`/`crypto_ira` (ADR-041 §4) — and a type quietly landing in both
 * sets, or neither, would move real money between rungs while the total still
 * reconciled.
 *
 * @param byAccount - The per-account map from {@link endpointsFor}.
 * @param types - Account types to select.
 * @returns Matching entries in a deterministic order.
 */
export function endpointsOfType(
  byAccount: ReadonlyMap<string, AccountEndpoint>,
  types: readonly string[],
): AccountEndpoint[] {
  const wanted = new Set(types);
  return [...byAccount.values()].filter((e) => wanted.has(e.accountType)).sort(byAccountId);
}

/**
 * Whether a `YYYY-MM-DD` date falls in the inclusive window `[from, to]`.
 *
 * Inclusive at both ends, matching `resolveRange` and every other window in the
 * app. Exported so the rungs that filter rows by date — the retirement rung and
 * the market rung — use the **same** predicate: ADR-041 §3's cancellation only
 * holds if the flows one rung re-adds are exactly the flows the other removed,
 * and two slightly different window checks is precisely how that would stop
 * being true.
 *
 * String comparison is safe and exact on zero-padded ISO dates; parsing to a
 * `Date` would add a timezone hazard for no benefit.
 */
export function withinWindow(date: string, from: string, to: string): boolean {
  return date >= from && date <= to;
}

/**
 * Reject a backwards window.
 *
 * Shared by every rung that takes `from`/`to` so the failure is identical
 * everywhere and no rung silently computes over an inverted range.
 *
 * @throws If `from` is after `to`.
 */
export function assertWindow(from: string, to: string, fnName: string): void {
  if (from > to) {
    throw new Error(`${fnName}: window runs backwards (${from} → ${to}).`);
  }
}

function byAccountId(a: AccountEndpoint, b: AccountEndpoint): number {
  if (a.accountId === b.accountId) return 0;
  return a.accountId < b.accountId ? -1 : 1;
}
