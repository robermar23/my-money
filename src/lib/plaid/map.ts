import type { NewTransaction } from "@/db/schema/index.ts";
import { Money } from "@/lib/money/money.ts";
import type { Transaction as PlaidTransaction } from "plaid";

/**
 * P4-19 — Convert a Plaid `Transaction` into our `NewTransaction` shape.
 *
 * Sign convention difference (CRITICAL):
 *   - Plaid: positive amount = money LEAVING the account (debit / outflow).
 *   - my-money / OFX: positive amount = money ENTERING the account (credit /
 *     inflow).
 * We FLIP the sign at the boundary; downstream code (dashboards, importers,
 * net-worth) assumes the OFX convention.
 *
 * The flip is performed via `Money.negate()` — string-precise math, never
 * `Number()`. Per CLAUDE.md §Money & Numeric Precision.
 *
 * Other field mappings:
 *   - `fitid`     = Plaid `transaction_id` (globally unique per Item; the
 *                   `(account_id, fitid)` UNIQUE constraint dedupes within an
 *                   account).
 *   - `postedAt`  = `authorized_date` when present, else `date` (the former
 *                   is "when it happened," the latter is "when it cleared" —
 *                   the user perception aligns with the former).
 *   - `name`      = `merchant_name ?? name` (merchant_name is cleaner when
 *                   present).
 *   - `memo`      = `payment_meta.payee ?? null` (richer hint for the
 *                   categorizer's memo-field rules).
 *   - `category`  = NULL — the worker's categorizer wires it in via
 *                   `matchCategory` (P4-20). Leaving it null here keeps the
 *                   mapper pure.
 *   - `raw`       = the entire Plaid Transaction object, retained for Phase 5
 *                   use of `personal_finance_category`, cost-basis seeding,
 *                   etc.
 *
 * `source` and `accountId` are set by the caller (the sync worker) — those
 * depend on the call site, not the Plaid payload.
 */

/**
 * Subset of a Plaid `Transaction` we actually consume.
 *
 * `payment_meta` is widened to optional/null because real-world Plaid
 * deliveries occasionally omit it, and the field's nullability differs
 * between Plaid product responses.
 */
export type PlaidTransactionLike = Pick<
  PlaidTransaction,
  | "transaction_id"
  | "amount"
  | "iso_currency_code"
  | "merchant_name"
  | "name"
  | "date"
  | "authorized_date"
> & {
  payment_meta?: PlaidTransaction["payment_meta"] | null;
};

/**
 * Map a single Plaid transaction to our DB row shape (sans source/importBatchId).
 *
 * @param t - Plaid `Transaction` (or compatible subset).
 * @param accountId - our internal `accounts.id` UUID this transaction lands under.
 * @returns A `NewTransaction` ready for INSERT. `source` is left to the caller
 *   (Plaid worker sets `'plaid'`).
 */
export function plaidToTransaction(
  t: PlaidTransactionLike,
  accountId: string,
): Omit<NewTransaction, "source"> {
  if (!t.transaction_id) {
    throw new Error("plaidToTransaction: Plaid transaction missing transaction_id");
  }
  if (typeof t.amount !== "number" || !Number.isFinite(t.amount)) {
    throw new Error(`plaidToTransaction: invalid amount for ${t.transaction_id}: ${t.amount}`);
  }

  const currency = t.iso_currency_code ?? "USD";
  // toFixed(2) is the conversion-to-canonical-string boundary; Money then
  // owns all arithmetic. The negate() call is exact decimal math, not
  // floating-point.
  const flipped = Money.fromString(t.amount.toFixed(2), currency).negate();

  const postedAt = t.authorized_date ?? t.date;
  if (!postedAt || !/^\d{4}-\d{2}-\d{2}$/.test(postedAt)) {
    throw new Error(`plaidToTransaction: bad date for ${t.transaction_id}: ${postedAt}`);
  }

  const name = (t.merchant_name && t.merchant_name.length > 0 ? t.merchant_name : t.name) ?? "";

  const memo =
    t.payment_meta?.payee && t.payment_meta.payee.length > 0 ? t.payment_meta.payee : null;

  return {
    accountId,
    postedAt,
    amount: flipped.toString(),
    name,
    memo,
    category: null,
    fitid: t.transaction_id,
    raw: t as unknown as Record<string, unknown>,
  };
}
