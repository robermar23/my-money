import "server-only";

import { plaidClient } from "./client.ts";

/**
 * The account fields the mapping flow consumes. A small structural summary so
 * we can return rows from either `/accounts/get` (`AccountBase`) or
 * `/investments/holdings/get` (`InvestmentAccount`) — the two SDK types diverge
 * on `verification_status`, but every field below is common to both.
 */
export interface PlaidAccountSummary {
  readonly account_id: string;
  readonly name: string;
  readonly official_name: string | null;
  readonly type: string;
  readonly subtype: string | null;
  readonly mask: string | null;
  readonly balances: { readonly iso_currency_code: string | null };
}

function summarize(a: {
  account_id: string;
  name: string;
  official_name?: string | null;
  type: string;
  subtype?: string | null;
  mask?: string | null;
  balances: { iso_currency_code?: string | null };
}): PlaidAccountSummary {
  return {
    account_id: a.account_id,
    name: a.name,
    official_name: a.official_name ?? null,
    type: a.type,
    subtype: a.subtype ?? null,
    mask: a.mask ?? null,
    balances: { iso_currency_code: a.balances.iso_currency_code ?? null },
  };
}

/**
 * Enumerate a Plaid Item's accounts.
 *
 * Prefers `/accounts/get`. For an **investments** Item, that call commonly
 * returns `PRODUCT_NOT_READY` right after Link — the account list for an
 * investments-only Item is surfaced by `/investments/holdings/get`, which also
 * forces the investments product to initialize. We fall back to it in that
 * case. Any other Plaid error (or a still-not-ready holdings call) is re-thrown
 * for the caller to surface.
 *
 * @param accessToken - Decrypted Plaid access token (server-side only).
 * @param productsConsented - The Item's `products_consented`.
 * @returns The Item's accounts as a flow-friendly summary.
 */
export async function listPlaidAccounts(
  accessToken: string,
  productsConsented: readonly string[],
): Promise<PlaidAccountSummary[]> {
  try {
    const resp = await plaidClient.accountsGet({ access_token: accessToken });
    return resp.data.accounts.map(summarize);
  } catch (err) {
    const code =
      (err as { response?: { data?: { error_code?: string } } })?.response?.data?.error_code ??
      null;
    if (code === "PRODUCT_NOT_READY" && productsConsented.includes("investments")) {
      const holdings = await plaidClient.investmentsHoldingsGet({ access_token: accessToken });
      return holdings.data.accounts.map(summarize);
    }
    throw err;
  }
}
