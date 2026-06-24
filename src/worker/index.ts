import { redisConnection } from "@/lib/queue/connection.ts";
import {
  QUEUE_NAMES,
  backfillWatchlistSymbolQueue,
  backupDatabaseDailyQueue,
  computeSnapshotsDailyQueue,
  detectAnomaliesDailyQueue,
  enqueuePlaidSyncsDailyQueue,
  evaluatePriceTargetsQueue,
  exportBeancountDailyQueue,
  fetchPricesDailyQueue,
  heartbeatQueue,
  processImportQueue,
  recategorizeAllQueue,
  refreshFundamentalsWeeklyQueue,
  syncInvestmentsItemQueue,
  syncPlaidItemQueue,
} from "@/lib/queue/queues.ts";
import { Worker } from "bullmq";
import { backfillWatchlistSymbolProcessor } from "./jobs/backfill-watchlist-symbol.ts";
import { backupDatabaseDailyProcessor } from "./jobs/backup-database-daily.ts";
import { computeSnapshotsDailyProcessor } from "./jobs/compute-snapshots-daily.ts";
import { detectAnomaliesDailyProcessor } from "./jobs/detect-anomalies-daily.ts";
import { enqueuePlaidSyncsDailyProcessor } from "./jobs/enqueue-plaid-syncs-daily.ts";
import { evaluatePriceTargetsProcessor } from "./jobs/evaluate-price-targets.ts";
import { exportBeancountDailyProcessor } from "./jobs/export-beancount-daily.ts";
import { fetchPricesDailyProcessor } from "./jobs/fetch-prices-daily.ts";
import { heartbeatProcessor } from "./jobs/heartbeat.ts";
import { processImportProcessor } from "./jobs/process-import.ts";
import { recategorizeAllProcessor } from "./jobs/recategorize-all.ts";
import { refreshFundamentalsWeeklyProcessor } from "./jobs/refresh-fundamentals-weekly.ts";
import { syncInvestmentsItemProcessor } from "./jobs/sync-investments-item.ts";
import { syncPlaidItemProcessor } from "./jobs/sync-plaid-item.ts";

/**
 * BullMQ worker entrypoint.
 *
 * Started as a separate process from the Next.js web app (`pnpm worker`).
 * Both share the same `src/` codebase so domain logic isn't duplicated.
 *
 * Phase 0 only schedules a 60-second heartbeat repeatable job. Phase 1 will
 * add `compute-snapshots-daily`; later phases add Plaid sync + price fetch.
 */

const heartbeatWorker = new Worker(QUEUE_NAMES.HEARTBEAT, heartbeatProcessor, {
  connection: redisConnection,
  concurrency: 1,
});

heartbeatWorker.on("ready", () => {});
heartbeatWorker.on("failed", (job, err) => {
  console.error(`[worker] heartbeat job ${job?.id} failed:`, err);
});

const computeSnapshotsWorker = new Worker(
  QUEUE_NAMES.COMPUTE_SNAPSHOTS_DAILY,
  computeSnapshotsDailyProcessor,
  { connection: redisConnection, concurrency: 1 },
);
computeSnapshotsWorker.on("failed", (job, err) => {
  console.error(`[worker] compute-snapshots-daily job ${job?.id} failed:`, err);
});

const fetchPricesWorker = new Worker(
  QUEUE_NAMES.FETCH_PRICES_DAILY,
  // Wrap so BullMQ's (job, token) signature doesn't try to pass a string
  // through the processor's optional 2nd parameter (PriceRouter for testing).
  async (job) => {
    await fetchPricesDailyProcessor(job);
    // P11-12 — chain the one-shot price-target evaluator off the FRESH closes
    // we just wrote, so it sees today's prices with no race. Enqueued here (not
    // inside the processor) so the processor stays offline-testable. No cron:
    // the evaluator rides the 01:30 fetch.
    await evaluatePriceTargetsQueue.add("evaluate-price-targets", {});
  },
  { connection: redisConnection, concurrency: 1 },
);
fetchPricesWorker.on("failed", (job, err) => {
  console.error(`[worker] fetch-prices-daily job ${job?.id} failed:`, err);
});

