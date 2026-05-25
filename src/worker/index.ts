import { redisConnection } from "@/lib/queue/connection.ts";
import { QUEUE_NAMES, computeSnapshotsDailyQueue, heartbeatQueue } from "@/lib/queue/queues.ts";
import { Worker } from "bullmq";
import { computeSnapshotsDailyProcessor } from "./jobs/compute-snapshots-daily.ts";
import { heartbeatProcessor } from "./jobs/heartbeat.ts";

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

// Nightly snapshot job: every day at 02:00 local. Cron pattern "0 2 * * *".
await computeSnapshotsDailyQueue.removeJobScheduler("compute-snapshots-daily-cron").catch(() => {
  /* first run */
});
await computeSnapshotsDailyQueue.upsertJobScheduler(
  "compute-snapshots-daily-cron",
  { pattern: "0 2 * * *" },
  { name: "compute-snapshots-daily", data: {} },
);

/**
 * Graceful shutdown per bullmq-specialist guidance. Process SIGTERM and SIGINT,
 * stop accepting new jobs, drain in-flight, then close the Redis connection.
 */
async function shutdown(_signal: string): Promise<void> {
  await heartbeatWorker.close();
  await computeSnapshotsWorker.close();
  await heartbeatQueue.close();
  await computeSnapshotsDailyQueue.close();
  await redisConnection.quit();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
