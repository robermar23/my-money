import "server-only";

import { db } from "@/db/client.ts";
import {
  type CategoryRule,
  type NewTransaction,
  accounts,
  categoryRules,
  importBatches,
  transactions,
} from "@/db/schema/index.ts";
import { matchCategory, sortRules } from "@/lib/categorization/match.ts";
import { seedDefaultRulesIfEmpty } from "@/lib/categorization/seed.ts";
import { upsertSnapshots } from "@/lib/snapshots/upsert.ts";
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { NormalizedBatch, NormalizedTransaction } from "./normalize.ts";
import { computeRunningBalances, reconcile } from "./reconcile.ts";

export interface PreviewBuckets {
  /** Rows that would be inserted on confirm. */
  readonly newTransactions: readonly PreviewRow[];
  /** Rows already present (by fitid) — would be skipped on confirm. */
  readonly duplicates: readonly PreviewRow[];
  /** Rows that failed validation. */
  readonly invalid: readonly InvalidRow[];
}

export interface PreviewRow {
  readonly fitid: string;
  readonly postedAt: string;
  readonly amount: string;
  readonly name: string;
  readonly memo: string | null;
  readonly category: string | null;
}

export interface InvalidRow {
  readonly fitid: string;
  readonly reason: string;
  readonly raw: Record<string, unknown>;
}

export interface PersistResult {
  readonly insertedCount: number;
  readonly duplicateCount: number;
  readonly invalidCount: number;
}

/**
 * Build the preview buckets for a normalized batch without writing anything.
 *
 * Runs the categorization engine so the preview shows the categories that
 * will land. Performs one bulk fitid lookup against the DB to bucket new vs.
 * duplicate.
 */
export async function buildPreview(
  accountId: string,
  normalized: NormalizedBatch,
): Promise<PreviewBuckets> {
  // Seed default rules on first ever import (cheap idempotent check).
  await seedDefaultRulesIfEmpty();

  const rules = sortRules(await db.select().from(categoryRules));

  const { valid, invalid } = validate(normalized.transactions);

  if (valid.length === 0) {
    return { newTransactions: [], duplicates: [], invalid };
  }

  // Bulk fitid lookup (chunked to keep parameter count modest on huge backfills).
  const existing = await bulkExistingFitids(
    accountId,
    valid.map((t) => t.fitid),
  );

  const newRows: PreviewRow[] = [];
  const dupes: PreviewRow[] = [];
  for (const t of valid) {
    const row: PreviewRow = {
      fitid: t.fitid,
      postedAt: t.postedAt,
      amount: t.amount,
      name: t.name,
      memo: t.memo,
      category: matchCategory(t.name, t.memo, rules),
    };
    if (existing.has(t.fitid)) {
      dupes.push(row);
    } else {
      newRows.push(row);
    }
  }

  return { newTransactions: newRows, duplicates: dupes, invalid };
}

/**
 * Persist a previewed batch.
 *
 * - Wraps the txns insert + batch status update in one Drizzle transaction
 *   so a failure leaves the DB unchanged.
 * - INSERT ... ON CONFLICT (account_id, fitid) DO NOTHING — re-runs are no-ops.
 * - Writes one account_snapshots row per distinct posted_at in the batch via
 *   running-balance computation, and an authoritative row at statement_end
 *   matching the file's LEDGERBAL.
 */
