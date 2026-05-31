import "server-only";

import { db } from "@/db/client.ts";
import { type ImportBatch, accountSnapshots, transactions } from "@/db/schema/index.ts";
import { Money } from "@/lib/money/money.ts";
import { and, desc, eq, lt, lte, sql } from "drizzle-orm";
import type { NormalizedBatch } from "./normalize.ts";

export type ReconciliationStatus = "ok" | "mismatch" | "no-anchor" | "no-balance";

export interface ReconciliationResult {
  readonly status: ReconciliationStatus;
  /** Diff = endingBalance - (anchor + sum_of_batch_txns). Null when status is no-balance. */
  readonly diff: Money | null;
  /** The anchor balance used (most-recent snapshot ≤ statementStart - 1d). */
  readonly anchor: Money | null;
  /** Sum of the batch's transactions. */
  readonly sumOfTransactions: Money;
  /** The ending balance from the file (LEDGERBAL for QFX). */
  readonly endingBalance: Money | null;
}

const RECONCILE_TOLERANCE = "0.005";

/**
 * Reconcile a parsed (but not-yet-persisted) batch against the account's
 * existing snapshot history.
 *
 * Strategy:
 *   - If the batch has no ending balance (CSV), return `no-balance` — the
 *     UI just informs the user reconciliation is unavailable for this source.
 *   - If we have a prior snapshot ≤ (statement_start - 1 day), use it as the
 *     anchor and compute `(anchor + sum_of_batch_txns) vs endingBalance`.
 *   - Otherwise, return `no-anchor` and treat the endingBalance as ground
 *     truth (we trust the file when we have nothing to anchor against).
 */
export async function reconcile(
  batch: Pick<
    ImportBatch,
    "accountId" | "statementStart" | "statementEnd" | "statementEndingBalance"
  >,
  normalized: NormalizedBatch,
  currency: string,
): Promise<ReconciliationResult> {
  const txns = normalized.transactions;
  let sum = Money.zero(currency);
  for (const t of txns) {
    sum = sum.add(Money.fromString(t.amount, currency));
  }

  if (!batch.statementEndingBalance) {
    return {
      status: "no-balance",
      diff: null,
      anchor: null,
      sumOfTransactions: sum,
      endingBalance: null,
    };
  }

  const endingBalance = Money.fromString(batch.statementEndingBalance, currency);

  // Anchor: most-recent snapshot strictly BEFORE statementStart.
  let anchor: Money | null = null;
  if (batch.statementStart) {
    const [prior] = await db
      .select({ balance: accountSnapshots.balance })
      .from(accountSnapshots)
      .where(
        and(
          eq(accountSnapshots.accountId, batch.accountId),
          lt(accountSnapshots.date, batch.statementStart),
        ),
      )
      .orderBy(desc(accountSnapshots.date))
      .limit(1);
    if (prior) anchor = Money.fromString(prior.balance, currency);
  }

  if (!anchor) {
    return {
      status: "no-anchor",
      diff: null,
      anchor: null,
      sumOfTransactions: sum,
      endingBalance,
    };
  }

  const expected = anchor.add(sum);
  const diff = endingBalance.sub(expected);
  const isOk = diff.equals(Money.zero(currency)) || cmpAbs(diff, currency) < 0;

  return {
    status: isOk ? "ok" : "mismatch",
    diff,
    anchor,
    sumOfTransactions: sum,
    endingBalance,
  };
}

function cmpAbs(m: Money, currency: string): number {
  // Helper: |m| < TOLERANCE
  const tol = Money.fromString(RECONCILE_TOLERANCE, currency);
  // Money has no abs() method; compare via sign.
  const absVal = m.isNegative() ? m.negate() : m;
  // Use string compare on canonical 2-decimal form; safe because all values are
  // sums of NUMERIC(18,2) inputs.
  return Number.parseFloat(absVal.toString()) - Number.parseFloat(tol.toString());
}

