import { db } from "@/db/client.ts";
import {
  accounts,
  categoryRules,
  plaidItems,
  plaidSyncRuns,
  transactions,
  webhookLog,
} from "@/db/schema/index.ts";
import { matchCategory, sortRules } from "@/lib/categorization/match.ts";
import { Money } from "@/lib/money/money.ts";
import { plaidClient } from "@/lib/plaid/client.ts";
import { plaidToTransaction } from "@/lib/plaid/map.ts";
import { loadAccessToken } from "@/lib/plaid/tokens.ts";
import { recomputeAccountSnapshotsForDates } from "@/lib/snapshots/recompute.ts";
import { upsertSnapshots } from "@/lib/snapshots/upsert.ts";
import type { Job } from "bullmq";
import { and, eq, gt, sql } from "drizzle-orm";
import type { Transaction as PlaidTransaction, RemovedTransaction } from "plaid";

/**
 * P4-18 — Plaid sync worker.
 *
 * Drains `/transactions/sync` for a single Plaid Item, applies the diff to
 * `transactions` + `account_snapshots`, advances the cursor, and stamps the
 * Item's `last_synced_at`. Idempotent: the cursor only advances on commit,
 * so a re-run with the same cursor lands the same diff (or an empty one if
 * Plaid has nothing new).
 *
 * Per CLAUDE.md §Plaid Safety Rules:
 *   - `TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION` → discard accumulated
 *     pages, restart from `cursor=null`.
 *   - Item error codes map to `plaid_items.status` (`ITEM_LOGIN_REQUIRED`,
 *     `PENDING_DISCONNECT`/`PENDING_EXPIRATION` → 'pending_disconnect',
 *     `USER_PERMISSION_REVOKED`/`USER_ACCOUNT_REVOKED` → 'revoked').
 *
 * P4-20 — categorization is wired in here: each new/modified row runs
 * through `matchCategory` against current `category_rules`. Modified rows
 * with `category_overridden_at IS NOT NULL` skip recategorization (override
 * is sticky).
 */

export interface SyncPlaidItemJobData {
  readonly plaidItemPk: string;
  readonly trigger: "webhook" | "manual" | "cron" | "initial";
  readonly webhookLogId?: string;
}

const MUTATION_ERROR_CODE = "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION";

interface PlaidErrorEnvelope {
  response?: { data?: { error_code?: string; error_message?: string } };
  message?: string;
}

function plaidErrorCode(err: unknown): string | null {
  return (err as PlaidErrorEnvelope)?.response?.data?.error_code ?? null;
}
function plaidErrorMessage(err: unknown): string {
  return (
    (err as PlaidErrorEnvelope)?.response?.data?.error_message ??
    (err as { message?: string })?.message ??
    "unknown error"
  );
}

function mapErrorToItemStatus(code: string | null): string | null {
  switch (code) {
    case "ITEM_LOGIN_REQUIRED":
    case "INVALID_CREDENTIALS":
      return "login_required";
    case "PENDING_DISCONNECT":
    case "PENDING_EXPIRATION":
      return "pending_disconnect";
    case "USER_PERMISSION_REVOKED":
    case "USER_ACCOUNT_REVOKED":
      return "revoked";
    default:
      return null;
  }
}

