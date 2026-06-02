"use server";

import { db } from "@/db/client.ts";
import { plaidItems, plaidSyncRuns, transactions } from "@/db/schema/index.ts";
import { requireUser } from "@/lib/auth/require-user.ts";
import { count, desc, eq, isNull, sql } from "drizzle-orm";

/**
 * P4-23 — Progress polling.
 *
 * Returns a tiny snapshot of an Item's current sync state. The client
 * component polls this every 3 seconds while an initial sync is running:
 *   - `syncing`: at least one plaid_sync_runs row exists with finished_at IS NULL
 *   - `active`:  no in-flight run, status === 'active'
 *   - other Item statuses (login_required, revoked, etc.) flow through verbatim
 *     so the client can display the right next step
 *
 * `transactionsCount` is the cumulative number of Plaid-sourced transactions
 * for the accounts under this Item — the "X transactions synced" headline.
 *
 * `latestRun` is the most-recent sync_run row's counters/state — used to
 * surface the in-progress added/modified/removed totals.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SyncProgressSnapshot {
  status: "syncing" | "active" | "login_required" | "pending_disconnect" | "revoked" | "removed";
  transactionsCount: number;
  latestRun: {
    id: string;
    startedAt: string;
    finishedAt: string | null;
    addedCount: number;
    modifiedCount: number;
    removedCount: number;
    paginationCount: number;
    trigger: string;
    error: string | null;
  } | null;
}

export async function getSyncProgressAction(plaidItemPk: string): Promise<SyncProgressSnapshot> {
  await requireUser();
  if (!UUID_RE.test(plaidItemPk)) {
    throw new Error("Invalid plaidItemPk");
  }

  // 1. Item status + the inflight check.
  const [item] = await db
    .select({ status: plaidItems.status })
    .from(plaidItems)
    .where(eq(plaidItems.id, plaidItemPk))
    .limit(1);
  if (!item) {
    throw new Error("Plaid Item not found");
  }

  const [inflight] = await db
    .select({ count: count() })
    .from(plaidSyncRuns)
    .where(
      sql`${plaidSyncRuns.plaidItemId} = ${plaidItemPk} AND ${isNull(plaidSyncRuns.finishedAt)}`,
    );

  const isSyncing = (inflight?.count ?? 0) > 0;

  // 2. Latest run (whether in-flight or finished).
  const [latest] = await db
    .select()
    .from(plaidSyncRuns)
    .where(eq(plaidSyncRuns.plaidItemId, plaidItemPk))
    .orderBy(desc(plaidSyncRuns.startedAt))
    .limit(1);

  // 3. Plaid-sourced transactions for accounts under this Item.
  const [{ n } = { n: 0 }] = await db
    .select({
      n: sql<number>`COUNT(*)::int`,
    })
    .from(transactions)
    .where(
      sql`${transactions.source} = 'plaid' AND ${transactions.accountId} IN (
        SELECT id FROM accounts WHERE plaid_item_id = ${plaidItemPk}
      )`,
    );

  const resolvedStatus =
    isSyncing && item.status === "active"
      ? "syncing"
      : (item.status as SyncProgressSnapshot["status"]);

  return {
    status: resolvedStatus,
    transactionsCount: Number(n),
    latestRun: latest
      ? {
          id: latest.id,
          startedAt: latest.startedAt.toISOString(),
          finishedAt: latest.finishedAt ? latest.finishedAt.toISOString() : null,
          addedCount: latest.addedCount,
          modifiedCount: latest.modifiedCount,
          removedCount: latest.removedCount,
          paginationCount: latest.paginationCount,
          trigger: latest.trigger,
          error: latest.error,
        }
      : null,
  };
}
