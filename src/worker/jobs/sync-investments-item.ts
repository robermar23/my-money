import { db } from "@/db/client.ts";
import {
  type NewInvestmentTransaction,
  accounts,
  holdingLots,
  holdings,
  investmentTransactions,
  plaidItems,
  plaidSyncRuns,
  prices,
  webhookLog,
} from "@/db/schema/index.ts";
import { valueAccountHoldings } from "@/lib/holdings/value.ts";
import { lotFromBuy } from "@/lib/investments/lots.ts";
import { plaidClient } from "@/lib/plaid/client.ts";
import {
  type SecurityInfo,
  institutionPriceQuote,
  plaidHoldingToHolding,
  plaidInvestmentTxnToRow,
} from "@/lib/plaid/investments-map.ts";
import { upsertSecurity } from "@/lib/plaid/securities.ts";
import { loadAccessToken } from "@/lib/plaid/tokens.ts";
import type { PriceQuote } from "@/lib/prices/types.ts";
import { upsertSnapshots } from "@/lib/snapshots/upsert.ts";
import type { Job } from "bullmq";
import { and, eq, notInArray, sql } from "drizzle-orm";

/**
 * P5-16 — Plaid Investments sync worker (ADR-011).
 *
 * Pulls two endpoints for a single Plaid Item that consented to `investments`:
 *   1. `/investments/holdings/get` — a FULL current-state snapshot. We upsert
 *      securities + holdings, write Plaid's `institution_price` into `prices`
 *      for non-tickered securities, and RECONCILE: plaid-sourced positions no
 *      longer present are deleted (sold out). Manual holdings are never touched.
 *   2. `/investments/transactions/get` — the buy/sell/dividend/interest stream
 *      over a 24-month window, deduped on (account, investment_transaction_id).
 *      Buys also build cost-basis lots.
 *
 * Unlike `/transactions/sync` there is no cursor: holdings are idempotent by
 * full-snapshot upsert + reconcile; transactions are idempotent by the unique
 * dedup index. Re-running yields the same state.
 *
 * Per CLAUDE.md §Plaid Safety Rules: item error codes map to
 * `plaid_items.status`; money flows through the mappers (never raw Number).
 */

export interface SyncInvestmentsItemJobData {
  readonly plaidItemPk: string;
  readonly trigger: "webhook" | "manual" | "cron" | "initial";
  readonly webhookLogId?: string;
}

/** Initial/incremental both pull the same 24-month window (Plaid's max history). */
const HISTORY_DAYS = 730;
const PAGE_SIZE = 500;

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