export async function syncPlaidItemProcessor(job: Job<SyncPlaidItemJobData>): Promise<void> {
  const { plaidItemPk, trigger, webhookLogId } = job.data;
  if (!plaidItemPk) throw new Error("sync-plaid-item: missing plaidItemPk");

  const [item] = await db
    .select({
      id: plaidItems.id,
      transactionsCursor: plaidItems.transactionsCursor,
    })
    .from(plaidItems)
    .where(eq(plaidItems.id, plaidItemPk))
    .limit(1);
  if (!item) {
    // Item was removed between webhook receipt and job pickup. Mark webhook
    // (if any) processed as a no-op and exit.
    if (webhookLogId) {
      await db
        .update(webhookLog)
        .set({ processedAt: new Date(), status: "processed" })
        .where(eq(webhookLog.id, webhookLogId));
    }
    return;
  }

  const accessToken = await loadAccessToken(item.id);

  // Map of Plaid account_id → our account UUID. Plaid accounts the user
  // chose to skip won't be in this map; their transactions get dropped.
  const accountRows = await db
    .select({
      id: accounts.id,
      plaidAccountId: accounts.plaidAccountId,
      currency: accounts.currency,
      type: accounts.type,
    })
    .from(accounts)
    .where(eq(accounts.plaidItemId, item.id));
  const accountByPlaidId = new Map<string, { id: string; currency: string; type: string }>();
  for (const r of accountRows) {
    if (r.plaidAccountId)
      accountByPlaidId.set(r.plaidAccountId, { id: r.id, currency: r.currency, type: r.type });
  }

  // 1. Open a `plaid_sync_runs` row in-flight.
  const [run] = await db
    .insert(plaidSyncRuns)
    .values({
      plaidItemId: item.id,
      cursorBefore: item.transactionsCursor,
      trigger,
    })
    .returning({ id: plaidSyncRuns.id });
  if (!run) throw new Error("sync-plaid-item: failed to open plaid_sync_runs row");

  try {
    // 2. Drain /transactions/sync with mutation-during-pagination handling.
    const { added, modified, removed, paginationCount, finalCursor } = await drainSync({
      accessToken,
      initialCursor: item.transactionsCursor,
    });

    // 2b. Fetch the CACHED current balance per account to anchor snapshots to
    // reality. Per CLAUDE.md §Plaid Safety Rules this uses `accountsGet` (cached),
    // never the real-time `accountsBalanceGet` — we're a read-only tracker.
    // Without this anchor, balances were reconstructed as a running sum from $0
    // over Plaid's bounded transaction window, so the true opening balance was
    // lost (a savings account showing negative). Net-worth sign: depository =
    // +current, credit card = -current (it's a liability; net-worth/compute.ts
    // sums snapshots directly and only negates loans).
    const currentByAccountId = new Map<string, { signed: string; currency: string }>();
    try {
      const balResp = await plaidClient.accountsGet({ access_token: accessToken });
      for (const pa of balResp.data.accounts) {
        const ours = accountByPlaidId.get(pa.account_id);
        if (!ours) continue;
        const current = pa.balances?.current;
        if (current == null || !Number.isFinite(current)) continue;
        const m = Money.fromString(current.toFixed(2), ours.currency);
        const signed = (ours.type === "credit_card" ? m.negate() : m).toString();
        currentByAccountId.set(ours.id, { signed, currency: ours.currency });
      }
    } catch (err) {
      // Non-fatal: fall back to the (less accurate) affected-dates recompute
      // rather than failing the whole sync if the balance call errors.
      console.error(`[sync-plaid-item] accountsGet failed for item ${item.id}:`, err);
    }

    // 3. Apply all changes in a single DB transaction.
    const rules = sortRules(await db.select().from(categoryRules));
    const affectedDatesByAccount = new Map<string, Set<string>>();
    let addedCount = 0;
    let modifiedCount = 0;
    let removedCount = 0;

    await db.transaction(async (tx) => {
      // --- INSERTs (added) ---
      for (const t of added) {
        const ours = accountByPlaidId.get(t.account_id);
        if (!ours) continue; // skipped account
        const normalized = plaidToTransaction(t, ours.id);
        const matched = matchCategory(normalized.name, normalized.memo ?? null, rules);
        const result = await tx
          .insert(transactions)
          .values({
            ...normalized,
            category: matched?.name ?? null,
            categoryId: matched?.categoryId ?? null,
            source: "plaid",
          })
          .onConflictDoNothing({ target: [transactions.accountId, transactions.fitid] })
          .returning({ id: transactions.id });
        if (result.length > 0) {
          addAffectedDate(affectedDatesByAccount, ours.id, normalized.postedAt);
          addedCount++;
        }
      }

      // --- UPDATEs (modified) — sticky overrides ---
      for (const t of modified) {
        const ours = accountByPlaidId.get(t.account_id);
        if (!ours) continue;
        const normalized = plaidToTransaction(t, ours.id);
        // Read existing row's override flag in the same tx.
        const [existing] = await tx
          .select({
            id: transactions.id,
            categoryOverriddenAt: transactions.categoryOverriddenAt,
            postedAt: transactions.postedAt,
          })
          .from(transactions)
          .where(and(eq(transactions.accountId, ours.id), eq(transactions.fitid, normalized.fitid)))
          .limit(1);
        const overridden = existing?.categoryOverriddenAt != null;
        const matched = overridden
          ? null
          : matchCategory(normalized.name, normalized.memo ?? null, rules);

        const updateSet: Record<string, unknown> = {
          amount: normalized.amount,
          name: normalized.name,
          memo: normalized.memo,
          postedAt: normalized.postedAt,
          raw: normalized.raw,
        };
        if (!overridden) {
          updateSet.category = matched?.name ?? null;
          updateSet.categoryId = matched?.categoryId ?? null;
        }

        await tx
          .insert(transactions)
          .values({
            ...normalized,
            category: matched?.name ?? null,
            categoryId: matched?.categoryId ?? null,
            source: "plaid",
          })
          .onConflictDoUpdate({
            target: [transactions.accountId, transactions.fitid],
            set: updateSet,
          });
        // postedAt may have changed; track both old and new dates.
        if (existing?.postedAt) {
          addAffectedDate(affectedDatesByAccount, ours.id, existing.postedAt);
        }
        addAffectedDate(affectedDatesByAccount, ours.id, normalized.postedAt);
        modifiedCount++;
      }

      // --- DELETEs (removed) ---
      for (const r of removed) {
        if (!r.account_id || !r.transaction_id) continue;
        const ours = accountByPlaidId.get(r.account_id);
        if (!ours) continue;
        const deleted = await tx
          .delete(transactions)
          .where(and(eq(transactions.accountId, ours.id), eq(transactions.fitid, r.transaction_id)))
          .returning({ postedAt: transactions.postedAt });
        for (const d of deleted) {
          addAffectedDate(affectedDatesByAccount, ours.id, d.postedAt);
          removedCount++;
        }
      }

      // --- Snapshot recomputation ---
      // Anchor each account's full snapshot history to its current balance and
      // walk backward (balance(d) = current − SUM(amount WHERE posted_at > d)),
      // which fixes the old sum-from-zero that ignored the pre-window opening
      // balance. Accounts whose balance couldn't be fetched fall back to the
      // affected-dates recompute.
      const today = new Date().toISOString().slice(0, 10);
      const acctsToRecompute = new Set<string>([
        ...affectedDatesByAccount.keys(),
        ...currentByAccountId.keys(),
      ]);
      for (const acctId of acctsToRecompute) {
        const anchor = currentByAccountId.get(acctId);
        if (anchor) {
          await recomputeAnchoredHistory(tx, acctId, anchor.signed, anchor.currency, today);
        } else {
          const dates = affectedDatesByAccount.get(acctId);
          if (dates) {
            await recomputeAccountSnapshotsForDates(acctId, dates, tx);
          }
        }
      }

      // --- Advance the Item's cursor + clear error fields ---
      await tx
        .update(plaidItems)
        .set({
          transactionsCursor: finalCursor,
          lastSyncedAt: new Date(),
          status: "active",
          errorCode: null,
          errorMessage: null,
          updatedAt: new Date(),
        })
        .where(eq(plaidItems.id, item.id));

      // --- Close out the sync_run ---
      await tx
        .update(plaidSyncRuns)
        .set({
          finishedAt: new Date(),
          cursorAfter: finalCursor,
          addedCount,
          modifiedCount,
          removedCount,
          paginationCount,
        })
        .where(eq(plaidSyncRuns.id, run.id));

      // --- Mark the webhook_log processed ---
      if (webhookLogId) {
        await tx
          .update(webhookLog)
          .set({ processedAt: new Date(), status: "processed" })
          .where(eq(webhookLog.id, webhookLogId));
      }
    });
  } catch (err) {
    // Classify Plaid error → Item status if possible.
    const code = plaidErrorCode(err);
    const message = plaidErrorMessage(err);
    const newStatus = mapErrorToItemStatus(code);
    if (newStatus) {
      await db
        .update(plaidItems)
        .set({ status: newStatus, errorCode: code, errorMessage: message, updatedAt: new Date() })
        .where(eq(plaidItems.id, item.id));
    } else {
      await db
        .update(plaidItems)
        .set({ errorCode: code, errorMessage: message, updatedAt: new Date() })
        .where(eq(plaidItems.id, item.id));
    }

    await db
      .update(plaidSyncRuns)
      .set({ finishedAt: new Date(), error: code ?? message })
      .where(eq(plaidSyncRuns.id, run.id));

    if (webhookLogId) {
      await db
        .update(webhookLog)
        .set({ status: "failed", error: code ?? message })
        .where(eq(webhookLog.id, webhookLogId));
    }
    throw err;
  }
}

