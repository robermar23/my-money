import "server-only";

import { db } from "@/db/client.ts";
import { type Transaction, transactions } from "@/db/schema/index.ts";
import type { AccountId } from "@/lib/types/ids.ts";
import { and, desc, eq, sql } from "drizzle-orm";

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

export async function deleteTransaction(
  transactionId: string,
  accountId: AccountId,
): Promise<void> {
  await db
    .delete(transactions)
    .where(and(eq(transactions.id, transactionId), eq(transactions.accountId, accountId)));
}
