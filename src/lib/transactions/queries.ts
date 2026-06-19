import "server-only";

import { db } from "@/db/client.ts";
import { type Transaction, accounts, transactions } from "@/db/schema/index.ts";
import { normalizePayee } from "@/lib/importers/normalize.ts";
import { Money } from "@/lib/money/money.ts";
import type { AccountId } from "@/lib/types/ids.ts";
import { and, desc, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";

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

/** A transaction row joined with its account name, for cross-account lists. */
export interface TransactionWithAccount extends Transaction {
  readonly accountName: string;
}

export interface ListByCategoryArgs {
  readonly categoryId: string;
  /** Inclusive start date, `YYYY-MM-DD`. */
  readonly from: string;
  /** Inclusive end date, `YYYY-MM-DD`. */
  readonly to: string;
  readonly accountIds?: readonly string[];
  readonly page?: number;
  readonly pageSize?: number;
}

/**
 * Paginated transactions for a single category over a date range, across all
 * accounts (or a filtered subset), newest first. Powers the category drill-down
 * (P8-15). Each row carries its account name so the list is legible without a
 * second lookup.
 *
 * @param args - Category id + inclusive range + optional account filter + paging.
 * @returns Page of rows + paging metadata.
 */
export async function listTransactionsForCategory(args: ListByCategoryArgs): Promise<{
  rows: readonly TransactionWithAccount[];
  totalCount: number;
  page: number;
  pageSize: number;
  totalPages: number;
}> {
  const safePage = Math.max(1, args.page ?? 1);
  const safePageSize = Math.min(200, Math.max(10, args.pageSize ?? 50));
  const offset = (safePage - 1) * safePageSize;

  const where = and(
    eq(transactions.categoryId, args.categoryId),
    gte(transactions.postedAt, args.from),
    lte(transactions.postedAt, args.to),
    args.accountIds && args.accountIds.length > 0
      ? inArray(transactions.accountId, [...args.accountIds])
      : undefined,
  );

  const [rows, [count]] = await Promise.all([
    db
      .select({
        transaction: transactions,
        accountName: accounts.name,
      })
      .from(transactions)
      .innerJoin(accounts, eq(transactions.accountId, accounts.id))
      .where(where)
      .orderBy(desc(transactions.postedAt), desc(transactions.createdAt))
      .limit(safePageSize)
      .offset(offset),
    db.select({ count: sql<number>`COUNT(*)::int` }).from(transactions).where(where),
  ]);

  const totalCount = count?.count ?? 0;
  return {
    rows: rows.map((r) => ({ ...r.transaction, accountName: r.accountName })),
    totalCount,
    page: safePage,
    pageSize: safePageSize,
    totalPages: Math.max(1, Math.ceil(totalCount / safePageSize)),
  };
}

export async function deleteTransaction(
  transactionId: string,
  accountId: AccountId,
): Promise<void> {
  await db
    .delete(transactions)
    .where(and(eq(transactions.id, transactionId), eq(transactions.accountId, accountId)));
}
