import {
  type DatedFlow,
  type FlowTxn as InvestmentTxnFields,
  attribution,
  externalFlow,
} from "@/lib/investments/performance.ts";
import { Money } from "@/lib/money/money.ts";
import { type AccountEndpoint, assertWindow, endpointsOfType, withinWindow } from "./endpoints.ts";

/**
 * The market rung (P17-10, ADR-041 §4).
 *
 * Pure. For every `investment` and `crypto_ira` account: call the **shipped**
 * `attribution()` with the endpoint values from P17-06 and the flows
 * `externalFlow()` classifies, then sum `marketGrowth`.
 *
 * ── This module contains no return math, and that is the specification ─────
 * Phase 9 already answers "contributions versus market growth" — correctly,
 * with `Money`, and under test. This phase lifts that answer from *the
 * brokerage* to *the household* by iterating accounts. If a line of return
 * arithmetic ever appears below, `attribution()` is being reimplemented and the
 * task has gone wrong: two implementations of `marketGrowth` is how the
 * investments page and the attribution page end up disagreeing about the same
 * quarter, with no way for the user to tell which is right.
 *
 * The only arithmetic here is `Money.sum` over per-account results, which is
 * aggregation, not attribution.
 *
 * ── Dividends stay inside market growth ────────────────────────────────────
 * `externalFlow()` returns `null` for dividends, interest and fees — money
 * earned on or spent from capital already inside the portfolio — so their effect
 * lands in `marketGrowth`. That is the right household reading (*"the portfolio
 * produced this"*) and it is the convention Phase 9 already ships; changing it
 * here would make two surfaces disagree.
 *
 * ── Why this rung windows its own rows ─────────────────────────────────────
 * ADR-041 §3's cancellation only holds if the flows this rung subtracts are
 * exactly the flows {@link payrollDirectContributions} re-adds. Leaving the
 * windowing to the caller would make that guarantee depend on the loader
 * filtering identically for both, forever. Both rungs therefore call the same
 * {@link withinWindow} predicate on the same `[from, to]`, and the correspondence
 * is a property of this code rather than of its callers.
 *
 * This is a deliberate refinement of PLAN17's sketched
 * `investmentReturn(accounts, byAccount, flows)` signature: the window is added
 * for the reason above, and the separate `accounts` list is dropped because
 * `byAccount` already carries each account's type — a second source of truth for
 * the same fact is exactly how an account ends up in one rung and not the other.
 */

const CURRENCY = "USD";

/**
 * Account types whose value moves with a market.
 *
 * A closed `const` tuple for the same reason {@link REVALUED_ACCOUNT_TYPES} is:
 * a new member of `accountTypeEnum` must be assigned to a rung deliberately.
 */
export const MARKET_ACCOUNT_TYPES = ["investment", "crypto_ira"] as const;

/**
 * An `investment_transactions` row, with the account it belongs to.
 *
 * Extends performance.ts's own flow-classifier input (`{type, subtype, amount,
 * date}`) rather than restating it, so the fields `externalFlow()` reads can
 * only ever be described in one place. Note the field is `date`, not
 * `tradeDate` — the loader maps `trade_date` onto it, matching the shape Phase 9
 * settled on.
 *
 * The alias on the import is deliberate: `FlowTxn` in this directory is the
 * *cash*-transaction shape from [flow-types.ts](./flow-types.ts), and the two
 * must never be confused.
 */
export interface AccountInvestmentTxn extends InvestmentTxnFields {
  readonly accountId: string;
}

/** One account's split of value change into flows versus market. */
export interface AccountReturn {
  readonly accountId: string;
  readonly accountName: string;
  readonly accountType: string;
  readonly startValue: string;
  readonly endValue: string;
  /** Σ external flows; positive = net contributed in. */
  readonly netFlows: string;
  /** `(end − start) − netFlows`, straight from `attribution()`. */
  readonly marketGrowth: string;
}

export interface InvestmentReturnResult {
  /** Σ `marketGrowth` across every market account. The rung. */
  readonly marketGrowth: string;
  /** Σ `netFlows`. Not a rung — reported so the audit trail can show the split. */
  readonly netFlows: string;
  /** Per-account detail, ascending by id, for the ADR-039 §5 audit trail. */
  readonly byAccount: readonly AccountReturn[];
}

/**
 * Market growth across every investment and crypto-IRA account.
 *
 * @param byAccount - The per-account map from `endpointsFor` (P17-06).
 * @param txns - Investment transactions to consider. Rows outside the window,
 *   on non-market accounts, or on accounts absent from `byAccount` are ignored,
 *   so the caller need not pre-filter.
 * @param from - Inclusive window start, `YYYY-MM-DD`.
 * @param to - Inclusive window end, `YYYY-MM-DD`.
 * @param currency - Currency to sum in. Single-currency app; USD.
 * @returns The rung, the flow total behind it, and the per-account breakdown. A
 *   book with no market accounts returns `"0.00"`.
 * @throws If the window runs backwards.
 */
export function investmentReturn(
  byAccount: ReadonlyMap<string, AccountEndpoint>,
  txns: readonly AccountInvestmentTxn[],
  from: string,
  to: string,
  currency: string = CURRENCY,
): InvestmentReturnResult {
  assertWindow(from, to, "investmentReturn");

  const marketAccounts = endpointsOfType(byAccount, MARKET_ACCOUNT_TYPES);
  const eligible = new Set(marketAccounts.map((a) => a.accountId));

  // Correctness here comes from the `marketAccounts.map` below, which reads a
  // bucket only for an account that HAS endpoints and a market type — so a flow
  // on a checking account or on an account absent from both `computeNetWorth`
  // results can never reach `attribution()` no matter what this loop collects.
  // The eligibility check is therefore a COST guard, not a correctness one: it
  // keeps a book with thousands of cash rows from allocating a bucket per
  // account on a page that already pays for two `computeNetWorth` calls
  // (ADR-039's read-time consequence). Established by mutation-checking this
  // module — deleting the check leaves the suite green, and it should.
  const flowsByAccount = new Map<string, DatedFlow[]>();
  for (const txn of txns) {
    if (!eligible.has(txn.accountId)) continue;
    if (!withinWindow(txn.date, from, to)) continue;
    const flow = externalFlow(txn);
    if (flow === null) continue;
    const bucket = flowsByAccount.get(txn.accountId);
    if (bucket === undefined) flowsByAccount.set(txn.accountId, [flow]);
    else bucket.push(flow);
  }

  const perAccount: AccountReturn[] = marketAccounts.map((account) => {
    const split = attribution(
      account.opening,
      account.closing,
      flowsByAccount.get(account.accountId) ?? [],
      currency,
    );
    return {
      accountId: account.accountId,
      accountName: account.accountName,
      accountType: account.accountType,
      startValue: split.startValue,
      endValue: split.endValue,
      netFlows: split.netFlows,
      marketGrowth: split.marketGrowth,
    };
  });

  return {
    marketGrowth: Money.sum(
      perAccount.map((a) => Money.fromString(a.marketGrowth, currency)),
      currency,
    ).toString(),
    netFlows: Money.sum(
      perAccount.map((a) => Money.fromString(a.netFlows, currency)),
      currency,
    ).toString(),
    byAccount: perAccount,
  };
}
