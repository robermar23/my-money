import { Money } from "@/lib/money/money.ts";
import { type AccountEndpoint, endpointsOfType } from "./endpoints.ts";

/**
 * The asset-revaluation rung (P17-08, ADR-041 §5).
 *
 * Pure. Σ `delta` across every `property` and `personal_asset` account, read
 * from the ADR-039 §1 anchor.
 *
 * ── Why the delta simply *is* the rung ─────────────────────────────────────
 * These account types change value only by being revalued — that is what the
 * type means. A house does not receive deposits and a truck does not pay
 * dividends; someone enters a new number, or a valuation job does. So there is
 * no flow to net out and no attribution to perform: the balance change is the
 * whole story, and this module is deliberately the shortest rung in the phase.
 *
 * ── The capital-improvement limitation, documented rather than modeled ─────
 * A new roof paid from a tracked checking account shows up twice: as spending
 * inside `saved`, and as revaluation here. The household's position is
 * double-counted, and the identity still reconciles, so nothing detects it.
 * Modeling it would need an improvement-versus-market split the app does not
 * hold and a family cannot supply reliably, so ADR-041 §5 documents it and
 * `docs/ATTRIBUTION.md` (P17-28) states it in plain language. Naming a
 * limitation the user can reason about beats inventing a number they cannot
 * check.
 *
 * ── ADR-041 §7: the credit-card sign, verified before anything depended on it ──
 * The phase is required to establish that `account_snapshots.balance` for a
 * `credit_card` account is stored **negative** before a rung relies on it.
 * [credit-card-sign.test.ts](./credit-card-sign.test.ts) does that, and the
 * finding is threefold:
 *
 *   1. `computeNetWorth` negates `loan` accounts and **nothing else**, so it
 *      sums a card's snapshot verbatim. The convention is entirely the writer's
 *      responsibility.
 *   2. The Plaid path enforces it — `sync-plaid-item.ts` negates explicitly for
 *      `credit_card` before writing. The **manual** path does not:
 *      `recordBalanceSchema` makes the leading `-` optional, so a household
 *      typing `1200.00` for a card they owe $1,200 on overstates net worth by
 *      $2,400 with no warning. Recorded here, not fixed here — the manual write
 *      path belongs to whichever phase owns balance entry, and ADR-039 §3 keeps
 *      this phase read-only.
 *   3. The empirical survey the ADR asks for is **vacuous on the owner's dev
 *      book today**: it holds one account and zero snapshots, so no real card
 *      data exists to check. The guarantee therefore comes from the write paths
 *      and the pinned assertions, not from a row count.
 *
 * **No rung in this phase reads a credit-card balance.** Cards reach the
 * decomposition only through the anchor, which is `computeNetWorth`'s own total
 * by ADR-039 §1 — so a wrongly-signed card makes `delta` wrong and the whole
 * error lands in `unexplained`, visible, rather than inside a rung that would
 * look measured. That is the correct failure mode, and it is why this rung
 * partitions on `property`/`personal_asset` explicitly instead of taking
 * "everything that is not an investment".
 */

const CURRENCY = "USD";

/**
 * Account types whose balance changes only by revaluation.
 *
 * A closed `const` tuple rather than a loose string check, so adding an account
 * type to `accountTypeEnum` without deciding which rung owns it is a
 * conversation rather than a silent omission (the `CATEGORY_NECESSITIES`
 * precedent).
 */
export const REVALUED_ACCOUNT_TYPES = ["property", "personal_asset"] as const;

export interface AssetRevaluationResult {
  /** Σ delta across the revalued accounts. Signed — depreciation is not clamped. */
  readonly revaluation: string;
  /** The accounts counted, ascending by id, for the ADR-039 §5 audit trail. */
  readonly byAccount: readonly AccountEndpoint[];
  /**
   * Counted accounts observed at only one endpoint.
   *
   * A home first tracked mid-window contributes its whole value to this rung,
   * because the anchored delta contains it too and the identity has to hold.
   * But *"we started tracking your house"* is not *"your house went up
   * $400,000"*, so the account is named for the residual diagnostics (P17-16) to
   * explain rather than quietly folded into an appreciation figure.
   */
  readonly asymmetric: readonly AccountEndpoint[];
}

/**
 * Revaluation of property and personal assets over the window.
 *
 * @param byAccount - The per-account map from `endpointsFor` (P17-06). Every
 *   rung reads its deltas from there rather than issuing its own query.
 * @param currency - Currency to sum in. Single-currency app; USD.
 * @returns The rung, the accounts it counted, and the asymmetric subset. An
 *   empty book returns `"0.00"` — a household that owns no property is a real
 *   state, not a missing input.
 */
export function assetRevaluation(
  byAccount: ReadonlyMap<string, AccountEndpoint>,
  currency: string = CURRENCY,
): AssetRevaluationResult {
  const counted = endpointsOfType(byAccount, REVALUED_ACCOUNT_TYPES);
  const revaluation = Money.sum(
    counted.map((e) => Money.fromString(e.delta, currency)),
    currency,
  );

  return {
    revaluation: revaluation.toString(),
    byAccount: counted,
    asymmetric: counted.filter((e) => e.presence !== "both"),
  };
}
