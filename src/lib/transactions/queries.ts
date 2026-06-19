import "server-only";

import { db } from "@/db/client.ts";
import { type Transaction, transactions } from "@/db/schema/index.ts";
import { normalizePayee } from "@/lib/importers/normalize.ts";
import { Money } from "@/lib/money/money.ts";
import type { AccountId } from "@/lib/types/ids.ts";
import { and, desc, eq, isNull, sql } from "drizzle-orm";

export interface ListTransactionsArgs {
  readonly accountId: AccountId;
  readonly page?: number;
  readonly pageSize?: number;
}

export interface ListTransactionsResult {
  readonly rows: readonly Transaction[];
  readonly totalCount: number;
  readonly page: number;
  readonly pageSize: number;
  readonly totalPages: number;
}

export async function listTransactions({
  accountId,
  page = 1,
  pageSize = 50,
}: ListTransactionsArgs): Promise<ListTransactionsResult> {
  const safePage = Math.max(1, page);
  const safePageSize = Math.min(200, Math.max(10, pageSize));
  const offset = (safePage - 1) * safePageSize;

  const [rows, [count]] = await Promise.all([
    db
      .select()
      .from(transactions)
      .where(eq(transactions.accountId, accountId))
      .orderBy(desc(transactions.postedAt), desc(transactions.createdAt))
      .limit(safePageSize)
      .offset(offset),
    db
      .select({ count: sql<number>`COUNT(*)::int` })
      .from(transactions)
      .where(eq(transactions.accountId, accountId)),
  ]);

  const totalCount = count?.count ?? 0;
  return {
    rows,
    totalCount,
    page: safePage,
    pageSize: safePageSize,
    totalPages: Math.max(1, Math.ceil(totalCount / safePageSize)),
  };
}

export async function distinctCategories(): Promise<string[]> {
  const rows = await db
    .selectDistinct({ category: transactions.category })
    .from(transactions)
    .where(sql`${transactions.category} IS NOT NULL`)
    .orderBy(transactions.category);
  return rows.map((r) => r.category as string).filter(Boolean);
}

export async function setCategory(transactionId: string, category: string | null): Promise<void> {
  await db
    .update(transactions)
    .set({
      category,
      categoryOverriddenAt: new Date(),
    })
    .where(eq(transactions.id, transactionId));
}

/** One normalized-payee bucket of uncategorized transactions (P8-09). */
export interface UncategorizedPayeeGroup {
  /** Normalized grouping key (see {@link normalizePayee}). */
  readonly payeeKey: string;
  /** A representative raw name for display. */
  readonly sampleName: string;
  readonly count: number;
  /** Signed sum of amounts in the group, as a Money string (USD assumed). */
  readonly total: string;
  readonly txnIds: readonly string[];
}

/**
 * Group every uncategorized transaction (`category_id IS NULL`) across all
 * accounts by normalized payee, for the bulk "review uncategorized" queue
 * (P8-09). Categorizing a whole group at once — optionally creating a rule — is
 * the fast path out of the "everything is Uncategorized" state.
 *
 * Amounts are summed as USD (the single-user app is USD-dominant); the figure is
 * an at-a-glance magnitude, not a cross-currency-correct total.
 *
 * @param maxGroups - Cap on returned groups (largest by count first).
 * @returns Payee groups sorted by transaction count descending.
 */
export async function listUncategorizedByPayee(
  maxGroups = 200,
): Promise<UncategorizedPayeeGroup[]> {
  const rows = await db
    .select({ id: transactions.id, name: transactions.name, amount: transactions.amount })
    .from(transactions)
    .where(isNull(transactions.categoryId))
    .orderBy(desc(transactions.postedAt));

  const byKey = new Map<string, { sampleName: string; total: Money; txnIds: string[] }>();
  for (const r of rows) {
    const key = normalizePayee(r.name);
    const bucket = byKey.get(key);
    if (bucket) {
      bucket.total = bucket.total.add(Money.fromString(r.amount, "USD"));
      bucket.txnIds.push(r.id);
    } else {
      byKey.set(key, {
        sampleName: r.name,
        total: Money.fromString(r.amount, "USD"),
        txnIds: [r.id],
      });
    }
  }

  return [...byKey.entries()]
    .map(([payeeKey, b]) => ({
      payeeKey,
      sampleName: b.sampleName,
      count: b.txnIds.length,
      total: b.total.toString(),
      txnIds: b.txnIds,
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, maxGroups);
}

export async function deleteTransaction(
  transactionId: string,
  accountId: AccountId,
): Promise<void> {
  await db
    .delete(transactions)
    .where(and(eq(transactions.id, transactionId), eq(transactions.accountId, accountId)));
}
