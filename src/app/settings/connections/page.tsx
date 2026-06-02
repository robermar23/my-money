import { db } from "@/db/client.ts";
import { accounts, plaidItems } from "@/db/schema/index.ts";
import { requireUser } from "@/lib/auth/require-user.ts";
import { desc, inArray, ne } from "drizzle-orm";
import Link from "next/link";
import { DisconnectForm } from "./disconnect-form.tsx";
import { LinkButton } from "./link-button.tsx";

/**
 * Settings → Connections page (P4-11).
 *
 * Lists every Plaid Item the user has connected and the accounts mapped to
 * each, plus a "Connect new institution" CTA that opens Plaid Link.
 *
 * Per CLAUDE.md §Plaid Safety Rules: this server component MUST NOT SELECT
 * the encrypted-token column. Decryption is reachable only via
 * loadAccessToken() in src/lib/plaid/tokens.ts.
 */

function statusBadge(status: string): React.JSX.Element {
  const styles: Record<string, string> = {
    active: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200",
    login_required: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200",
    pending_disconnect: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200",
    revoked: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200",
    removed: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400",
  };
  const label =
    status === "login_required"
      ? "Reconnect needed"
      : status === "pending_disconnect"
        ? "Pending disconnect"
        : status === "revoked"
          ? "Revoked"
          : status === "removed"
            ? "Removed"
            : "Active";
  return (
    <span className={`rounded px-2 py-0.5 font-medium text-xs ${styles[status] ?? styles.removed}`}>
      {label}
    </span>
  );
}

export default async function ConnectionsPage(): Promise<React.JSX.Element> {
  await requireUser();

  // Explicit field allowlist — the encrypted-token column is deliberately
  // omitted (the visibility regression in tokens.test.ts enforces it).
  const items = await db
    .select({
      id: plaidItems.id,
      plaidItemId: plaidItems.plaidItemId,
      institutionName: plaidItems.institutionName,
      status: plaidItems.status,
      errorCode: plaidItems.errorCode,
      lastSyncedAt: plaidItems.lastSyncedAt,
      lastWebhookAt: plaidItems.lastWebhookAt,
      createdAt: plaidItems.createdAt,
    })
    .from(plaidItems)
    .where(ne(plaidItems.status, "removed"))
    .orderBy(desc(plaidItems.createdAt));

  const linkedAccountsByItem = new Map<
    string,
    { id: string; name: string; mask: string | null }[]
  >();
  if (items.length > 0) {
    const itemIds = items.map((i) => i.id);
    const allLinked = await db
      .select({
        plaidItemId: accounts.plaidItemId,
        id: accounts.id,
        name: accounts.name,
        plaidMask: accounts.plaidMask,
      })
      .from(accounts)
      .where(inArray(accounts.plaidItemId, itemIds));
    for (const a of allLinked) {
      if (!a.plaidItemId) continue;
      const arr = linkedAccountsByItem.get(a.plaidItemId) ?? [];
      arr.push({ id: a.id, name: a.name, mask: a.plaidMask });
      linkedAccountsByItem.set(a.plaidItemId, arr);
    }
  }

  return (
    <main className="mx-auto max-w-3xl p-6">
      <div className="flex items-center justify-between">
        <div>
          <Link href="/" className="text-sm text-zinc-500 hover:underline">
            ← Dashboard
          </Link>
          <h1 className="mt-2 font-semibold text-2xl tracking-tight">Bank connections</h1>
          <p className="mt-1 text-sm text-zinc-500">
            Plaid sync your bank, brokerage, and credit-card accounts. Transactions land within
            minutes of posting; the QFX import path remains a fallback for institutions Plaid
            doesn't cover.
          </p>
        </div>
        <LinkButton />
      </div>

      {items.length === 0 ? (
        <p className="mt-8 rounded-lg border border-zinc-200 bg-zinc-50 p-6 text-sm text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
          No connections yet. Click <strong>Connect new institution</strong> to link your first
          bank.
        </p>
      ) : (
        <ul className="mt-8 divide-y divide-zinc-100 dark:divide-zinc-900">
          {items.map((item) => {
            const linked = linkedAccountsByItem.get(item.id) ?? [];
            return (
              <li key={item.id} className="py-4">
                <div className="flex items-start justify-between">
                  <div>
                    <div className="flex items-center gap-2">
                      <h3 className="font-medium">{item.institutionName}</h3>
                      {statusBadge(item.status)}
                    </div>
                    <p className="mt-1 font-mono text-xs text-zinc-500">{item.plaidItemId}</p>
                    {item.errorCode && (
                      <p className="mt-1 text-red-600 text-xs dark:text-red-400">
                        {item.errorCode}
                      </p>
                    )}
                    {linked.length > 0 ? (
                      <ul className="mt-2 space-y-0.5 text-sm text-zinc-700 dark:text-zinc-300">
                        {linked.map((a) => (
                          <li key={a.id}>
                            {a.name}
                            {a.mask && (
                              <span className="ml-2 font-mono text-xs text-zinc-500">
                                ····{a.mask}
                              </span>
                            )}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="mt-2 text-amber-700 text-sm dark:text-amber-300">
                        No accounts mapped yet —{" "}
                        <Link href={`/settings/connections/${item.id}/map`} className="underline">
                          finish setup
                        </Link>
                        .
                      </p>
                    )}
                    <p className="mt-2 text-xs text-zinc-500">
                      Last synced:{" "}
                      {item.lastSyncedAt ? new Date(item.lastSyncedAt).toLocaleString() : "never"}
                      {" · "}
                      Last webhook:{" "}
                      {item.lastWebhookAt ? new Date(item.lastWebhookAt).toLocaleString() : "never"}
                    </p>
                  </div>
                  <div className="ml-4 flex shrink-0 flex-col items-end gap-2">
                    {/* P4-25 — amber Reconnect button when the Item needs reauth. */}
                    {item.status === "login_required" && (
                      <LinkButton mode="update" plaidItemPk={item.id} variant="amber" />
                    )}
                    {/* P4-26 — Disconnect button is always available. */}
                    <DisconnectForm plaidItemPk={item.id} />
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
