import { db } from "@/db/client.ts";
import {
  accountSnapshots,
  accounts,
  alerts,
  holdings,
  plaidItems,
  plaidSyncRuns,
  prices,
  transactions,
} from "@/db/schema/index.ts";
import { notifyNewAlerts } from "@/lib/alerts/notify.ts";
import {
  type AccountStaleness,
  type AlertInputs,
  type BalancePair,
  type DetectedAlert,
  RULE_ALERT_TYPES,
  balanceDropAlerts,
  itemLoginRequiredAlerts,
  largeTransactionAlerts,
  stalePriceAlerts,
  staleSnapshotAlerts,
  syncFailureAlerts,
  thresholdsFromEnv,
} from "@/lib/alerts/rules.ts";
import type { Job } from "bullmq";
import {
  and,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  notInArray,
  notLike,
  sql,
} from "drizzle-orm";

/**
 * Phase 6 (P6-13) — nightly anomaly detection (ADR-015).
 *
 * Runs the deterministic rules (P6-12) over the DB, persists results to `alerts`
 * (idempotent via the `dedup_hash` UNIQUE), RESOLVES open alerts whose condition
 * has cleared, then sends the notification-only email (P6-14) for whatever is
 * still open and un-notified — including a `backup_failure` row the backup job
 * wrote directly.
 *
 * Deps injectable (load/env/now/notify) so the persist + resolve + notify logic
 * is tested without seeding every source table.
 */

export interface DetectAnomaliesResult {
  readonly created: number;
  readonly resolved: number;
  readonly notified: number;
}

export interface DetectAnomaliesDeps {
  readonly load?: (now: Date) => Promise<AlertInputs>;
  readonly env?: Record<string, string | undefined>;
  readonly now?: () => Date;
  readonly notify?: (count: number, date: string) => Promise<{ sent: boolean }>;
}

const isoDate = (d: Date): string => d.toISOString().slice(0, 10);

/** Default loader: pull every rule's inputs from Postgres. */
async function loadAlertInputs(now: Date): Promise<AlertInputs> {
  const oneDayAgo = new Date(now.getTime() - 86_400_000);
  const sixtyDaysAgo = isoDate(new Date(now.getTime() - 60 * 86_400_000));

  const recentTxns = await db
    .select({
      id: transactions.id,
      accountId: transactions.accountId,
      postedAt: transactions.postedAt,
      amount: transactions.amount,
      name: transactions.name,
    })
    .from(transactions)
    .where(gte(transactions.createdAt, oneDayAgo));

  // Two most-recent snapshots per account → a balance-drop pair.
  const snaps = await db
    .select({
      accountId: accountSnapshots.accountId,
      accountName: accounts.name,
      date: accountSnapshots.date,
      balance: accountSnapshots.balance,
    })
    .from(accountSnapshots)
    .innerJoin(accounts, eq(accountSnapshots.accountId, accounts.id))
    .where(gte(accountSnapshots.date, sixtyDaysAgo))
    .orderBy(accountSnapshots.accountId, desc(accountSnapshots.date));
  const byAccount = new Map<string, typeof snaps>();
  for (const s of snaps) {
    const arr = byAccount.get(s.accountId) ?? [];
    arr.push(s);
    byAccount.set(s.accountId, arr);
  }
  const balancePairs: BalancePair[] = [];
  for (const arr of byAccount.values()) {
    const [latest, prior] = arr;
    if (latest && prior) {
      balancePairs.push({
        accountId: latest.accountId,
        accountName: latest.accountName,
        latestDate: latest.date,
        priorBalance: prior.balance,
        latestBalance: latest.balance,
      });
    }
  }

  const brokenItems = await db
    .select({
      id: plaidItems.id,
      institutionName: plaidItems.institutionName,
      status: plaidItems.status,
    })
    .from(plaidItems)
    .where(inArray(plaidItems.status, ["login_required", "revoked", "pending_disconnect"]));

  // Active accounts + their newest snapshot date.
  const activeAccounts = await db
    .select({ accountId: accounts.id, accountName: accounts.name })
    .from(accounts)
    .where(isNull(accounts.closedAt));
  const maxSnap = await db
    .select({
      accountId: accountSnapshots.accountId,
      latest: sql<string>`max(${accountSnapshots.date})`,
    })
    .from(accountSnapshots)
    .groupBy(accountSnapshots.accountId);
  const latestSnapByAccount = new Map(maxSnap.map((r) => [r.accountId, r.latest]));
  const accountStaleness: AccountStaleness[] = activeAccounts.map((a) => ({
    accountId: a.accountId,
    accountName: a.accountName,
    latestSnapshotDate: latestSnapByAccount.get(a.accountId) ?? null,
  }));

  // Fetchable held symbols (exclude synthetic SEC: securities) + newest price date.
  const heldSymbols = await db
    .selectDistinct({ symbol: holdings.symbol })
    .from(holdings)
    .where(
      and(
        inArray(holdings.assetClass, ["equity", "crypto", "physical_metal"]),
        notLike(holdings.symbol, "SEC:%"),
      ),
    );
  const maxPrice = await db
    .select({ symbol: prices.symbol, latest: sql<string>`max(${prices.date})` })
    .from(prices)
    .groupBy(prices.symbol);
  const latestPriceBySymbol = new Map(maxPrice.map((r) => [r.symbol, r.latest]));
  const symbolStaleness = heldSymbols.map((h) => ({
    symbol: h.symbol,
    latestPriceDate: latestPriceBySymbol.get(h.symbol) ?? null,
  }));

  const failedRunRows = await db
    .select({
      id: plaidSyncRuns.id,
      institutionName: plaidItems.institutionName,
      error: plaidSyncRuns.error,
      startedAt: plaidSyncRuns.startedAt,
    })
    .from(plaidSyncRuns)
    .innerJoin(plaidItems, eq(plaidSyncRuns.plaidItemId, plaidItems.id))
    .where(and(isNotNull(plaidSyncRuns.error), gte(plaidSyncRuns.startedAt, oneDayAgo)));
  const failedRuns = failedRunRows.map((r) => ({
    id: r.id,
    institutionName: r.institutionName,
    error: r.error ?? "unknown",
    startedAt: isoDate(r.startedAt),
  }));

  return { recentTxns, balancePairs, brokenItems, accountStaleness, symbolStaleness, failedRuns };
}

