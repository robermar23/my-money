import type { CategoryKind } from "@/db/schema/categories.ts";

/**
 * The row shapes the attribution classifiers consume (P17-02, ADR-040 §6).
 *
 * These are **structural subsets** of the Drizzle rows, not re-exports of them
 * — the `ValuedSnapshot` shape in
 * [investments/performance.ts](../investments/performance.ts). The engine
 * therefore never imports a schema module, never pulls `db`, and stays
 * trivially testable from object literals: a pairing test can state four
 * transactions in four lines instead of constructing rows with a dozen columns
 * the algorithm does not read.
 *
 * That is the "loader is smart, the rules are pure" split (ADR-032 §1) applied
 * at the type level. One loader (P17-19) does every read and every join; these
 * shapes are the seam it hands across. When a rule needs a column it does not
 * have, the fix is to widen the seam deliberately, not to reach for `db`.
 */

/**
 * A posted transaction as the boundary classifier and the pairer read it.
 *
 * `categoryKind` is joined in by the loader rather than resolved here: the
 * classifiers must not know that `categories` is a table. `null` means the row
 * is **uncategorized** — which is reported, never assumed (ADR-040 §5).
 */
export interface FlowTxn {
  readonly id: string;
  readonly accountId: string;
  /** `YYYY-MM-DD`, as stored. */
  readonly postedAt: string;
  /**
   * Signed amount, as stored. Negative is an outflow.
   *
   * Kept a string all the way through, per CLAUDE.md §Money. Sign matters twice
   * over here: it is what makes a transfer pair (two legs, opposite signs), and
   * it is what makes `saved` a cash-flow figure rather than a volume.
   */
  readonly amount: string;
  /** Descriptor. Display and diagnostics only — never parsed to infer meaning. */
  readonly name: string;
  /** `null` when the row is uncategorized. */
  readonly categoryId: string | null;
  /** The joined `categories.kind`. `null` when uncategorized. */
  readonly categoryKind: CategoryKind | null;
}

/**
 * Two legs of one internal move, established by pairing rather than asserted
 * by a category (ADR-040 §2).
 *
 * `fromId` is the outflow leg (negative amount), `toId` the inflow leg. Both
 * transactions are excluded from `saved`: the money never crossed the household
 * boundary, so net worth did not move and neither should any rung.
 */
export interface PairedTransfer {
  /** The negative-amount leg — money leaving the source account. */
  readonly fromId: string;
  /** The positive-amount leg — money arriving in the destination account. */
  readonly toId: string;
  /** Unsigned magnitude of the outflow leg, for diagnostics and tests. */
  readonly amount: string;
  /**
   * Whole days between the two legs' posted dates, always `>= 0`.
   *
   * The one `number` in this module, and it is a day count rather than money.
   * Surfaced because a pair that took four days to settle is weaker evidence
   * than a same-day pair, and a future tolerance review wants to see the spread
   * the real book produces rather than guess at it.
   */
  readonly dayGap: number;
}
