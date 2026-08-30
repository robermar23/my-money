import { Money } from "@/lib/money/money.ts";
import { assertWindow, withinWindow } from "./endpoints.ts";

/**
 * The payroll-direct retirement rung (P17-09, ADR-041 §3).
 *
 * Pure. Σ `|amount|` over `investment_transactions` in the window where
 * `source='income'`.
 *
 * ── The largest systematic hole a naive decomposition leaves ───────────────
 * A 401k contribution never touches checking. `transactions` cannot see it, so
 * `saved` misses it entirely — while `attribution()` correctly subtracts it as
 * an external flow so it is not mistaken for market growth. Left alone, the
 * money enters the household, raises net worth, and is explained by no rung:
 * it lands in `unexplained` every single period, at roughly the same amount,
 * forever. A residual that is meant to be a data-quality signal would instead be
 * a constant, and the household would learn to ignore it.
 *
 * ── Why the cancellation is by CONSTRUCTION, not by coincidence ────────────
 * The rung is scoped to `source='income'` — the exact marker Phase 14's
 * materializer writes (ADR-030/031) — and it sums the same `|amount|` that
 * `externalFlow()` reads. So this rung re-adds **precisely** the flows the
 * market rung removed, row for row, and the two cancel exactly rather than
 * approximately. Widening the scope (say, to "every deposit into a retirement
 * account") would break that correspondence immediately and silently.
 *
 * A brokerage deposit funded from a tracked checking account carries
 * `source='plaid'` or `'manual'`, is correctly *not* re-added here, and
 * reconciles through `saved` and Δcash instead.
 *
 * ── Why the magnitude, and not the signed amount ───────────────────────────
 * `persistContribution` writes a **priceable** contribution as a `buy` with a
 * negative amount (cash leaving the sleeve to acquire shares) and a basis-only
 * one as a positive `cash`/`deposit`. Both are the same event — money the
 * household put away — and `externalFlow()` already reads both as an inflow via
 * `|amount|`. Reading the raw sign here would subtract half the contributions
 * and add the other half, which is the sort of error that averages out to
 * "roughly plausible" on a real book and is therefore very hard to spot.
 *
 * The employer match rides along by design: `contribution.ts` computes
 * `total = employee + employer` and the materializer writes that single total as
 * one row. A match is money that entered the household without touching
 * checking, which is exactly what this rung exists to capture.
 */

const CURRENCY = "USD";

/** The marker Phase 14 writes on a materialized payroll contribution. */
const PAYROLL_SOURCE = "income";

/**
 * The `investment_transactions` fields this rung reads — a structural subset, so
 * the module never imports a schema module.
 */
export interface ContributionTxn {
  readonly accountId: string;
  /** `trade_date`, `YYYY-MM-DD`. */
  readonly tradeDate: string;
  /** Signed cash impact in the app's convention. Read by magnitude — see header. */
  readonly amount: string;
  /** `'plaid' | 'manual' | 'income'`. Only `'income'` counts. */
  readonly source: string;
}

/** One account's share of the rung. */
export interface AccountContributions {
  readonly accountId: string;
  readonly contributions: string;
  readonly count: number;
}

export interface RetirementResult {
  /** Σ `|amount|` over the qualifying rows. Non-negative. */
  readonly contributions: string;
  /** How many rows that was — a count, not money. */
  readonly count: number;
  /** Per-account detail, ascending by id, for the ADR-039 §5 audit trail. */
  readonly byAccount: readonly AccountContributions[];
}

/**
 * Payroll-direct contributions landing inside the window.
 *
 * @param txns - Investment transactions to consider. Rows of any `source` may be
 *   passed; only `'income'` is counted, so the caller need not pre-filter.
 * @param from - Inclusive window start, `YYYY-MM-DD`.
 * @param to - Inclusive window end, `YYYY-MM-DD`.
 * @param currency - Currency to sum in. Single-currency app; USD.
 * @returns The rung, its row count, and the per-account breakdown. A window with
 *   no contributions returns `"0.00"` — common and correct for a household with
 *   no payroll-direct plan.
 * @throws If the window runs backwards.
 */
export function payrollDirectContributions(
  txns: readonly ContributionTxn[],
  from: string,
  to: string,
  currency: string = CURRENCY,
): RetirementResult {
  assertWindow(from, to, "payrollDirectContributions");

  const perAccount = new Map<string, { total: Money; count: number }>();
  let total = Money.zero(currency);
  let count = 0;

  for (const txn of txns) {
    if (txn.source !== PAYROLL_SOURCE) continue;
    if (!withinWindow(txn.tradeDate, from, to)) continue;

    const magnitude = Money.fromString(txn.amount, currency).abs();
    total = total.add(magnitude);
    count += 1;

    const entry = perAccount.get(txn.accountId) ?? { total: Money.zero(currency), count: 0 };
    perAccount.set(txn.accountId, {
      total: entry.total.add(magnitude),
      count: entry.count + 1,
    });
  }

  return {
    contributions: total.toString(),
    count,
    byAccount: [...perAccount.entries()]
      .map(([accountId, entry]) => ({
        accountId,
        contributions: entry.total.toString(),
        count: entry.count,
      }))
      .sort((a, b) => (a.accountId < b.accountId ? -1 : 1)),
  };
}