export async function detectAnomaliesDailyProcessor(
  _job: Job,
  deps: DetectAnomaliesDeps = {},
): Promise<DetectAnomaliesResult> {
  const env = deps.env ?? process.env;
  const now = (deps.now ?? (() => new Date()))();
  const thresholds = thresholdsFromEnv(env);
  const inputs = await (deps.load ?? loadAlertInputs)(now);

  const detected: DetectedAlert[] = [
    ...largeTransactionAlerts(inputs.recentTxns, thresholds),
    ...balanceDropAlerts(inputs.balancePairs, thresholds),
    ...itemLoginRequiredAlerts(inputs.brokenItems),
    ...staleSnapshotAlerts(inputs.accountStaleness, now, thresholds),
    ...stalePriceAlerts(inputs.symbolStaleness, now, thresholds),
    ...syncFailureAlerts(inputs.failedRuns),
  ];

  // Persist — idempotent on dedup_hash, so a standing condition fires once.
  let created = 0;
  if (detected.length > 0) {
    const inserted = await db
      .insert(alerts)
      .values(
        detected.map((d) => ({
          type: d.type,
          severity: d.severity,
          dedupHash: d.dedupHash,
          title: d.title,
          detail: d.detail,
        })),
      )
      .onConflictDoNothing({ target: alerts.dedupHash })
      .returning({ id: alerts.id });
    created = inserted.length;
  }

  // Resolve cleared conditions, per rule-managed type. backup_failure is NOT a
  // rule type, so it's never swept here (it clears only on user dismissal).
  const detectedHashesByType = new Map<string, string[]>();
  for (const d of detected) {
    const arr = detectedHashesByType.get(d.type) ?? [];
    arr.push(d.dedupHash);
    detectedHashesByType.set(d.type, arr);
  }
  let resolved = 0;
  for (const type of RULE_ALERT_TYPES) {
    const hashes = detectedHashesByType.get(type) ?? [];
    const conditions = [eq(alerts.type, type), isNull(alerts.resolvedAt)];
    if (hashes.length > 0) conditions.push(notInArray(alerts.dedupHash, hashes));
    const res = await db
      .update(alerts)
      .set({ resolvedAt: now })
      .where(and(...conditions))
      .returning({ id: alerts.id });
    resolved += res.length;
  }

  // Notify about everything still open + un-notified (incl. backup_failure rows
  // the backup job wrote). Email is content-free (P6-14); stamp on success.
  let notified = 0;
  const unnotified = await db
    .select({ id: alerts.id })
    .from(alerts)
    .where(and(isNull(alerts.notifiedAt), isNull(alerts.resolvedAt)));
  if (unnotified.length > 0) {
    const notifyFn = deps.notify ?? ((c: number, d: string) => notifyNewAlerts(c, d));
    const res = await notifyFn(unnotified.length, isoDate(now));
    if (res.sent) {
      await db
        .update(alerts)
        .set({ notifiedAt: now })
        .where(
          inArray(
            alerts.id,
            unnotified.map((r) => r.id),
          ),
        );
      notified = unnotified.length;
    }
  }

  return { created, resolved, notified };
}