/* ---------------------------------------------------------------------------
 * Helpers
 * --------------------------------------------------------------------------- */

interface DrainResult {
  added: PlaidTransaction[];
  modified: PlaidTransaction[];
  removed: RemovedTransaction[];
  paginationCount: number;
  finalCursor: string | null;
}

async function drainSync(opts: {
  accessToken: string;
  initialCursor: string | null;
}): Promise<DrainResult> {
  let cursor: string | null = opts.initialCursor;
  let restartedDueToMutation = false;
  let added: PlaidTransaction[] = [];
  let modified: PlaidTransaction[] = [];
  let removed: RemovedTransaction[] = [];
  let paginationCount = 0;

  for (;;) {
    paginationCount++;
    let resp: Awaited<ReturnType<typeof plaidClient.transactionsSync>>;
    try {
      resp = await plaidClient.transactionsSync({
        access_token: opts.accessToken,
        cursor: cursor ?? undefined,
        count: 500,
      });
    } catch (err) {
      if (plaidErrorCode(err) === MUTATION_ERROR_CODE) {
        if (restartedDueToMutation) {
          // Two mutation errors in one run → give up and surface to caller.
          throw err;
        }
        restartedDueToMutation = true;
        cursor = null;
        added = [];
        modified = [];
        removed = [];
        paginationCount = 0;
        continue;
      }
      throw err;
    }

    added.push(...resp.data.added);
    modified.push(...resp.data.modified);
    removed.push(...resp.data.removed);
    cursor = resp.data.next_cursor;
    if (!resp.data.has_more) break;
  }

  return { added, modified, removed, paginationCount, finalCursor: cursor };
}

