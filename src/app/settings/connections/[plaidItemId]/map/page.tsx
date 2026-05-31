import { db } from "@/db/client.ts";
import { accounts, plaidItems } from "@/db/schema/index.ts";
import { requireUser } from "@/lib/auth/require-user.ts";
import { plaidClient } from "@/lib/plaid/client.ts";
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
    })
    .from(plaidItems)
    .where(eq(plaidItems.id, plaidItemPk))
    .limit(1);
  if (!item) notFound();

  const accessToken = await loadAccessToken(item.id);
  const accountsResp = await plaidClient.accountsGet({ access_token: accessToken });
  const plaidAccounts = accountsResp.data.accounts;

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
