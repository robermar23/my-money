import { db } from "@/db/client.ts";
import { accounts, plaidItems, plaidSyncRuns } from "@/db/schema/index.ts";
import { requireUser } from "@/lib/auth/require-user.ts";
import { desc, inArray, ne, sql } from "drizzle-orm";
import Link from "next/link";
import { DisconnectForm } from "./disconnect-form.tsx";
import { ForceSyncButton } from "./force-sync-button.tsx";
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

/** Row shape for the per-Item sync-runs panel (P4-28). */
interface RecentSyncRun {
  id: string;
  startedAt: Date;
  finishedAt: Date | null;
  addedCount: number;
  modifiedCount: number;
  removedCount: number;
  paginationCount: number;
  trigger: string;
  error: string | null;
}

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
  const recentRunsByItem = new Map<string, RecentSyncRun[]>();
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

    // P4-28 — last 10 sync runs per Item. Per-Item parallel queries hit the
    // (plaid_item_id, started_at DESC) index directly. At 2-3 Items in this
    // single-user app, fan-out beats a window-function CTE for clarity.
    const runLists = await Promise.all(
      itemIds.map(async (id) => {
        const rows = await db
          .select({
            id: plaidSyncRuns.id,
            startedAt: plaidSyncRuns.startedAt,
            finishedAt: plaidSyncRuns.finishedAt,
            addedCount: plaidSyncRuns.addedCount,
            modifiedCount: plaidSyncRuns.modifiedCount,
            removedCount: plaidSyncRuns.removedCount,
            paginationCount: plaidSyncRuns.paginationCount,
            trigger: plaidSyncRuns.trigger,
            error: plaidSyncRuns.error,
          })
          .from(plaidSyncRuns)
          .where(sql`${plaidSyncRuns.plaidItemId} = ${id}`)
          .orderBy(desc(plaidSyncRuns.startedAt))
          .limit(10);
        return [id, rows] as const;
      }),
    );
    for (const [id, rows] of runLists) {
      recentRunsByItem.set(id, rows);
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
            const runs = recentRunsByItem.get(item.id) ?? [];
            // Force sync is meaningful only on healthy Items — disabled (and
            // hidden via the action's guard) for login_required/revoked.
            const forceSyncDisabled = item.status === "login_required" || item.status === "revoked";
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
                    {/* P4-28 — Force sync is the most common manual action. */}
                    <ForceSyncButton plaidItemPk={item.id} disabled={forceSyncDisabled} />
                    {/* P4-25 — amber Reconnect button when the Item needs reauth. */}
                    {item.status === "login_required" && (
                      <LinkButton mode="update" plaidItemPk={item.id} variant="amber" />
                    )}
                    {/* P4-26 — Disconnect button is always available. */}
                    <DisconnectForm plaidItemPk={item.id} />
                  </div>
                </div>
                {/* P4-28 — Last 10 sync runs panel. Collapsed when there are no runs yet. */}
                {runs.length > 0 && <SyncRunsPanel runs={runs} />}
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}

/**
 * P4-28 — Per-Item sync-runs panel. Shows the last 10 `plaid_sync_runs` rows
 * with their counters, trigger, and (if any) error. Rendered as a compact
 * table below each Item so the user can see at a glance whether the last
 * webhook/cron/manual sync actually did anything.
 */
function SyncRunsPanel({ runs }: { runs: RecentSyncRun[] }): React.JSX.Element {
  return (
    <details className="mt-3">
      <summary className="cursor-pointer text-xs text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300">
        Last {runs.length} sync run{runs.length === 1 ? "" : "s"}
      </summary>
      <div className="mt-2 overflow-x-auto rounded border border-zinc-200 dark:border-zinc-800">
        <table className="w-full text-xs">
          <thead className="bg-zinc-50 text-left text-zinc-600 dark:bg-zinc-900 dark:text-zinc-400">
            <tr>
              <th className="px-2 py-1 font-medium">Started</th>
              <th className="px-2 py-1 font-medium">Trigger</th>
              <th className="px-2 py-1 text-right font-medium">+</th>
              <th className="px-2 py-1 text-right font-medium">~</th>
              <th className="px-2 py-1 text-right font-medium">−</th>
              <th className="px-2 py-1 text-right font-medium">Pages</th>
              <th className="px-2 py-1 font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.id} className="border-zinc-100 border-t dark:border-zinc-900">
                <td className="px-2 py-1 text-zinc-700 dark:text-zinc-300">
                  {new Date(r.startedAt).toLocaleString()}
                </td>
                <td className="px-2 py-1 text-zinc-600 dark:text-zinc-400">{r.trigger}</td>
                <td className="px-2 py-1 text-right font-mono text-emerald-700 dark:text-emerald-300">
                  {r.addedCount}
                </td>
                <td className="px-2 py-1 text-right font-mono text-zinc-700 dark:text-zinc-300">
                  {r.modifiedCount}
                </td>
                <td className="px-2 py-1 text-right font-mono text-red-700 dark:text-red-300">
                  {r.removedCount}
                </td>
                <td className="px-2 py-1 text-right font-mono text-zinc-600 dark:text-zinc-400">
                  {r.paginationCount}
                </td>
                <td className="px-2 py-1">
                  {r.error ? (
                    <span className="text-red-700 dark:text-red-300" title={r.error}>
                      failed
                    </span>
                  ) : r.finishedAt ? (
                    <span className="text-emerald-700 dark:text-emerald-300">ok</span>
                  ) : (
                    <span className="text-blue-700 dark:text-blue-300">running</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
