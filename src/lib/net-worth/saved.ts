import { Money } from "@/lib/money/money.ts";
import type { ClassifiedFlow } from "./boundary.ts";

/**
 * `saved` — the first and largest rung (P17-05, ADR-041 §1).
 *
 * External inflows minus external outflows over the window, from
 * `transactions`, using the boundary {@link classifyFlow} established. Pure,
 * `Money` only.
 *
 * ── Why it is a CASH-FLOW figure and not a balance delta ───────────────────
 * The obvious implementation — "add up how much the cash accounts moved" —
 * would be a catastrophe dressed as a simplification. Every rung would then be
 * derived from the same balances the identity is trying to explain, the
 * residual would come out zero on every book forever, and `unexplained` (the
 * single most useful output of this phase, ADR-039 §4) would become a constant
 * that reports nothing.
 *
 * Deriving `saved` independently, from the transaction rows, is what makes the
 * residual a real measurement: it is the disagreement between two genuinely
 * separate accounts of the same month. A decomposition that always reconciles
 * has not been checked — it has been arranged.
 *
 * ── It can be negative, and that is not an error ────────────────────────────
 * A household that spent more than it earned has a negative `saved`. Clamping
 * it to zero would move the difference into `unexplained` and tell a family
 * their money vanished mysteriously, when in fact they overspent — which is
 * both true and useful.
 *
 * ── Diagnostics ride along ─────────────────────────────────────────────────
 * The excluded volumes are returned with the figure rather than recomputed
 * later, so the caller never walks the rows twice and the numbers on screen are
 * guaranteed to describe the same pass that produced `saved`. The residual
 * contributors (P17-16) read them straight through.
 *
 * ── One rung, three exclusions, kept apart ─────────────────────────────────
 * `'internal'` rows contribute to nothing at all and are reported nowhere:
 * money that stayed inside the household did not move net worth, and a
 * "transfer volume" figure that counted them would just measure how often the
 * family moves its own money. `'unpaired_transfer'` and `'uncategorized'` rows
 * also contribute nothing to `saved`, but their volumes ARE reported, because
 * each is a specific, fixable reason the residual is larger than it should be.
 */

const CURRENCY = "USD";

/** {@link savedFromFlows}'s answer: one rung plus the volumes it had to skip. */
export interface SavedResult {
  /** `inflow − outflow`. Signed; negative means the window spent more than it earned. */
  readonly saved: string;
  /** Signed sum over `'inflow'` rows. Normally positive. */
  readonly inflow: string;
  /**
   * Outflow as a POSITIVE magnitude, so the UI never has to negate it.
   *
   * Refunds posted against an expense category reduce it, because they are
   * signed positive on an `'outflow'` row — the verdict states the side, the
   * sign does the arithmetic (see `boundary.ts`).
   */
  readonly outflow: string;
  /**
   * Unsigned volume of transfer legs with no counterparty.
   *
   * A magnitude sum over legs, not over moves: when both legs of a move fail to
   * pair, both are counted. That is the honest reading of "how much transfer
   * volume this app could not establish as internal", and halving it to guess
   * at a move count would report a number no row supports.
   */
  readonly unpairedTransferVolume: string;
  /** Unsigned volume of rows with no category. */
  readonly uncategorizedVolume: string;
  /**
   * How many rows that was.
   *
   * A count, not money — `"$4,200 across 3 transactions"` and `"$4,200 across
   * 340 transactions"` are different problems with different fixes, and the
   * volume alone cannot tell them apart.
   */
  readonly uncategorizedCount: number;
}

/**
 * Compute `saved` and its excluded volumes in a single pass.
 *
 * @param classified - Every row in the window with its {@link FlowVerdict}.
 *   Pass the complete set: rows that contribute to no rung still have to be
 *   counted, or the diagnostics cannot say what was skipped.
 * @param currency - Currency to sum in. Single-currency app; defaults to USD.
 * @returns The rung and its diagnostics. Empty input returns all zeros — never
 *   `NaN`, never a throw. A window with no transactions is a real state (a
 *   fresh install, a quiet month), and `"0.00"` is the correct answer to it.
 */
export function savedFromFlows(
  classified: readonly ClassifiedFlow[],
  currency: string = CURRENCY,
): SavedResult {
  let inflow = Money.zero(currency);
  let outflow = Money.zero(currency);
  let unpairedTransferVolume = Money.zero(currency);
  let uncategorizedVolume = Money.zero(currency);
  let uncategorizedCount = 0;

  for (const { txn, verdict } of classified) {
    const amount = Money.fromString(txn.amount, currency);
    switch (verdict) {
      case "inflow":
        inflow = inflow.add(amount);
        break;
      case "outflow":
        // Stored outflows are negative, so negating gives a positive magnitude
        // and a positive refund correctly reduces it.
        outflow = outflow.sub(amount);
        break;
      case "unpaired_transfer":
        unpairedTransferVolume = unpairedTransferVolume.add(amount.abs());
        break;
      case "uncategorized":
        uncategorizedVolume = uncategorizedVolume.add(amount.abs());
        uncategorizedCount += 1;
        break;
      case "internal":
        // Deliberately nothing. Money that never crossed the boundary did not
        // move net worth and must not appear in any figure here.
        break;
    }
  }

  return {
    saved: inflow.sub(outflow).toString(),
    inflow: inflow.toString(),
    outflow: outflow.toString(),
    unpairedTransferVolume: unpairedTransferVolume.toString(),
    uncategorizedVolume: uncategorizedVolume.toString(),
    uncategorizedCount,
  };
}
