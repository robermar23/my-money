"use server";

import { db } from "@/db/client.ts";
import { plaidItems } from "@/db/schema/index.ts";
import { accounts } from "@/db/schema/index.ts";
import { requireUser } from "@/lib/auth/require-user.ts";
import { plaidClient, plaidWebhookUrl } from "@/lib/plaid/client.ts";
import { clearAccessToken, createPlaidItem, loadAccessToken } from "@/lib/plaid/tokens.ts";
import { syncPlaidItemQueue } from "@/lib/queue/queues.ts";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { CountryCode, type LinkTokenCreateRequest, Products } from "plaid";
import { z } from "zod";

/**
 * Server actions for Plaid Link + Item exchange.
 *
 * Per CLAUDE.md §Plaid Safety Rules: nothing in this file logs Plaid secrets,
 * access tokens, or `Plaid-Verification` headers. The Plaid SDK is only ever
 * invoked from server-side surfaces (this file, the webhook route handler,
 * and BullMQ workers).
 *
 * Per ADR-008, Phase 4 consented to `['transactions']` only. Phase 5 (ADR-011)
 * adds the `investments` product for a separate Fidelity Item. The product set
 * is now a validated parameter rather than a hard-coded constant; what an Item
 * consented to is persisted in `plaid_items.products_consented` and drives the
 * sync routing (transactions vs. investments).
 */

/**
 * The Plaid products my-money knows how to consume. Validated at the action
 * boundary with zod (CLAUDE.md §Zod) so a bad value never reaches the Plaid
 * SDK or the database.
 */
export type PlaidProduct = "transactions" | "investments";

const plaidProductsSchema = z
  .array(z.enum(["transactions", "investments"]))
  .min(1, "At least one Plaid product is required");

