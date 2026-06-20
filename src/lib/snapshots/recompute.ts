import "server-only";

import { type Db, db } from "@/db/client.ts";
import { transactions } from "@/db/schema/index.ts";
import { and, eq, lte, sql } from "drizzle-orm";
import { upsertSnapshots } from "./upsert.ts";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * P7-07 — Shared affected-date snapshot recompute.
 *
 * For each requested date, compute the cumulative balance from the account's
 * transactions (`SUM(amount) WHERE posted_at <= date`) and UPSERT it into
 * `account_snapshots`. This is the exact logic the Plaid sync used as its
 * affected-dates fallback (when a live balance anchor isn't available); it is
 * now shared so the manual transaction delete/edit actions (P7-08/P7-09)
 * recompute identically rather than duplicating the math.
 *
 * Sign convention: `transactions.amount` is stored in OFX convention (positive
 * = inflow, negative = outflow), so the running sum is already net-worth-signed
 * for depository accounts. Credit-card accounts store the same convention and
 * the read paths handle display sign; no negation happens here.
 *
 * @param accountId - The owning account UUID.
 * @param dates - The set of `YYYY-MM-DD` dates to recompute (typically the
 *   posted dates touched by a delete/edit).
 * @param txOrDb - Active DB transaction handle when called inside one; defaults
 *   to the shared client for ad-hoc call sites.
 */
export async function recomputeAccountSnapshotsForDates(
  accountId: string,
  dates: ReadonlySet<string>,
  txOrDb: Tx | Db = db,
): Promise<void> {
  if (dates.size === 0) return;
  const balancesByDate = new Map<string, string>();
  for (const date of dates) {
    const [row] = await txOrDb
      .select({ balance: sql<string>`COALESCE(SUM(${transactions.amount})::text, '0')` })
      .from(transactions)
      .where(and(eq(transactions.accountId, accountId), lte(transactions.postedAt, date)));
    balancesByDate.set(date, formatMoney(row?.balance ?? "0"));
  }
  await upsertSnapshots(accountId, balancesByDate, txOrDb);
}

/**
 * Normalize a Postgres `SUM(numeric)` text result to a canonical 2-decimal
 * string. A zero-sum returns "0" (no decimal point); non-zero sums come back
 * as "12.34" / "-100.00".
 */
function formatMoney(raw: string): string {
  if (!raw.includes(".")) return `${raw}.00`;
  const [int, frac] = raw.split(".");
  return `${int}.${(frac ?? "00").padEnd(2, "0").slice(0, 2)}`;
}
