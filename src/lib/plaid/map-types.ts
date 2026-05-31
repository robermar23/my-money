import type { AccountBase } from "plaid";

/**
 * Map a Plaid AccountBase to one of our accountTypeEnum values.
 *
 * Plaid's type vocabulary doesn't 1:1 with ours; mapping is conservative:
 *   - depository → depository (checking, savings, money_market)
 *   - credit     → credit_card
 *   - investment | brokerage → investment
 *   - loan       → loan
 *   - other      → null (the mapping UI will gate on this; user must skip)
 *
 * Returns null when no good mapping exists; the mapping form treats null as
 * "Skip" by default (user can still pick "Create new" with a manual type).
 */
export type AccountTypeMapping = "depository" | "credit_card" | "investment" | "loan" | null;

export function mapPlaidAccountType(account: AccountBase): AccountTypeMapping {
  switch (account.type) {
    case "depository":
      return "depository";
    case "credit":
      return "credit_card";
    case "investment":
    case "brokerage":
      return "investment";
    case "loan":
      return "loan";
    default:
      return null;
  }
}