// Phase 11 (P11-11): one-shot watchlist price-target evaluator. No cron — it is
// enqueued by the fetch worker above once the day's closes are in `prices`.
const evaluatePriceTargetsWorker = new Worker(
  QUEUE_NAMES.EVALUATE_PRICE_TARGETS,
  async (job) => {
    await evaluatePriceTargetsProcessor(job);
  },
  { connection: redisConnection, concurrency: 1 },
);
evaluatePriceTargetsWorker.on("failed", (job, err) => {
  console.error(`[worker] evaluate-price-targets job ${job?.id} failed:`, err);
});

const processImportWorker = new Worker(QUEUE_NAMES.PROCESS_IMPORT, processImportProcessor, {
  connection: redisConnection,
  concurrency: 2,
});
processImportWorker.on("failed", (job, err) => {
  console.error(`[worker] process-import job ${job?.id} failed:`, err);
});

const recategorizeAllWorker = new Worker(QUEUE_NAMES.RECATEGORIZE_ALL, recategorizeAllProcessor, {
  connection: redisConnection,
  concurrency: 1,
});
recategorizeAllWorker.on("failed", (job, err) => {
  console.error(`[worker] recategorize-all job ${job?.id} failed:`, err);
});

// Phase 4: Plaid sync. concurrency=1 so a webhook burst doesn't blow Plaid's
// rate limit (their app-wide budget is shared across all in-flight calls).
const syncPlaidItemWorker = new Worker(QUEUE_NAMES.SYNC_PLAID_ITEM, syncPlaidItemProcessor, {
  connection: redisConnection,
  concurrency: 1,
});
syncPlaidItemWorker.on("failed", (job, err) => {
  console.error(`[worker] sync-plaid-item job ${job?.id} failed:`, err);
});

// Phase 5: Plaid Investments sync (holdings + investment transactions).
// concurrency=1 for the same Plaid rate-limit reason as the transactions sync.
const syncInvestmentsItemWorker = new Worker(
  QUEUE_NAMES.SYNC_INVESTMENTS_ITEM,
  syncInvestmentsItemProcessor,
  { connection: redisConnection, concurrency: 1 },
);
syncInvestmentsItemWorker.on("failed", (job, err) => {
  console.error(`[worker] sync-investments-item job ${job?.id} failed:`, err);
});

// P4-27: 03:00 daily fan-out — enqueues a cron sync for every active Item.
// Lightweight; runs in series with the heavier sync queue so we don't race the
// snapshot or price jobs that just finished at 02:00.
const enqueuePlaidSyncsDailyWorker = new Worker(
  QUEUE_NAMES.ENQUEUE_PLAID_SYNCS_DAILY,
  enqueuePlaidSyncsDailyProcessor,
  { connection: redisConnection, concurrency: 1 },
);
enqueuePlaidSyncsDailyWorker.on("failed", (job, err) => {
  console.error(`[worker] enqueue-plaid-syncs-daily job ${job?.id} failed:`, err);
});

// Phase 6 (P6-05): nightly encrypted backup. concurrency=1 — one pg_dump at a
// time is plenty for a single DB; a failed run retries via BullMQ backoff.
const backupDatabaseDailyWorker = new Worker(
  QUEUE_NAMES.BACKUP_DATABASE_DAILY,
  // Wrap so BullMQ's (job, token) signature doesn't collide with the optional
  // 2nd `deps` param the processor accepts for testing.
  async (job) => {
    await backupDatabaseDailyProcessor(job);
  },
  { connection: redisConnection, concurrency: 1 },
);
backupDatabaseDailyWorker.on("failed", (job, err) => {
  console.error(`[worker] backup-database-daily job ${job?.id} failed:`, err);
});