/**
 * Compute the running balance at each posted date in the batch, walking
 * forward from the anchor (or backward from the ending balance when no
 * anchor exists).
 *
 * Returns a Map<isoDate, balanceString>. Used by the snapshot upsert step.
 */
export async function computeRunningBalances(
  batch: Pick<
    ImportBatch,
    "accountId" | "statementStart" | "statementEnd" | "statementEndingBalance"
  >,
  normalized: NormalizedBatch,
  currency: string,
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (normalized.transactions.length === 0) return result;

  // Sort transactions by postedAt (stable).
  const txns = [...normalized.transactions].sort((a, b) => a.postedAt.localeCompare(b.postedAt));

  // Anchor (or implicit anchor from ending balance backward).
  let anchor: Money;
  if (batch.statementStart) {
    const [prior] = await db
      .select({ balance: accountSnapshots.balance })
      .from(accountSnapshots)
      .where(
        and(
          eq(accountSnapshots.accountId, batch.accountId),
          lt(accountSnapshots.date, batch.statementStart),
        ),
      )
      .orderBy(desc(accountSnapshots.date))
      .limit(1);
    anchor = prior
      ? Money.fromString(prior.balance, currency)
      : impliedAnchor(batch, txns, currency);
  } else {
    anchor = impliedAnchor(batch, txns, currency);
  }

  // Walk forward, aggregating by date.
  let running = anchor;
  for (const t of txns) {
    running = running.add(Money.fromString(t.amount, currency));
    result.set(t.postedAt, running.toString());
  }

  // Override the last-date row with the file's ending balance when present
  // (the file is authoritative for the period end).
  if (batch.statementEnd && batch.statementEndingBalance) {
    result.set(batch.statementEnd, batch.statementEndingBalance);
  }

  return result;
}

function impliedAnchor(
  batch: Pick<ImportBatch, "statementEndingBalance">,
  txns: readonly { amount: string }[],
  currency: string,
): Money {
  if (!batch.statementEndingBalance) return Money.zero(currency);
  let total = Money.fromString(batch.statementEndingBalance, currency);
  for (const t of txns) {
    total = total.sub(Money.fromString(t.amount, currency));
  }
  return total;
}

/**
 * Convenience: query the latest reconciliation state for an account by joining
 * the most-recent confirmed batch with its ledger balance and the snapshot
 * computed from confirmed transactions.
 */
export interface AccountReconciliation {
  readonly batchId: string | null;
  readonly importedBalance: string | null;
  readonly computedBalance: string | null;
  readonly asOf: string | null;
  readonly drift: string;
}

export async function latestAccountReconciliation(
  accountId: string,
  currency: string,
): Promise<AccountReconciliation> {
  // Latest snapshot already encodes the imported balance (since the confirm
  // step writes it). What we need is the gap between that snapshot and the
  // sum-of-transactions-to-date for the same account.
  const [latestSnap] = await db
    .select({ date: accountSnapshots.date, balance: accountSnapshots.balance })
    .from(accountSnapshots)
    .where(eq(accountSnapshots.accountId, accountId))
    .orderBy(desc(accountSnapshots.date))
    .limit(1);

  if (!latestSnap) {
    return {
      batchId: null,
      importedBalance: null,
      computedBalance: null,
      asOf: null,
      drift: "0.00",
    };
  }

  // Sum all transactions ≤ snapshot date.
  const [computed] = await db
    .select({ sum: sql<string>`COALESCE(SUM(${transactions.amount})::text, '0')` })
    .from(transactions)
    .where(and(eq(transactions.accountId, accountId), lte(transactions.postedAt, latestSnap.date)));

  const imported = Money.fromString(latestSnap.balance, currency);
  const computedTotal = Money.fromString(computed?.sum ?? "0", currency);
  const drift = imported.sub(computedTotal);

  return {
    batchId: null, // populated by callers that join through import_batches if needed
    importedBalance: imported.toString(),
    computedBalance: computedTotal.toString(),
    asOf: latestSnap.date,
    drift: drift.toString(),
  };
}