/** Map our product literal to the Plaid SDK enum. */
function toPlaidProduct(product: PlaidProduct): Products {
  return product === "investments" ? Products.Investments : Products.Transactions;
}

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
  /**
   * Products to request. Defaults to `['transactions']` (Phase 4 behavior).
   * Pass `['investments']` for the Fidelity brokerage flow (P5-10). Ignored in
   * update mode — Plaid reuses the products already on the Item.
   */
  products?: PlaidProduct[];
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

  // Validate the requested products at the boundary (zod). Only relevant in
  // connect mode — update mode omits `products` entirely.
  let products: Products[] = [Products.Transactions];
  if (!accessToken) {
    const parsed = plaidProductsSchema.safeParse(options?.products ?? ["transactions"]);
    if (!parsed.success) {
      return { error: parsed.error.issues[0]?.message ?? "Invalid Plaid products" };
    }
    products = parsed.data.map(toPlaidProduct);
  }

  const webhook = plaidWebhookUrl();

  const request: LinkTokenCreateRequest = {
    client_name: "my-money",
    user: { client_user_id: user.id },
    country_codes: [CountryCode.Us],
    language: "en",
    // In update mode, providing `access_token` puts Link into reauth flow and
    // `products` MUST be omitted (Plaid uses the products already on the Item).
    ...(accessToken ? { access_token: accessToken } : { products }),
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
 *
 * @param publicToken - The single-use token from Plaid Link's onSuccess.
 * @param products - The products this Item was linked with (default
 *   `['transactions']`). Persisted to `plaid_items.products_consented` and used
 *   by the sync router (ADR-011).
 */
export async function exchangePublicTokenAction(
  publicToken: string,
  products?: PlaidProduct[],
): Promise<ExchangePublicTokenResult> {
  await requireUser();

  if (typeof publicToken !== "string" || publicToken.length === 0) {
    return { error: "Missing public_token" };
  }

  // Validate the consented products before any Plaid call or DB write.
  const parsedProducts = plaidProductsSchema.safeParse(products ?? ["transactions"]);
  if (!parsedProducts.success) {
    return { error: parsedProducts.error.issues[0]?.message ?? "Invalid Plaid products" };
  }
  const productsConsented = parsedProducts.data;

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
          productsConsented,
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

/* ---------------------------------------------------------------------------
 * P4-25 — finalizeReauthAction
 * --------------------------------------------------------------------------- */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface FinalizeReauthResult {
  error?: string;
}

/**
 * P4-25 — called from the client after Plaid Link finishes in UPDATE mode.
 *
 * No `public_token` is delivered in update mode — the existing access_token
 * stays valid. All we need to do is flip the local status back to 'active',
 * clear the error fields, and enqueue a sync to confirm transactions resume
 * flowing.
 */
export async function finalizeReauthAction(plaidItemPk: string): Promise<FinalizeReauthResult> {
  await requireUser();
  if (!UUID_RE.test(plaidItemPk)) {
    return { error: "Invalid plaidItemPk" };
  }

  const updated = await db
    .update(plaidItems)
    .set({
      status: "active",
      errorCode: null,
      errorMessage: null,
      updatedAt: new Date(),
    })
    .where(eq(plaidItems.id, plaidItemPk))
    .returning({ id: plaidItems.id });
  if (updated.length === 0) {
    return { error: "Plaid Item not found" };
  }

  await syncPlaidItemQueue.add(
    "sync-plaid-item",
    { plaidItemPk, trigger: "manual" },
    { jobId: `sync-plaid-item-reauth-${plaidItemPk}-${Date.now()}` },
  );

  revalidatePath("/settings/connections");
  return {};
}

/* ---------------------------------------------------------------------------
 * P4-28 — forceSyncAction
 * --------------------------------------------------------------------------- */

export interface ForceSyncResult {
  error?: string;
}

/**
 * P4-28 — Manually trigger a `/transactions/sync` for an Item.
 *
 * Used by the connections page's "Force sync now" button. Behaves identically
 * to a webhook-triggered sync: the worker loads the cursor and pulls whatever
 * Plaid has waiting. Useful when:
 *   - The user just enabled a new account at their bank and wants it pulled
 *     before the next webhook fires (Plaid sometimes batches up to ~30 min).
 *   - A previous sync errored and we want to retry on demand instead of
 *     waiting for the 03:00 cron (P4-27).
 *
 * The jobId is Date.now-suffixed so successive clicks each enqueue a separate
 * job (cron + reauth use the same pattern). The worker's concurrency=1 +
 * cursor-based idempotency means a queued backlog drains safely.
 */
export async function forceSyncAction(plaidItemPk: string): Promise<ForceSyncResult> {
  await requireUser();
  if (!UUID_RE.test(plaidItemPk)) {
    return { error: "Invalid plaidItemPk" };
  }

  const [item] = await db
    .select({ id: plaidItems.id, status: plaidItems.status })
    .from(plaidItems)
    .where(eq(plaidItems.id, plaidItemPk))
    .limit(1);
  if (!item) return { error: "Plaid Item not found" };
  if (item.status === "removed") return { error: "Item is disconnected" };
  if (item.status === "login_required" || item.status === "revoked") {
    return { error: "Reconnect this Item before forcing a sync" };
  }

  await syncPlaidItemQueue.add(
    "sync-plaid-item",
    { plaidItemPk, trigger: "manual" },
    { jobId: `sync-plaid-item-manual-${plaidItemPk}-${Date.now()}` },
  );

  revalidatePath("/settings/connections");
  return {};
}

/* ---------------------------------------------------------------------------
 * P4-26 — disconnectItemAction
 * --------------------------------------------------------------------------- */

export interface DisconnectItemResult {
  error?: string;
}

/**
 * Tear down a Plaid Item.
 *
 *   1. Call Plaid `/item/remove`. Best-effort — if Plaid errors, log + continue.
 *      The local state is what matters; we never want a Plaid hiccup to leave
 *      the user stuck on a half-disconnected Item.
 *   2. UPDATE plaid_items SET status='removed' and call clearAccessToken to
 *      wipe the now-dead ciphertext (see src/lib/plaid/tokens.ts).
 *   3. For every account linked to this Item: NULL out plaid_item_id,
 *      plaid_account_id, plaid_mask. The `transactions` and
 *      `account_snapshots` rows STAY — preserving history is the whole product
 *      (CLAUDE.md §Domain Scope).
 *
 * The connections page subsequently filters out `status='removed'` rows but
 * keeps the tombstone for audit. Future webhooks for the removed item_id are
 * handled by the route's `unknownItem` path (we no longer have the live FK).
 */
export async function disconnectItemAction(plaidItemPk: string): Promise<DisconnectItemResult> {
  await requireUser();
  if (!UUID_RE.test(plaidItemPk)) {
    return { error: "Invalid plaidItemPk" };
  }

  // Step 1: best-effort Plaid /item/remove. Load the token before we wipe it.
  let accessToken: string | null = null;
  try {
    accessToken = await loadAccessToken(plaidItemPk);
  } catch {
    // Already missing — the Item may have been partially disconnected before.
    // Continue with the local cleanup; nothing to revoke on Plaid's side.
  }
  if (accessToken) {
    try {
      await plaidClient.itemRemove({ access_token: accessToken });
    } catch (err) {
      // Plaid couldn't process the remove (token already invalid, transient
      // 5xx, etc.). Log to the local error_message and proceed with the
      // local state change — that's what the user actually cares about.
      console.error(
        `[disconnectItemAction] Plaid /item/remove failed for ${plaidItemPk}: ${
          (err as Error).message
        }`,
      );
    }
  }

  // Step 2 + 3: local state in a single transaction.
  try {
    await db.transaction(async (tx) => {
      await tx
        .update(plaidItems)
        .set({
          status: "removed",
          errorCode: null,
          errorMessage: null,
          updatedAt: new Date(),
        })
        .where(eq(plaidItems.id, plaidItemPk));
      await tx
        .update(accounts)
        .set({
          plaidItemId: null,
          plaidAccountId: null,
          plaidMask: null,
          updatedAt: new Date(),
        })
        .where(eq(accounts.plaidItemId, plaidItemPk));
    });
    // Wipe the dead ciphertext after the transaction so a row-update error
    // doesn't leave us with a no-status, no-token Item.
    await clearAccessToken(plaidItemPk);
  } catch (err) {
    return { error: `Failed to disconnect Item: ${(err as Error).message}` };
  }

  revalidatePath("/settings/connections");
  revalidatePath("/");
  return {};
}