// Phase 6 (P6-10): nightly beancount export. Wrapped for the same (job, token)
// reason; concurrency 1 — a single deterministic file write.
const exportBeancountDailyWorker = new Worker(
  QUEUE_NAMES.EXPORT_BEANCOUNT_DAILY,
  async (job) => {
    await exportBeancountDailyProcessor(job);
  },
  { connection: redisConnection, concurrency: 1 },
);
exportBeancountDailyWorker.on("failed", (job, err) => {
  console.error(`[worker] export-beancount-daily job ${job?.id} failed:`, err);
});

// Phase 6 (P6-16): nightly anomaly detection → alerts + notification email.
const detectAnomaliesDailyWorker = new Worker(
  QUEUE_NAMES.DETECT_ANOMALIES_DAILY,
  async (job) => {
    await detectAnomaliesDailyProcessor(job);
  },
  { connection: redisConnection, concurrency: 1 },
);
detectAnomaliesDailyWorker.on("failed", (job, err) => {
  console.error(`[worker] detect-anomalies-daily job ${job?.id} failed:`, err);
});

// Phase 9 (P9-07): weekly security-enrichment refresh. concurrency=1 — a single
// rate-limited pass over stale securities; failures retry via BullMQ backoff.
const refreshFundamentalsWeeklyWorker = new Worker(
  QUEUE_NAMES.REFRESH_FUNDAMENTALS_WEEKLY,
  async (job) => {
    await refreshFundamentalsWeeklyProcessor(job);
  },
  { connection: redisConnection, concurrency: 1 },
);
refreshFundamentalsWeeklyWorker.on("failed", (job, err) => {
  console.error(`[worker] refresh-fundamentals-weekly job ${job?.id} failed:`, err);
});

// Phase 11 (P11-08): on-demand watchlist history backfill. No cron — enqueued by
// the create-watchlist-item server action. concurrency=1 keeps it off the
// nightly fetch's rate-limit budget (it hits the same Yahoo/CoinGecko hosts).
const backfillWatchlistSymbolWorker = new Worker(
  QUEUE_NAMES.BACKFILL_WATCHLIST_SYMBOL,
  async (job) => {
    await backfillWatchlistSymbolProcessor(job);
  },
  { connection: redisConnection, concurrency: 1 },
);
backfillWatchlistSymbolWorker.on("failed", (job, err) => {
  console.error(`[worker] backfill-watchlist-symbol job ${job?.id} failed:`, err);
});

// Ensure a single heartbeat repeatable job exists. Removing first guards against
// pattern duplication across restarts.
await heartbeatQueue.removeJobScheduler("heartbeat-tick").catch(() => {
  /* first run — nothing to remove */
});
await heartbeatQueue.upsertJobScheduler(
  "heartbeat-tick",
  { every: 60_000 },
  { name: "heartbeat-tick", data: {} },
);

// Nightly price-fetch job: every day at 01:30 local. Runs BEFORE the snapshot
// job at 02:00 so today's prices are in the table before holdings get valued.
await fetchPricesDailyQueue.removeJobScheduler("fetch-prices-daily-cron").catch(() => {
  /* first run */
});
await fetchPricesDailyQueue.upsertJobScheduler(
  "fetch-prices-daily-cron",
  { pattern: "30 1 * * *" },
  { name: "fetch-prices-daily", data: {} },
);

// Nightly snapshot job: every day at 02:00 local. Cron pattern "0 2 * * *".
await computeSnapshotsDailyQueue.removeJobScheduler("compute-snapshots-daily-cron").catch(() => {
  /* first run */
});
await computeSnapshotsDailyQueue.upsertJobScheduler(
  "compute-snapshots-daily-cron",
  { pattern: "0 2 * * *" },
  { name: "compute-snapshots-daily", data: {} },
);

// P4-27 — Daily Plaid safety-net fan-out at 03:00 local. Runs AFTER the snapshot
// job so any cron-triggered sync that produces snapshot drift is captured by
// the next day's snapshot run.
await enqueuePlaidSyncsDailyQueue.removeJobScheduler("enqueue-plaid-syncs-daily-cron").catch(() => {
  /* first run */
});
await enqueuePlaidSyncsDailyQueue.upsertJobScheduler(
  "enqueue-plaid-syncs-daily-cron",
  { pattern: "0 3 * * *" },
  { name: "enqueue-plaid-syncs-daily", data: {} },
);

