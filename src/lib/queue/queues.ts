import { type JobsOptions, Queue } from "bullmq";
import { redisConnection } from "./connection.ts";

/**
 * Sensible default job options for every queue in my-money.
 *
 * Per bullmq-specialist + CLAUDE.md §Background Jobs:
 *   - Retry 3x with exponential backoff to absorb transient errors.
 *   - Keep last 1000 completed + 5000 failed for visibility; older jobs are pruned.
 */
const defaultJobOptions: JobsOptions = {
  attempts: 3,
  backoff: { type: "exponential", delay: 1_000 },
  removeOnComplete: { count: 1_000 },
  removeOnFail: { count: 5_000 },
};

/**
 * Queue names — single source of truth.
 *
 * Stays a `const` enum-style object so workers and producers can reference them
 * by name without typos.
 */
export const QUEUE_NAMES = {
  /** Phase 0 placeholder: a heartbeat job to confirm worker plumbing. */
  HEARTBEAT: "heartbeat",
  /** Phase 1: nightly snapshot for every account into account_snapshots. */
  COMPUTE_SNAPSHOTS_DAILY: "compute-snapshots-daily",
  // Phase 2:
  //   FETCH_PRICES_DAILY: "fetch-prices-daily",
  // Phase 3:
  //   PROCESS_QFX_IMPORT: "process-qfx-import",
  // Phase 4:
  //   SYNC_PLAID_ITEM: "sync-plaid-item",
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

export const heartbeatQueue = new Queue(QUEUE_NAMES.HEARTBEAT, {
  connection: redisConnection,
  defaultJobOptions,
});

export const computeSnapshotsDailyQueue = new Queue(QUEUE_NAMES.COMPUTE_SNAPSHOTS_DAILY, {
  connection: redisConnection,
  defaultJobOptions,
});
