"use server";

import { db } from "@/db/client.ts";
import { plaidItems } from "@/db/schema/index.ts";
import { requireUser } from "@/lib/auth/require-user.ts";
import { plaidClient } from "@/lib/plaid/client.ts";
import { createPlaidItem, loadAccessToken } from "@/lib/plaid/tokens.ts";
import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { CountryCode, type LinkTokenCreateRequest, Products } from "plaid";

/**
 * Server actions for Plaid Link + Item exchange.
 *
 * Per CLAUDE.md §Plaid Safety Rules: nothing in this file logs Plaid secrets,
 * access tokens, or `Plaid-Verification` headers. The Plaid SDK is only ever
 * invoked from server-side surfaces (this file, the webhook route handler,
 * and BullMQ workers).
 *
 * Per ADR-008: Products is always exactly `['transactions']`. Auth, Identity,
 * Investments, and Liabilities are explicitly out of scope for Phase 4.
 */

/* ---------------------------------------------------------------------------
 * P4-10 — createLinkTokenAction
 * --------------------------------------------------------------------------- */

export interface CreateLinkTokenResult {
  linkToken?: string;
  error?: string;
}

export interface CreateLinkTokenOptions {
  /** When present, opens Plaid Link in UPDATE mode for an existing Item (P4-25 reauth). */
  plaidItemPk?: string;
}

/**
 * Mint a fresh, single-use `link_token` for Plaid Link.
 *
 * Per CLAUDE.md §Plaid Safety Rules: link tokens are single-use and MUST NOT
 * be cached. Every Link-open call creates a new one.
 */
export async function createLinkTokenAction(
  options?: CreateLinkTokenOptions,
): Promise<CreateLinkTokenResult> {
  const user = await requireUser();

  const accessToken = options?.plaidItemPk ? await loadAccessToken(options.plaidItemPk) : undefined;

  const webhook = process.env.PLAID_WEBHOOK_URL?.trim() || undefined;

  const request: LinkTokenCreateRequest = {
    client_name: "my-money",
    user: { client_user_id: user.id },
    country_codes: [CountryCode.Us],
    language: "en",
    // In update mode, providing `access_token` puts Link into reauth flow and
    // `products` MUST be omitted (Plaid uses the products already on the Item).
    ...(accessToken ? { access_token: accessToken } : { products: [Products.Transactions] }),
    ...(webhook ? { webhook } : {}),
  };

  try {
    const response = await plaidClient.linkTokenCreate(request);
    return { linkToken: response.data.link_token };
  } catch (err) {
    return { error: redactPlaidError(err, "create link_token") };
  }
}

/* ---------------------------------------------------------------------------
 * P4-12 — exchangePublicTokenAction
 * --------------------------------------------------------------------------- */

export interface ExchangePublicTokenResult {
  error?: string;
}

/**
 * Exchange a single-use Plaid `public_token` for a long-lived `access_token`,
 * persist a `plaid_items` row with the encrypted token, and redirect to the
 * account-mapping page.
 *
 * Per CLAUDE.md §Plaid Safety Rules: the access token is encrypted via the
 * AEAD module BEFORE landing in the database, and the row INSERT happens
 * inside a transaction so a half-stored Item can't exist.
 *
 * Redirects to /settings/connections/[plaidItemPk]/map on success.
 */
export async function exchangePublicTokenAction(
  publicToken: string,
): Promise<ExchangePublicTokenResult> {
  await requireUser();

  if (typeof publicToken !== "string" || publicToken.length === 0) {
    return { error: "Missing public_token" };
  }

  // 1. Exchange public_token → access_token + item_id.
  let accessToken: string;
  let itemId: string;
  try {
    const exchange = await plaidClient.itemPublicTokenExchange({
      public_token: publicToken,
    });
    accessToken = exchange.data.access_token;
    itemId = exchange.data.item_id;
  } catch (err) {
    return { error: redactPlaidError(err, "exchange public_token") };
  }

  // 2. Pull item metadata for institution lookup.
  let institutionId: string | null;
  try {
    const itemGet = await plaidClient.itemGet({ access_token: accessToken });
    institutionId = itemGet.data.item.institution_id ?? null;
  } catch (err) {
    return { error: redactPlaidError(err, "/item/get") };
  }

  if (!institutionId) {
    return { error: "Plaid did not return an institution_id for this Item" };
  }

  // 3. Resolve institution name (display only).
  let institutionName = "Unknown";
  try {
    const inst = await plaidClient.institutionsGetById({
      institution_id: institutionId,
      country_codes: [CountryCode.Us],
    });
    institutionName = inst.data.institution.name;
  } catch {
    // Non-fatal — display can fall back to "Unknown" rather than blocking
    // the whole flow on Plaid's institutions endpoint hiccupping.
  }

  // 4. Encrypt + INSERT inside a single transaction (P4-12 invariant: no
  //    half-stored Items). The encryption + write both live behind
  //    `createPlaidItem` so the ciphertext column never appears outside
  //    src/lib/plaid/ (enforced by tokens.test.ts).
  let plaidItemPk: string;
  try {
    plaidItemPk = await db.transaction((tx) =>
      createPlaidItem(
        {
          plaidItemId: itemId,
          institutionId,
          institutionName,
          accessToken,
          productsConsented: ["transactions"],
        },
        tx,
      ),
    );
  } catch (err) {
    return { error: `Failed to persist Plaid Item: ${(err as Error).message}` };
  }

  redirect(`/settings/connections/${plaidItemPk}/map`);
}

/* ---------------------------------------------------------------------------
 * Helpers
 * --------------------------------------------------------------------------- */

/**
 * Plaid errors carry verbose data including request metadata; turn them into
 * a short, user-safe message. NEVER returns headers, the access_token, or
 * other secrets.
 */
function redactPlaidError(err: unknown, operation: string): string {
  // Plaid's SDK rejects with an axios-style error; the useful part is the
  // response body's `error_code` and `error_message`.
  const e = err as { response?: { data?: { error_code?: string; error_message?: string } } };
  const code = e.response?.data?.error_code;
  const msg = e.response?.data?.error_message;
  if (code) return `Plaid ${operation} failed: ${code}${msg ? ` — ${msg}` : ""}`;
  return `Plaid ${operation} failed (see server logs).`;
}

/**
 * Internal helper for `mapAccountsAction` to assert that the linked Item
 * belongs to a request the requireUser() check already validated. Single-user
 * app — anyone authenticated has access to every Item — but kept as a
 * deliberate hook so the multi-user assumption stays falsifiable.
 */
export async function assertItemExists(plaidItemPk: string): Promise<void> {
  const rows = await db
    .select({ id: plaidItems.id })
    .from(plaidItems)
    .where(eq(plaidItems.id, plaidItemPk))
    .limit(1);
  if (rows.length === 0) {
    throw new Error(`No plaid_items row with id=${plaidItemPk}`);
  }
}
