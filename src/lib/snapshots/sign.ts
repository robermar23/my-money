import type { accountTypeEnum } from "@/db/schema/enums.ts";
import { Money } from "@/lib/money/money.ts";

/**
 * P17-31 — the single implementation of the `account_snapshots.balance` sign
 * convention (ADR-042 §1, §4).
 *
 * **The convention**: `account_snapshots.balance` is a **net-worth
 * contribution** — assets positive, liabilities negative. It is not "the
 * balance the institution shows you". A credit card you owe $1,200 on is stored
 * as `-1200.00`, because that is what it contributes to net worth.
 *
 * This is not a new rule. [compute.ts](../net-worth/compute.ts) has always
 * summed snapshot balances verbatim and negated **only** `loan` accounts, which
 * means a `credit_card` row must already be negative for the shipped net-worth
 * number to be right. That convention was never written down anywhere, and the
 * write paths drifted from it: Plaid sync negated explicitly, `recordLoanTerms`
 * wrote `-principal`, property values were positive by definition — and manual
 * balance entry and QFX import stored whatever arrived, verbatim. A household
 * reading `$1,234.56` off a Visa statement and typing exactly that overstated
 * its net worth by **twice** the balance, silently (P17-08's finding).
 *
 * So the rule lives here, in one function, and every write path calls it. Two
 * copies of a sign rule is precisely how the drift happened; the same argument
 * as ADR-036 §5's `monthsBetween` consolidation.
 *
 * **What this module deliberately does NOT do.** It does not touch the read
 * side. `computeNetWorth` still sums a card verbatim and negates only `loan`,
 * because the fix belongs at the write boundary — normalizing on read would
 * double-negate the rows the Plaid path has always stored correctly
 * (ADR-042 §Consequences).
 *
 * Pure and I/O-free: it takes strings and returns strings. The `Money` round
 * trip is not ceremony — CLAUDE.md §Money forbids a native negation or a string
 * prefix on a money value, and `Money` is also what normalizes `"1200"` into
 * the `NUMERIC(18,2)` shape the column stores.
 */

/** The seven account shapes, derived from the DB enum so the two cannot drift. */
export type AccountType = (typeof accountTypeEnum.enumValues)[number];

/**
 * Which account types hold a **liability** — a balance that subtracts from net
 * worth and is therefore stored negated.
 *
 * The `satisfies` is the exhaustiveness check ADR-042 §1 asks for, and it is
 * the point of writing this as a map rather than a `switch` or an `includes`:
 * adding a member to `accountTypeEnum` without deciding its sign **fails the
 * build here**, rather than silently defaulting to verbatim and shipping a
 * wrong net worth for the new type.
 *
 * Only two members are `true`, and both earn it the same way — the account
 * represents money owed to someone else:
 *   - `credit_card` — a revolving balance owed to the issuer.
 *   - `loan` — a mortgage or other amortizing debt; `recordLoanTermsAction`
 *     has always written `-principal` by hand, and now says so through here.
 *
 * `depository`, `investment`, `crypto_ira`, `property` and `personal_asset` are
 * all things the household owns. Their balance is already a net-worth
 * contribution, so it is stored as entered.
 */
const IS_LIABILITY = {
  depository: false,
  credit_card: true,
  investment: false,
  crypto_ira: false,
  loan: true,
  property: false,
  personal_asset: false,
} satisfies Record<AccountType, boolean>;

/**
 * Convert what the user (or an institution) entered into what gets stored.
 *
 * For a liability account the entered value is an **amount owed** — the figure
 * on the statement, positive when money is owed — and it is stored negated. For
 * everything else the entered value already is the net-worth contribution and
 * is stored as-is.
 *
 * An **overpaid card** is a real state and stays expressible: a negative amount
 * owed (`"-75.00"`, the issuer owes the household $75) stores positive. The
 * mapping is a plain negation, which is what keeps it invertible — see
 * {@link enteredBalance}.
 *
 * @param accountType - The account's `type` column.
 * @param entered - The amount as entered, as a decimal string.
 * @param currency - ISO currency code, for the `Money` round trip.
 * @returns The value to write to `account_snapshots.balance`, at cents
 *   precision. Zero always comes back as `"0.00"`, never `"-0.00"`.
 */
export function snapshotBalance(
  accountType: AccountType,
  entered: string,
  currency: string,
): string {
  const money = Money.fromString(entered, currency);
  return IS_LIABILITY[accountType] ? money.negate().toString() : money.toString();
}

/**
 * The inverse of {@link snapshotBalance}: convert a stored balance back into the
 * figure the form should show.
 *
 * Used to pre-fill an edit form so a household sees the same number it typed,
 * rather than the storage representation. Negation is its own inverse, so this
 * is the same operation — it exists as a separate named function because the
 * call sites read in opposite directions and a bare `snapshotBalance` at a
 * display site would look like a bug.
 *
 * @param accountType - The account's `type` column.
 * @param stored - The value read from `account_snapshots.balance`.
 * @param currency - ISO currency code, for the `Money` round trip.
 * @returns The amount to display in the entry field, at cents precision.
 */
export function enteredBalance(accountType: AccountType, stored: string, currency: string): string {
  const money = Money.fromString(stored, currency);
  return IS_LIABILITY[accountType] ? money.negate().toString() : money.toString();
}

/**
 * Whether this account type's balance field asks for an **amount owed** rather
 * than a balance.
 *
 * Exported so the UI can pick its label from the same source of truth as the
 * storage rule (ADR-042 §3 — the relabel is what makes the behaviour change
 * safe, so it must not be able to drift from the negation).
 *
 * @param accountType - The account's `type` column.
 * @returns True when a positive entry means money owed.
 */
export function isLiabilityAccount(accountType: AccountType): boolean {
  return IS_LIABILITY[accountType];
}