// P6-05 — Nightly encrypted backup at 04:00 local, AFTER the 03:00 Plaid
// safety-net so the dump captures that day's synced transactions.
await backupDatabaseDailyQueue.removeJobScheduler("backup-database-daily-cron").catch(() => {
  /* first run */
});
await backupDatabaseDailyQueue.upsertJobScheduler(
  "backup-database-daily-cron",
  { pattern: "0 4 * * *" },
  { name: "backup-database-daily", data: {} },
);

// P6-10 — Nightly beancount export at 04:30 local, AFTER the 04:00 backup so the
// encrypted dump and the plain-text mirror reflect the same day's data.
await exportBeancountDailyQueue.removeJobScheduler("export-beancount-daily-cron").catch(() => {
  /* first run */
});
await exportBeancountDailyQueue.upsertJobScheduler(
  "export-beancount-daily-cron",
  { pattern: "30 4 * * *" },
  { name: "export-beancount-daily", data: {} },
);

// P6-16 — Nightly anomaly detection at 05:00 local, AFTER the 04:00 backup so a
// failed backup (which writes a backup_failure alert) is detectable + notified.
await detectAnomaliesDailyQueue.removeJobScheduler("detect-anomalies-daily-cron").catch(() => {
  /* first run */
});
await detectAnomaliesDailyQueue.upsertJobScheduler(
  "detect-anomalies-daily-cron",
  { pattern: "0 5 * * *" },
  { name: "detect-anomalies-daily", data: {} },
);

// P9-07 — Weekly security enrichment refresh, Sundays at 06:00 local. Cadence is
// weekly because sector/industry/forward-dividend change slowly; running after
// the nightly jobs keeps it off the busy overnight window.
await refreshFundamentalsWeeklyQueue
  .removeJobScheduler("refresh-fundamentals-weekly-cron")
  .catch(() => {
    /* first run */
  });
await refreshFundamentalsWeeklyQueue.upsertJobScheduler(
  "refresh-fundamentals-weekly-cron",
  { pattern: "0 6 * * 0" },
  { name: "refresh-fundamentals-weekly", data: {} },
);

/**
 * Graceful shutdown per bullmq-specialist guidance. Process SIGTERM and SIGINT,
 * stop accepting new jobs, drain in-flight, then close the Redis connection.
 */
async function shutdown(_signal: string): Promise<void> {
  await heartbeatWorker.close();
  await computeSnapshotsWorker.close();
  await fetchPricesWorker.close();
  await processImportWorker.close();
  await recategorizeAllWorker.close();
  await syncPlaidItemWorker.close();
  await syncInvestmentsItemWorker.close();
  await enqueuePlaidSyncsDailyWorker.close();
  await backupDatabaseDailyWorker.close();
  await exportBeancountDailyWorker.close();
  await detectAnomaliesDailyWorker.close();
  await refreshFundamentalsWeeklyWorker.close();
  await backfillWatchlistSymbolWorker.close();
  await evaluatePriceTargetsWorker.close();
  await heartbeatQueue.close();
  await computeSnapshotsDailyQueue.close();
  await fetchPricesDailyQueue.close();
  await processImportQueue.close();
  await recategorizeAllQueue.close();
  await syncPlaidItemQueue.close();
  await syncInvestmentsItemQueue.close();
  await enqueuePlaidSyncsDailyQueue.close();
  await backupDatabaseDailyQueue.close();
  await exportBeancountDailyQueue.close();
  await detectAnomaliesDailyQueue.close();
  await refreshFundamentalsWeeklyQueue.close();
  await backfillWatchlistSymbolQueue.close();
  await evaluatePriceTargetsQueue.close();
  await redisConnection.quit();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
