import "server-only";

import { db } from "@/db/client.ts";
import {
  type Account,
  type AccountSnapshot,
  type Holding,
  type HoldingLot,
  type Liability,
  accountSnapshots,
  accounts,
  holdingLots,
  holdings,
  liabilities,
} from "@/db/schema/index.ts";
import type { AccountId } from "@/lib/types/ids.ts";
import { asc, desc, eq } from "drizzle-orm";

export async function listAccounts(): Promise<Account[]> {
  return db.select().from(accounts).orderBy(asc(accounts.type), asc(accounts.name));
}

export async function getAccount(id: AccountId): Promise<Account | undefined> {
  const [row] = await db.select().from(accounts).where(eq(accounts.id, id)).limit(1);
  return row;
}

export async function getLatestSnapshot(id: AccountId): Promise<AccountSnapshot | undefined> {
  const [row] = await db
    .select()
    .from(accountSnapshots)
    .where(eq(accountSnapshots.accountId, id))
    .orderBy(desc(accountSnapshots.date))
    .limit(1);
  return row;
}

export async function listSnapshots(id: AccountId): Promise<AccountSnapshot[]> {
  return db
    .select()
    .from(accountSnapshots)
    .where(eq(accountSnapshots.accountId, id))
    .orderBy(desc(accountSnapshots.date));
}

export async function listHoldings(id: AccountId): Promise<Holding[]> {
  return db.select().from(holdings).where(eq(holdings.accountId, id)).orderBy(asc(holdings.symbol));
}

/**
 * All cost-basis lots for an account's holdings, oldest first. Joined through
 * `holdings` so the caller can group by `holdingId` (Phase 5, P5-18/P5-19).
 */
export async function listLots(id: AccountId): Promise<HoldingLot[]> {
  return db
    .select({
      id: holdingLots.id,
      holdingId: holdingLots.holdingId,
      acquiredAt: holdingLots.acquiredAt,
      quantity: holdingLots.quantity,
      costBasisTotal: holdingLots.costBasisTotal,
      source: holdingLots.source,
      plaidInvestmentTransactionId: holdingLots.plaidInvestmentTransactionId,
      note: holdingLots.note,
      createdAt: holdingLots.createdAt,
      updatedAt: holdingLots.updatedAt,
    })
    .from(holdingLots)
    .innerJoin(holdings, eq(holdingLots.holdingId, holdings.id))
    .where(eq(holdings.accountId, id))
    .orderBy(asc(holdingLots.acquiredAt), asc(holdingLots.createdAt));
}

export async function getLiability(id: AccountId): Promise<Liability | undefined> {
  const [row] = await db.select().from(liabilities).where(eq(liabilities.accountId, id)).limit(1);
  return row;
}
