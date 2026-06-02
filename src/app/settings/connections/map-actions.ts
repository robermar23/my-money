"use server";

import { db } from "@/db/client.ts";
import { accounts, plaidItems } from "@/db/schema/index.ts";
import { requireUser } from "@/lib/auth/require-user.ts";
import { plaidClient } from "@/lib/plaid/client.ts";
import { mapPlaidAccountType } from "@/lib/plaid/map-types.ts";
import { loadAccessToken } from "@/lib/plaid/tokens.ts";
import { syncPlaidItemQueue } from "@/lib/queue/queues.ts";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

/**
 * P4-13 — Account-mapping server action.
 *
 * The mapping page submits one row per Plaid account, encoded into FormData
 * with the keys:
 *
 *   action_<plaidAccountId>      = 'skip' | 'create' | 'link:<accountUuid>'
 *   create_name_<plaidAccountId> = (optional) name override when action='create'
 *
 * On commit:
 *   1. For each 'link:' row: UPDATE accounts SET plaid_item_id, plaid_account_id,
 *      plaid_mask. Existing snapshots/transactions are PRESERVED — that's the
 *      whole point of mapping to an existing account.
 *   2. For each 'create' row: INSERT a new account with the mapped type,
 *      Plaid-supplied name (or override), institution_name from the Item,
 *      currency from the Plaid account's iso_currency_code (fallback USD).
 *   3. Skip rows are no-ops.
 *   4. Enqueue `sync-plaid-item` with trigger='initial' so the worker (P4-18)
 *      pulls historical transactions for every newly-mapped Plaid account.
 *
 * All DB writes happen inside a single transaction so a partial mapping can't
 * land. The Plaid /accounts/get call is the source of truth for what's
 * mappable — we re-fetch on every submission to defeat a stale-form attack.
 */

export interface MapAccountsResult {
  error?: string;
}

const PLAID_ACCOUNT_ID_RE = /^[A-Za-z0-9]{1,80}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function mapAccountsAction(
  plaidItemPk: string,
  formData: FormData,
): Promise<MapAccountsResult> {
  await requireUser();

  if (!UUID_RE.test(plaidItemPk)) {
    return { error: "Invalid plaidItemPk" };
  }

  // 1. Load the Item + its decrypted access token (server-side only).
  const [item] = await db
    .select({
      id: plaidItems.id,
      institutionName: plaidItems.institutionName,
    })
    .from(plaidItems)
    .where(eq(plaidItems.id, plaidItemPk))
    .limit(1);
  if (!item) return { error: "Plaid Item not found" };

  const accessToken = await loadAccessToken(item.id);

  // 2. Re-fetch /accounts/get as the source of truth — never trust the
  //    submitted form to enumerate accounts the user hasn't consented to.
  const accountsResp = await plaidClient.accountsGet({ access_token: accessToken });
  const plaidAccounts = accountsResp.data.accounts;
  const plaidAccountById = new Map(plaidAccounts.map((a) => [a.account_id, a]));

  // 3. Decode the form. For every Plaid account, look up its action key.
  type Mapping =
    | { kind: "skip"; plaidAccountId: string }
    | { kind: "link"; plaidAccountId: string; accountUuid: string }
    | { kind: "create"; plaidAccountId: string; nameOverride: string | null };

  const mappings: Mapping[] = [];
  for (const pa of plaidAccounts) {
    if (!PLAID_ACCOUNT_ID_RE.test(pa.account_id)) {
      return { error: `Unexpected Plaid account_id format: ${pa.account_id.slice(0, 20)}…` };
    }
    const raw = formData.get(`action_${pa.account_id}`);
    if (typeof raw !== "string") {
      return { error: `Missing action for Plaid account ${pa.account_id}` };
    }
    if (raw === "skip") {
      mappings.push({ kind: "skip", plaidAccountId: pa.account_id });
    } else if (raw === "create") {
      const nameOverride = formData.get(`create_name_${pa.account_id}`);
      mappings.push({
        kind: "create",
        plaidAccountId: pa.account_id,
        nameOverride:
          typeof nameOverride === "string" && nameOverride.trim().length > 0
            ? nameOverride.trim()
            : null,
      });
    } else if (raw.startsWith("link:")) {
      const accountUuid = raw.slice("link:".length);
      if (!UUID_RE.test(accountUuid)) {
        return { error: `Invalid account uuid in link selection: ${accountUuid}` };
      }
      mappings.push({ kind: "link", plaidAccountId: pa.account_id, accountUuid });
    } else {
      return { error: `Unknown action '${raw}' for Plaid account ${pa.account_id}` };
    }
  }

  // 4. Validate: a manual account can't be linked to two Plaid accounts.
  const linkTargets = mappings
    .filter((m): m is Extract<Mapping, { kind: "link" }> => m.kind === "link")
    .map((m) => m.accountUuid);
  if (new Set(linkTargets).size !== linkTargets.length) {
    return { error: "Two Plaid accounts mapped to the same existing account" };
  }

  // 5. Single transaction — link UPDATEs + create INSERTs together.
  try {
    await db.transaction(async (tx) => {
      for (const m of mappings) {
        if (m.kind === "skip") continue;
        const pa = plaidAccountById.get(m.plaidAccountId);
        if (!pa) throw new Error(`Plaid account ${m.plaidAccountId} vanished between fetch + map`);
        if (m.kind === "link") {
          // Verify the target is currently unlinked. The UNIQUE constraint on
          // plaid_account_id catches the race-condition path; this gives a
          // friendlier error.
          const [target] = await tx
            .select({ id: accounts.id, plaidItemId: accounts.plaidItemId })
            .from(accounts)
            .where(eq(accounts.id, m.accountUuid))
            .limit(1);
          if (!target) throw new Error(`Target account ${m.accountUuid} not found`);
          if (target.plaidItemId !== null) {
            throw new Error(`Account ${m.accountUuid} is already linked to a Plaid Item`);
          }
          await tx
            .update(accounts)
            .set({
              plaidItemId: item.id,
              plaidAccountId: m.plaidAccountId,
              plaidMask: pa.mask ?? null,
              updatedAt: new Date(),
            })
            .where(eq(accounts.id, m.accountUuid));
        } else {
          const mappedType = mapPlaidAccountType(pa);
          if (!mappedType) {
            throw new Error(
              `Plaid account ${pa.name} has type '${pa.type}' which has no my-money equivalent. Use Skip and add manually.`,
            );
          }
          await tx.insert(accounts).values({
            name: m.nameOverride ?? pa.name,
            institution: item.institutionName,
            type: mappedType,
            currency: pa.balances.iso_currency_code ?? "USD",
            plaidItemId: item.id,
            plaidAccountId: m.plaidAccountId,
            plaidMask: pa.mask ?? null,
          });
        }
      }
    });
  } catch (err) {
    return { error: (err as Error).message };
  }

  // 6. Kick off the initial sync (P4-22).
  await syncPlaidItemQueue.add(
    "sync-plaid-item",
    { plaidItemPk: item.id, trigger: "initial" },
    // jobId pins idempotency — a double-submission can't enqueue two initial syncs.
    { jobId: `sync-plaid-item-initial-${item.id}` },
  );

  revalidatePath("/settings/connections");
  revalidatePath("/");
  // Land on the polling progress page (P4-23) so the user sees the initial
  // sync tick up to completion before bouncing to the dashboard.
  redirect(`/settings/connections/${item.id}/progress`);
}
