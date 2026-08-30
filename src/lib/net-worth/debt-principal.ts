import { Money } from "@/lib/money/money.ts";
import { balanceAtMonth } from "@/lib/mortgage/amortization.ts";
import { monthsBetween } from "@/lib/schedule/occurrences.ts";
import { assertWindow } from "./endpoints.ts";

/**
 * The debt-principal rung (P17-07, ADR-041 §2).
 *
 * Pure and I/O-free. `balanceAtMonth(T0) − balanceAtMonth(T1)` per liability,
 * summed with {@link Money} — a closed-form read of the amortization schedule
 * that needs **no transaction data at all**.
 *
 * ── This rung is one half of the phase's central trap ──────────────────────
 * A $2,000 mortgage payment of which $500 is principal appears in
 * `transactions` as a single $2,000 expense, because the app has no
 * principal/interest split on a transaction row and is not going to invent one
 * (CLAUDE.md §Domain Scope: no general ledger). `saved` therefore falls by the
 * full $2,000. This rung adds back the $500.
 *
 * The two net to −$1,500 — the interest — which is precisely the amount by
 * which paying a mortgage reduces net worth. The framing is deliberate: a
 * household reads *"you spent it, and $500 of it you still own"* correctly,
 * whereas excluding principal from outflows and showing no rung at all is
 * arithmetically identical and tells the family nothing.
 *
 * **Both halves have to be right, and the total cannot tell you whether they
 * are.** Mis-implementing either direction moves $500 between `saved` and this
 * rung while the identity still reconciles — which is why P17-13 asserts the two
 * rungs individually rather than their sum.
 *
 * ── Why the schedule and not the payments ──────────────────────────────────
 * The schedule is exact, needs no categorization, and cannot be thrown off by a
 * missing statement. Its cost is that it describes the loan the household
 * *agreed to*, not the one they actually paid: an extra principal payment, a
 * skipped month, or a refinance is invisible here and lands in `unexplained`,
 * where a named diagnostic can point at it. That is the ADR-039 §4 posture —
 * report the gap, never tune the rung to close it.
 *
 * A loan with no `liabilities` row is skipped by `computeNetWorth` entirely, so
 * it contributes to neither the anchor nor this rung. Consistent, and named as a
 * known limitation in ADR-041's consequences.
 */

const CURRENCY = "USD";

/**
 * A fixed-rate amortizing loan — a structural subset of the `liabilities` row
 * joined to its account, so this module never imports a schema module.
 */
export interface AmortizingLiability {
  /** The `loan` account the liability hangs off. Used for the audit trail. */
  readonly accountId: string;
  readonly name: string;
  readonly principalAtOrigination: string;
  /** Annual rate as a decimal FRACTION, e.g. `"0.065"` for 6.5% (see `accounts.ts` §UNITS). */
  readonly annualRate: string;
  readonly termMonths: number;
  /** First scheduled payment, `YYYY-MM-DD`. */
  readonly startDate: string;
}

/** One loan's contribution to the rung, with both ends of the schedule shown. */
export interface LiabilityPrincipal {
  readonly accountId: string;
  readonly name: string;
  /** Scheduled balance owed at the window start. */
  readonly openingBalance: string;
  /** Scheduled balance owed at the window end. */
  readonly closingBalance: string;
  /** `openingBalance − closingBalance`. Non-negative by construction. */
  readonly principalPaid: string;
}

export interface DebtPrincipalResult {
  /** Σ principal paid across every liability. Positive = net worth rose. */
  readonly principalPaid: string;
  /** Per-loan detail, ascending by account id, for the ADR-039 §5 audit trail. */
  readonly byLiability: readonly LiabilityPrincipal[];
}

/**
 * Scheduled principal paid down over an inclusive window.
 *
 * @param liabilities - Every amortizing loan on the book. An empty list is a
 *   real state (a debt-free household) and returns `"0.00"`, never `NaN`.
 * @param from - Inclusive window start, `YYYY-MM-DD`.
 * @param to - Inclusive window end, `YYYY-MM-DD`.
 * @param currency - Currency to sum in. Single-currency app; USD.
 * @returns The rung and its per-loan breakdown.
 * @throws If the window runs backwards, which would report principal paid as
 *   negative — a claim that the household *borrowed*, which is a different and
 *   far more alarming statement than the truth.
 */
export function debtPrincipalPaid(
  liabilities: readonly AmortizingLiability[],
  from: string,
  to: string,
  currency: string = CURRENCY,
): DebtPrincipalResult {
  assertWindow(from, to, "debtPrincipalPaid");

  const byLiability: LiabilityPrincipal[] = [];
  let total = Money.zero(currency);

  for (const liability of liabilities) {
    const principal = Money.fromString(liability.principalAtOrigination, currency);
    // `monthsBetween` floors at zero, so a window opening before the loan
    // existed reads as "no payments yet" on both endpoints and the difference
    // is exactly nothing — no special case required.
    const opening = balanceAtMonth(
      principal,
      liability.annualRate,
      liability.termMonths,
      monthsBetween(liability.startDate, from),
    );
    const closing = balanceAtMonth(
      principal,
      liability.annualRate,
      liability.termMonths,
      monthsBetween(liability.startDate, to),
    );
    // `balanceAtMonth` is monotonically non-increasing in `monthsElapsed` and
    // clamps at zero past the term, so this difference cannot be negative for a
    // forward window. No clamp is applied, deliberately: if one ever did come
    // out negative it would mean the amortization math changed underneath this
    // rung, and clamping would hide that instead of surfacing it.
    const paid = opening.sub(closing);

    total = total.add(paid);
    byLiability.push({
      accountId: liability.accountId,
      name: liability.name,
      openingBalance: opening.toString(),
      closingBalance: closing.toString(),
      principalPaid: paid.toString(),
    });
  }

  return {
    principalPaid: total.toString(),
    byLiability: byLiability.sort((a, b) => (a.accountId < b.accountId ? -1 : 1)),
  };
}
