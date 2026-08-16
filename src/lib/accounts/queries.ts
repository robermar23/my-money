import "server-only";

import { db } from "@/db/client.ts";
import {
  type Account,
  type AccountSnapshot,
  type AssetDocument,
  type CreditLine,
  type Holding,
  type HoldingLot,
  type Liability,
  accountSnapshots,
  accounts,
  assetDocuments,
  creditLines,
  holdingLots,
  holdings,
  liabilities,
} from "@/db/schema/index.ts";
import { trigramIlikeAny } from "@/lib/search/predicates.ts";
import { sanitizeSearchTerm } from "@/lib/search/term.ts";
import type { AccountId } from "@/lib/types/ids.ts";
import { asc, desc, eq } from "drizzle-orm";

/**
 * List accounts, optionally narrowed by a free-text trigram filter (Phase 12,
 * P12-10). With no `q` the behavior is unchanged (all accounts, type then name).
 * A provided `q` is sanitized and matched against `name`/`institution`/
 * `description` via the trigram `ILIKE` predicate; a too-short term is ignored
 * (treated as no filter), matching the rest of the search surface.
 *
 * @param opts.q - Optional free-text term to filter by.
 * @returns Accounts ordered by type then name.
 */
export async function listAccounts(opts?: { q?: string }): Promise<Account[]> {
  const term = sanitizeSearchTerm(opts?.q);
  const where = term
    ? trigramIlikeAny([accounts.name, accounts.institution, accounts.description], term)
    : undefined;
  return db.select().from(accounts).where(where).orderBy(asc(accounts.type), asc(accounts.name));
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

/**
 * The revolving terms of a credit-card account (Phase 15, P15-30).
 *
 * The exact shape of `getLiability` above, for the revolving twin of that table:
 * `credit_lines.account_id` is UNIQUE, so an account has zero or one row.
 * `undefined` means terms have never been entered — which the engine reports as
 * `unknown_input` rather than as a 0% card (ADR-032 consequence 1).
 *
 * @param id - The account UUID.
 * @returns The terms row, or undefined when none has been entered.
 */
export async function getCreditLine(id: AccountId): Promise<CreditLine | undefined> {
  const [row] = await db.select().from(creditLines).where(eq(creditLines.accountId, id)).limit(1);
  return row;
}

/** Proof-document metadata, newest-first. Excludes the heavy `bytes` column. */
export type AssetDocumentMeta = Omit<AssetDocument, "bytes">;

/**
 * List an asset's proof-of-authenticity documents (Phase 10, P10-07), newest
 * first. Deliberately omits the `bytes` bytea column — the list view only needs
 * metadata; the bytes load lazily through the download route (P10-10).
 *
 * @param id - The owning account UUID.
 * @returns Document metadata rows (no file content), newest upload first.
 */
export async function getAssetDocuments(id: AccountId): Promise<AssetDocumentMeta[]> {
  return db
    .select({
      id: assetDocuments.id,
      accountId: assetDocuments.accountId,
      filename: assetDocuments.filename,
      mimeType: assetDocuments.mimeType,
      sizeBytes: assetDocuments.sizeBytes,
      description: assetDocuments.description,
      uploadedAt: assetDocuments.uploadedAt,
    })
    .from(assetDocuments)
    .where(eq(assetDocuments.accountId, id))
    .orderBy(desc(assetDocuments.uploadedAt));
}