function addAffectedDate(map: Map<string, Set<string>>, accountId: string, date: string): void {
  let set = map.get(accountId);
  if (!set) {
    set = new Set<string>();
    map.set(accountId, set);
  }
  set.add(date);
}

/**
 * Rewrite an account's snapshot history anchored to its current balance.
 *
 * For every date the account has a transaction on (plus `today`), compute:
 *   balance(date) = currentSigned − SUM(amount WHERE posted_at > date)
 * i.e. walk backward from the known current balance, undoing each later
 * transaction. `transactions.amount` is stored in OFX convention (positive =
 * inflow) and `currentSigned` already carries the net-worth sign (credit cards
 * negative), so this one formula is correct for both depository and credit.
 *
 * This replaces the sum-from-zero approach, which assumed every account opened
 * at $0 immediately before Plaid's transaction window — wrong by exactly the
 * opening balance, which is why a savings account could read negative.
 *
 * @param tx - Active DB transaction.
 * @param accountId - Our account UUID.
 * @param currentSigned - Plaid's current balance, net-worth-signed, as a string.
 * @param currency - The account's currency.
 * @param today - ISO date (YYYY-MM-DD) anchor point for the current balance.
 */
async function recomputeAnchoredHistory(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  accountId: string,
  currentSigned: string,
  currency: string,
  today: string,
): Promise<void> {
  const dateRows = await tx
    .selectDistinct({ date: transactions.postedAt })
    .from(transactions)
    .where(eq(transactions.accountId, accountId));
  const dates = new Set<string>(dateRows.map((r) => r.date));
  dates.add(today);

  const current = Money.fromString(currentSigned, currency);
  for (const date of dates) {
    const [row] = await tx
      .select({ after: sql<string>`COALESCE(SUM(${transactions.amount})::text, '0')` })
      .from(transactions)
      .where(and(eq(transactions.accountId, accountId), gt(transactions.postedAt, date)));
    const balance = current.sub(Money.fromString(row?.after ?? "0", currency)).toString();
    await upsertSnapshots(accountId, new Map([[date, balance]]), tx);
  }
}

/**
 * The affected-dates fallback recompute (cumulative SUM(amount) ≤ date) now
 * lives in `src/lib/snapshots/recompute.ts` as
 * {@link recomputeAccountSnapshotsForDates}, shared with the manual transaction
 * delete/edit actions (P7-07). `recomputeAnchoredHistory` above remains the
 * primary, live-balance-anchored path for Plaid accounts.
 */
