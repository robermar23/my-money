import { db } from "@/db/client.ts";
import { accounts, plaidItems } from "@/db/schema/index.ts";
import { requireUser } from "@/lib/auth/require-user.ts";
import { type PlaidAccountSummary, listPlaidAccounts } from "@/lib/plaid/list-accounts.ts";
import { mapPlaidAccountType } from "@/lib/plaid/map-types.ts";
import { loadAccessToken } from "@/lib/plaid/tokens.ts";
import { eq, isNull } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { MapAccountsForm } from "./map-form.tsx";

/**
 * Account-mapping page (P4-13).
 *
 * Server component:
 *   - Loads the plaid_items row + decrypted access_token.
 *   - Calls /accounts/get to enumerate accounts the user just consented to.
 *   - Loads existing my-money accounts that are not yet linked to a Plaid
 *     Item, so each row's "Link to existing" dropdown can be type-filtered
 *     client-side.
 *   - Renders a form that submits to mapAccountsAction.
 */

interface PageProps {
  params: Promise<{ plaidItemId: string }>;
}

export default async function MapAccountsPage(props: PageProps): Promise<React.JSX.Element> {
  await requireUser();
  const { plaidItemId: plaidItemPk } = await props.params;

  const [item] = await db
    .select({
      id: plaidItems.id,
      institutionName: plaidItems.institutionName,
      plaidItemId: plaidItems.plaidItemId,
      productsConsented: plaidItems.productsConsented,
    })
    .from(plaidItems)
    .where(eq(plaidItems.id, plaidItemPk))
    .limit(1);
  if (!item) notFound();

  const accessToken = await loadAccessToken(item.id);

  // Enumerate the Plaid accounts. /accounts/get can fail for legitimate
  // reasons — most commonly PRODUCT_NOT_READY (Plaid is still preparing the
  // Item's data right after Link). For an investments Item that's expected:
  // /accounts/get only succeeds once *some* product is ready, but
  // /investments/holdings/get both returns the accounts AND forces the
  // investments product to initialize. We fall back to it; any other failure
  // (or a still-not-ready holdings call) renders an actionable message.
  let plaidAccounts: PlaidAccountSummary[];
  try {
    plaidAccounts = await listPlaidAccounts(accessToken, item.productsConsented);
  } catch (err) {
    const { code, message } = plaidError(err);
    // Never logs the access token — only Plaid's error envelope fields.
    console.error(
      `[map] account enumeration failed for item ${item.id}: ${code ?? "?"} ${message}`,
    );
    return (
      <MapAccountsError institutionName={item.institutionName} code={code} message={message} />
    );
  }

  // Existing unlinked accounts the user can target.
  const candidates = await db
    .select({
      id: accounts.id,
      name: accounts.name,
      type: accounts.type,
      institution: accounts.institution,
    })
    .from(accounts)
    .where(isNull(accounts.plaidAccountId));

  const rows = plaidAccounts.map((pa) => {
    const mappedType = mapPlaidAccountType(pa);
    const eligibleExisting = mappedType ? candidates.filter((c) => c.type === mappedType) : [];
    return {
      plaidAccountId: pa.account_id,
      name: pa.name,
      officialName: pa.official_name ?? null,
      type: pa.type,
      subtype: pa.subtype ?? null,
      mask: pa.mask ?? null,
      mappedType,
      eligibleExisting,
    };
  });

  return (
    <main className="mx-auto max-w-2xl p-6">
      <Link href="/settings/connections" className="text-sm text-zinc-500 hover:underline">
        ← Connections
      </Link>
      <h1 className="mt-2 font-semibold text-2xl tracking-tight">
        Map {item.institutionName} accounts
      </h1>
      <p className="mt-1 text-sm text-zinc-500">
        Plaid returned {plaidAccounts.length} account
        {plaidAccounts.length === 1 ? "" : "s"}. For each one, link it to an existing my-money
        account (preserves history), create a fresh account, or skip.
      </p>

      <div className="mt-6">
        <MapAccountsForm plaidItemPk={item.id} rows={rows} />
      </div>
    </main>
  );
}

/** Extract Plaid's error_code/error_message from an axios-style rejection (no secrets). */
function plaidError(err: unknown): { code: string | null; message: string } {
  const e = err as {
    response?: { data?: { error_code?: string; error_message?: string } };
    message?: string;
  };
  return {
    code: e.response?.data?.error_code ?? null,
    message: e.response?.data?.error_message ?? e.message ?? "Unknown Plaid error",
  };
}

/**
 * Friendly error state when /accounts/get fails. PRODUCT_NOT_READY is the
 * expected transient right after Link (Plaid is still pulling the product) —
 * a refresh usually resolves it within a minute. Other codes (e.g.
 * ITEM_LOGIN_REQUIRED) need a reconnect from the connections page.
 */
function MapAccountsError({
  institutionName,
  code,
  message,
}: {
  institutionName: string;
  code: string | null;
  message: string;
}): React.JSX.Element {
  const isNotReady = code === "PRODUCT_NOT_READY";
  return (
    <main className="mx-auto max-w-2xl p-6">
      <Link href="/settings/connections" className="text-sm text-zinc-500 hover:underline">
        ← Connections
      </Link>
      <h1 className="mt-2 font-semibold text-2xl tracking-tight">Map {institutionName} accounts</h1>
      <div className="mt-6 rounded-lg border border-amber-300 bg-amber-50 p-4 text-amber-900 text-sm dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
        <p className="font-medium">Couldn't load accounts from Plaid.</p>
        {code && <p className="mt-1 font-mono text-xs">{code}</p>}
        <p className="mt-1">{message}</p>
        {isNotReady ? (
          <p className="mt-3">
            Plaid is still preparing this institution's data — this is normal right after connecting
            (investments accounts especially). Wait a moment and refresh.
          </p>
        ) : (
          <p className="mt-3">
            If this persists, reconnect the institution from the connections page.
          </p>
        )}
        <div className="mt-4 flex gap-3">
          {/* Reloads the page → re-runs /accounts/get. */}
          <a
            href="?"
            className="rounded-md bg-amber-600 px-3 py-1.5 font-medium text-sm text-white hover:bg-amber-700"
          >
            Retry
          </a>
          <Link
            href="/settings/connections"
            className="rounded-md border border-amber-400 px-3 py-1.5 font-medium text-sm hover:bg-amber-100 dark:hover:bg-amber-900"
          >
            Back to connections
          </Link>
        </div>
      </div>
    </main>
  );
}
