import { redisConnection } from "@/lib/queue/connection.ts";
import {
  QUEUE_NAMES,
  computeSnapshotsDailyQueue,
  enqueuePlaidSyncsDailyQueue,
  fetchPricesDailyQueue,
  heartbeatQueue,
  processImportQueue,
  recategorizeAllQueue,
  syncInvestmentsItemQueue,
  syncPlaidItemQueue,
} from "@/lib/queue/queues.ts";
import { Worker } from "bullmq";
import { computeSnapshotsDailyProcessor } from "./jobs/compute-snapshots-daily.ts";
import { enqueuePlaidSyncsDailyProcessor } from "./jobs/enqueue-plaid-syncs-daily.ts";
import { fetchPricesDailyProcessor } from "./jobs/fetch-prices-daily.ts";
import { heartbeatProcessor } from "./jobs/heartbeat.ts";
import { processImportProcessor } from "./jobs/process-import.ts";
import { recategorizeAllProcessor } from "./jobs/recategorize-all.ts";
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
  },
  { connection: redisConnection, concurrency: 1 },
);
fetchPricesWorker.on("failed", (job, err) => {
  console.error(`[worker] fetch-prices-daily job ${job?.id} failed:`, err);
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
  await heartbeatQueue.close();
  await computeSnapshotsDailyQueue.close();
  await fetchPricesDailyQueue.close();
  await processImportQueue.close();
  await recategorizeAllQueue.close();
  await syncPlaidItemQueue.close();
  await syncInvestmentsItemQueue.close();
  await enqueuePlaidSyncsDailyQueue.close();
  await redisConnection.quit();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