export async function persistImportBatch(batchId: string): Promise<PersistResult> {
  const [batch] = await db.select().from(importBatches).where(eq(importBatches.id, batchId));
  if (!batch) throw new Error(`Import batch ${batchId} not found`);
  if (batch.status === "confirmed") {
    return {
      insertedCount: batch.insertedCount,
      duplicateCount: batch.duplicateCount,
      invalidCount: batch.invalidCount,
    };
  }
  if (batch.status !== "previewed") {
    throw new Error(`Cannot confirm batch ${batchId} in status '${batch.status}'`);
  }

  const normalized = batch.parsedPayload as NormalizedBatch | null;
  if (!normalized) throw new Error(`Batch ${batchId} has no parsed_payload`);

  const [account] = await db.select().from(accounts).where(eq(accounts.id, batch.accountId));
  if (!account) throw new Error(`Account ${batch.accountId} not found`);

  // Re-run the preview so categories are fresh (rules may have changed
  // between preview and confirm).
  const preview = await buildPreview(batch.accountId, normalized);

  const inserts: NewTransaction[] = preview.newTransactions.map((r) => ({
    accountId: batch.accountId,
    postedAt: r.postedAt,
    amount: r.amount,
    name: r.name,
    memo: r.memo,
    category: r.category,
    fitid: r.fitid,
    source: normalized.source,
    importBatchId: batch.id,
    raw: findRaw(normalized, r.fitid),
  }));

  // Running balances for snapshot writes.
  const runningBalances = await computeRunningBalances(batch, normalized, account.currency);

  await db.transaction(async (tx) => {
    if (inserts.length > 0) {
      // Drizzle's onConflictDoNothing operates on unique constraints; bind it
      // to the (account_id, fitid) unique index.
      await tx
        .insert(transactions)
        .values(inserts)
        .onConflictDoNothing({ target: [transactions.accountId, transactions.fitid] });
    }

    // Snapshot upserts — one per distinct posted_at + the statement_end row.
    // Both pass through the shared helper in src/lib/snapshots/upsert.ts.
    await upsertSnapshots(batch.accountId, runningBalances, tx);
    if (batch.statementEnd && batch.statementEndingBalance) {
      await upsertSnapshots(
        batch.accountId,
        new Map([[batch.statementEnd, batch.statementEndingBalance]]),
        tx,
      );
    }

    await tx
      .update(importBatches)
      .set({
        status: "confirmed",
        confirmedAt: new Date(),
        insertedCount: preview.newTransactions.length,
        duplicateCount: preview.duplicates.length,
        invalidCount: preview.invalid.length,
      })
      .where(eq(importBatches.id, batch.id));
  });

  return {
    insertedCount: preview.newTransactions.length,
    duplicateCount: preview.duplicates.length,
    invalidCount: preview.invalid.length,
  };
}

/**
 * Re-evaluate category rules over existing transactions whose category was
 * NOT manually overridden. Returns number of rows updated.
 *
 * Used by the "Re-categorize existing transactions" button on the rules page.
 */
export async function recategorizeAll(): Promise<number> {
  const rules = sortRules(await db.select().from(categoryRules));
  const rows = await db
    .select({
      id: transactions.id,
      name: transactions.name,
      memo: transactions.memo,
      category: transactions.category,
    })
    .from(transactions)
    .where(isNull(transactions.categoryOverriddenAt));

  let updated = 0;
  for (const r of rows) {
    const newCategory = matchCategory(r.name, r.memo, rules);
    if (newCategory !== r.category) {
      await db.update(transactions).set({ category: newCategory }).where(eq(transactions.id, r.id));
      updated++;
    }
  }
  return updated;
}

// --- helpers ---

function validate(txns: readonly NormalizedTransaction[]): {
  valid: NormalizedTransaction[];
  invalid: InvalidRow[];
} {
  const valid: NormalizedTransaction[] = [];
  const invalid: InvalidRow[] = [];
  const seenFitids = new Set<string>();
  for (const t of txns) {
    if (!t.fitid) {
      invalid.push({ fitid: "", reason: "Missing fitid", raw: t.raw });
      continue;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(t.postedAt)) {
      invalid.push({ fitid: t.fitid, reason: `Bad postedAt '${t.postedAt}'`, raw: t.raw });
      continue;
    }
    if (!/^-?\d+(\.\d+)?$/.test(t.amount)) {
      invalid.push({ fitid: t.fitid, reason: `Bad amount '${t.amount}'`, raw: t.raw });
      continue;
    }
    if (seenFitids.has(t.fitid)) {
      // Two rows in the same batch with the same FITID — second one is dropped.
      invalid.push({ fitid: t.fitid, reason: "Duplicate fitid within batch", raw: t.raw });
      continue;
    }
    seenFitids.add(t.fitid);
    valid.push(t);
  }
  return { valid, invalid };
}

async function bulkExistingFitids(
  accountId: string,
  fitids: readonly string[],
): Promise<Set<string>> {
  const chunkSize = 500;
  const found = new Set<string>();
  for (let i = 0; i < fitids.length; i += chunkSize) {
    const slice = fitids.slice(i, i + chunkSize);
    if (slice.length === 0) continue;
    const rows = await db
      .select({ fitid: transactions.fitid })
      .from(transactions)
      .where(and(eq(transactions.accountId, accountId), inArray(transactions.fitid, slice)));
    for (const r of rows) found.add(r.fitid);
  }
  return found;
}

function findRaw(normalized: NormalizedBatch, fitid: string): Record<string, unknown> {
  for (const t of normalized.transactions) {
    if (t.fitid === fitid) return t.raw;
  }
  return {};
}

// Used by reconcile only — re-export so the import action and the worker can
// build a preview + reconcile in one go.
export { reconcile };

// Wrapper to expose rule list to callers that need it (e.g. rules settings page).
export async function listCategoryRules(): Promise<CategoryRule[]> {
  return sortRules(await db.select().from(categoryRules));
}
