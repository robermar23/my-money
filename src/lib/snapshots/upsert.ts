import "server-only";

import { type Db, db } from "@/db/client.ts";
import { accountSnapshots } from "@/db/schema/index.ts";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * P4-21 — Centralized `account_snapshots` UPSERT.
 *
 * Both the QFX importer (Phase 3) and the Plaid sync worker (Phase 4) write
 * one row per (account_id, date). The UNIQUE constraint guarantees a single
 * row per day per account; ON CONFLICT DO UPDATE keeps the most-recently-
 * computed balance authoritative.
 *
 * This helper lives in `src/lib/snapshots/` (not under importers/) so the
 * sync worker can reuse it without pulling QFX-specific code into its
 * dependency tree.
 *
 * Pass a transaction handle (`tx`) when calling inside an outer transaction;
 * the default `db` shorthand is here for ad-hoc call sites.
 */
export async function upsertSnapshots(
  accountId: string,
  balancesByDate: ReadonlyMap<string, string>,
  txOrDb: Tx | Db = db,
): Promise<void> {
  for (const [date, balance] of balancesByDate.entries()) {
    await txOrDb
      .insert(accountSnapshots)
      .values({ accountId, date, balance })
      .onConflictDoUpdate({
        target: [accountSnapshots.accountId, accountSnapshots.date],
        set: { balance },
      });
  }
}
