import "server-only";

import { db } from "@/db/client.ts";
import {
  type Account,
  type AccountSnapshot,
  type Holding,
  type Liability,
  accountSnapshots,
  accounts,
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

export async function getLiability(id: AccountId): Promise<Liability | undefined> {
  const [row] = await db.select().from(liabilities).where(eq(liabilities.accountId, id)).limit(1);
  return row;
}