export async function syncInvestmentsItemProcessor(
  job: Job<SyncInvestmentsItemJobData>,
): Promise<void> {
  const { plaidItemPk, trigger, webhookLogId } = job.data;
  if (!plaidItemPk) throw new Error("sync-investments-item: missing plaidItemPk");

  const [item] = await db
    .select({ id: plaidItems.id, productsConsented: plaidItems.productsConsented })
    .from(plaidItems)
    .where(eq(plaidItems.id, plaidItemPk))
    .limit(1);

  // Item gone, or didn't consent to investments → no-op (mark webhook done).
  if (!item || !item.productsConsented.includes("investments")) {
    if (webhookLogId) {
      await db
        .update(webhookLog)
        .set({ processedAt: new Date(), status: "processed" })
        .where(eq(webhookLog.id, webhookLogId));
    }
    return;
  }

  const accessToken = await loadAccessToken(item.id);

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

  const [run] = await db
    .insert(plaidSyncRuns)
    .values({ plaidItemId: item.id, trigger })
    .returning({ id: plaidSyncRuns.id });
  if (!run) throw new Error("sync-investments-item: failed to open plaid_sync_runs row");

  // Counters reuse the generic sync-run columns:
  //   addedCount = investment txns inserted, modifiedCount = holdings upserted,
  //   removedCount = holdings removed (sold out), paginationCount = API calls.
  let addedCount = 0;
  let modifiedCount = 0;
  let removedCount = 0;
  let paginationCount = 0;
  const affectedAccountIds = new Set<string>();

  try {
    const holdingsResp = await plaidClient.investmentsHoldingsGet({ access_token: accessToken });
    paginationCount++;

    // Capture each account's Plaid-reported current balance — the authoritative
    // value for an investment account. Holdings can be absent (many 401k plans
    // expose only a balance through Plaid, not positions), in which case summing
    // holdings yields $0; we snapshot from this balance below instead.
    const plaidBalanceByAccountId = new Map<string, string>();
    for (const pa of holdingsResp.data.accounts) {
      const ours = accountByPlaidId.get(pa.account_id);
      if (!ours) continue;
      if (ours.type !== "investment" && ours.type !== "crypto_ira") continue;
      const current = pa.balances?.current;
      if (current == null || !Number.isFinite(current)) continue;
      plaidBalanceByAccountId.set(ours.id, current.toFixed(2));
    }

    await db.transaction(async (tx) => {
      // Upsert every security from the holdings response, keyed by Plaid id.
      const securityByPlaidId = new Map<string, SecurityInfo>();
      for (const s of holdingsResp.data.securities) {
        const row = await upsertSecurity(s, tx);
        securityByPlaidId.set(s.security_id, {
          id: row.id,
          symbol: row.symbol,
          tickerSymbol: row.tickerSymbol,
          type: row.type,
          isCashEquivalent: row.isCashEquivalent,
        });
      }

      // Upsert holdings; track which symbols are present per account.
      const presentSymbolsByAccount = new Map<string, Set<string>>();
      const priceQuotes: PriceQuote[] = [];
      for (const h of holdingsResp.data.holdings) {
        const ours = accountByPlaidId.get(h.account_id);
        if (!ours) continue;
        const sec = securityByPlaidId.get(h.security_id);
        if (!sec) continue;

        const row = plaidHoldingToHolding(h, sec, ours.id);
        await tx
          .insert(holdings)
          .values(row)
          .onConflictDoUpdate({
            target: [holdings.accountId, holdings.symbol],
            set: {
              quantity: row.quantity,
              quantityUnit: row.quantityUnit,
              assetClass: row.assetClass,
              securityId: row.securityId,
              source: "plaid",
              // Preserve a user-owned cost basis; otherwise take Plaid's.
              costBasis: sql`CASE WHEN ${holdings.costBasisOverriddenAt} IS NOT NULL THEN ${holdings.costBasis} ELSE ${row.costBasis ?? null}::numeric END`,
              updatedAt: new Date(),
            },
          });
        modifiedCount++;
        affectedAccountIds.add(ours.id);

        let present = presentSymbolsByAccount.get(ours.id);
        if (!present) {
          present = new Set<string>();
          presentSymbolsByAccount.set(ours.id, present);
        }
        present.add(row.symbol);

        const quote = institutionPriceQuote(h, sec);
        if (quote) priceQuotes.push(quote);
      }

      // Reconcile sold-out positions: delete plaid holdings absent from the
      // snapshot. Manual holdings (source='manual') are never deleted.
      for (const ours of accountByPlaidId.values()) {
        const present = presentSymbolsByAccount.get(ours.id);
        const condition =
          present && present.size > 0
            ? and(
                eq(holdings.accountId, ours.id),
                eq(holdings.source, "plaid"),
                notInArray(holdings.symbol, [...present]),
              )
            : and(eq(holdings.accountId, ours.id), eq(holdings.source, "plaid"));
        const deleted = await tx.delete(holdings).where(condition).returning({ id: holdings.id });
        if (deleted.length > 0) {
          removedCount += deleted.length;
          affectedAccountIds.add(ours.id);
        }
      }

      // Institution prices for non-tickered (synthetic) securities.
      for (const q of priceQuotes) {
        await tx
          .insert(prices)
          .values({ symbol: q.symbol, date: q.date, close: q.close, source: q.source })
          .onConflictDoUpdate({
            target: [prices.symbol, prices.date],
            set: { close: q.close, source: q.source },
          });
      }

      // ---- Investment transactions (24-month window, offset pagination) ----
      const end = new Date();
      const start = new Date(end.getTime() - HISTORY_DAYS * 24 * 60 * 60 * 1000);
      const startDate = start.toISOString().slice(0, 10);
      const endDate = end.toISOString().slice(0, 10);

      const insertedBuys: Array<{
        row: NewInvestmentTransaction;
        accountId: string;
        symbol: string;
      }> = [];
      let offset = 0;
      let total = Number.POSITIVE_INFINITY;
      while (offset < total) {
        const txResp = await plaidClient.investmentsTransactionsGet({
          access_token: accessToken,
          start_date: startDate,
          end_date: endDate,
          options: { count: PAGE_SIZE, offset },
        });
        paginationCount++;
        total = txResp.data.total_investment_transactions;

        // The transactions response carries securities too — upsert any new ones.
        for (const s of txResp.data.securities) {
          if (securityByPlaidId.has(s.security_id)) continue;
          const row = await upsertSecurity(s, tx);
          securityByPlaidId.set(s.security_id, {
            id: row.id,
            symbol: row.symbol,
            tickerSymbol: row.tickerSymbol,
            type: row.type,
            isCashEquivalent: row.isCashEquivalent,
          });
        }

        const batch = txResp.data.investment_transactions;
        for (const it of batch) {
          const ours = accountByPlaidId.get(it.account_id);
          if (!ours) continue;
          const sec = it.security_id ? securityByPlaidId.get(it.security_id) : undefined;
          const row = plaidInvestmentTxnToRow(it, ours.id, sec?.id ?? null);
          const inserted = await tx
            .insert(investmentTransactions)
            .values(row)
            .onConflictDoNothing({
              target: [
                investmentTransactions.accountId,
                investmentTransactions.plaidInvestmentTransactionId,
              ],
              where: sql`${investmentTransactions.plaidInvestmentTransactionId} is not null`,
            })
            .returning({ id: investmentTransactions.id });
          if (inserted.length > 0) {
            addedCount++;
            if (row.type === "buy" && sec) {
              insertedBuys.push({ row, accountId: ours.id, symbol: sec.symbol });
            }
          }
        }

        if (batch.length === 0) break; // defensive: avoid an infinite loop
        offset += batch.length;
      }

      // Build cost-basis lots from newly-inserted buys.
      for (const b of insertedBuys) {
        const [h] = await tx
          .select({ id: holdings.id })
          .from(holdings)
          .where(and(eq(holdings.accountId, b.accountId), eq(holdings.symbol, b.symbol)))
          .limit(1);
        if (!h) continue;
        const lot = lotFromBuy(b.row, h.id);
        if (!lot) continue;
        await tx
          .insert(holdingLots)
          .values(lot)
          .onConflictDoNothing({
            target: [holdingLots.holdingId, holdingLots.plaidInvestmentTransactionId],
            where: sql`${holdingLots.plaidInvestmentTransactionId} is not null`,
          });
      }

      // Advance the Item + close the run.
      await tx
        .update(plaidItems)
        .set({
          lastSyncedAt: new Date(),
          status: "active",
          errorCode: null,
          errorMessage: null,
          updatedAt: new Date(),
        })
        .where(eq(plaidItems.id, item.id));

      await tx
        .update(plaidSyncRuns)
        .set({ finishedAt: new Date(), addedCount, modifiedCount, removedCount, paginationCount })
        .where(eq(plaidSyncRuns.id, run.id));

      if (webhookLogId) {
        await tx
          .update(webhookLog)
          .set({ processedAt: new Date(), status: "processed" })
          .where(eq(webhookLog.id, webhookLogId));
      }
    });

    // Snapshot post-commit so the dashboard shows a value immediately. Snapshot
    // every account Plaid reported a balance for (so a holdings-less 401k still
    // gets its real value) plus any others touched this run. Prefer Plaid's
    // reported balance; fall back to summing priced holdings only when no
    // balance came back.
    const toSnapshot = new Set<string>([...affectedAccountIds, ...plaidBalanceByAccountId.keys()]);
    if (toSnapshot.size > 0) {
      const today = new Date().toISOString().slice(0, 10);
      for (const acctId of toSnapshot) {
        const currency = accountRows.find((a) => a.id === acctId)?.currency ?? "USD";
        const plaidBalance = plaidBalanceByAccountId.get(acctId);
        const value =
          plaidBalance ?? (await valueAccountHoldings(acctId, currency, today)).toString();
        await upsertSnapshots(acctId, new Map([[today, value]]));
      }
    }
  } catch (err) {
    const code = plaidErrorCode(err);
    const message = plaidErrorMessage(err);
    const newStatus = mapErrorToItemStatus(code);
    await db
      .update(plaidItems)
      .set({
        ...(newStatus ? { status: newStatus } : {}),
        errorCode: code,
        errorMessage: message,
        updatedAt: new Date(),
      })
      .where(eq(plaidItems.id, item.id));
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
