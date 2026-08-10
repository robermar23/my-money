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
  /** Phase 2: daily refresh of `prices` for every distinct held symbol. */
  FETCH_PRICES_DAILY: "fetch-prices-daily",
  /** Phase 3: parse an uploaded QFX/CSV file into `parsed_payload` (preview-ready). */
  PROCESS_IMPORT: "process-import",
  /** Phase 3: re-evaluate category rules over existing (non-overridden) transactions. */
  RECATEGORIZE_ALL: "recategorize-all",
  /** Phase 4: pull /transactions/sync for a single plaid Item (webhook | manual | cron | initial). */
  SYNC_PLAID_ITEM: "sync-plaid-item",
  /** Phase 5 (P5-16): pull /investments/holdings + /investments/transactions for an Item. */
  SYNC_INVESTMENTS_ITEM: "sync-investments-item",
  /** Phase 4 (P4-27): 03:00 daily fan-out — enqueue a cron sync for every active Item. */
  ENQUEUE_PLAID_SYNCS_DAILY: "enqueue-plaid-syncs-daily",
  /** Phase 6 (P6-05): 04:00 nightly `pg_dump | age` encrypted database backup. */
  BACKUP_DATABASE_DAILY: "backup-database-daily",
  /** Phase 6 (P6-10): 04:30 nightly plain-text beancount export (longevity hedge). */
  EXPORT_BEANCOUNT_DAILY: "export-beancount-daily",
  /** Phase 6 (P6-16): 05:00 nightly anomaly detection → `alerts` + notification. */
  DETECT_ANOMALIES_DAILY: "detect-anomalies-daily",
  /** Phase 9 (P9-07): weekly security enrichment (sector/industry/dividend) refresh. */
  REFRESH_FUNDAMENTALS_WEEKLY: "refresh-fundamentals-weekly",
  /** Phase 11 (P11-08): on-add history backfill for a newly-followed watchlist symbol. */
  BACKFILL_WATCHLIST_SYMBOL: "backfill-watchlist-symbol",
  /** Phase 11 (P11-11): one-shot watchlist price-target evaluation, chained off the price fetch. */
  EVALUATE_PRICE_TARGETS: "evaluate-price-targets",
  /** Phase 14 (P14-09): turn each due pay date into a contribution buy + cost-basis lot. */
  MATERIALIZE_CONTRIBUTIONS: "materialize-contributions",
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

/**
 * Creates a lazily-constructed BullMQ queue.
 *
 * The real `Queue` is built on first property access, not at module load.
 * Constructing a `Queue` eagerly touches {@link redisConnection} (BullMQ
 * duck-types it), which would open a socket / require `REDIS_URL` during
 * `next build` — when the webhook route imports this module but the env var is
 * legitimately unset inside the build container. Deferring keeps importing this
 * module side-effect-free; the queue (and its connection) materialize only when
 * something actually enqueues or inspects a job at request/worker time.
 *
 * @param name - The queue name from {@link QUEUE_NAMES}.
 * @returns A proxy that behaves as a `Queue`, instantiated on first use.
 */
function lazyQueue(name: QueueName): Queue {
  let queue: Queue | undefined;
  return new Proxy({} as Queue, {
    get(_target, prop) {
      if (!queue) {
        queue = new Queue(name, { connection: redisConnection, defaultJobOptions });
      }
      const value = Reflect.get(queue, prop, queue);
      return typeof value === "function" ? value.bind(queue) : value;
    },
  });
}

export const heartbeatQueue = lazyQueue(QUEUE_NAMES.HEARTBEAT);

export const computeSnapshotsDailyQueue = lazyQueue(QUEUE_NAMES.COMPUTE_SNAPSHOTS_DAILY);

export const fetchPricesDailyQueue = lazyQueue(QUEUE_NAMES.FETCH_PRICES_DAILY);

export const processImportQueue = lazyQueue(QUEUE_NAMES.PROCESS_IMPORT);

export const recategorizeAllQueue = lazyQueue(QUEUE_NAMES.RECATEGORIZE_ALL);

export const syncPlaidItemQueue = lazyQueue(QUEUE_NAMES.SYNC_PLAID_ITEM);

export const syncInvestmentsItemQueue = lazyQueue(QUEUE_NAMES.SYNC_INVESTMENTS_ITEM);

export const enqueuePlaidSyncsDailyQueue = lazyQueue(QUEUE_NAMES.ENQUEUE_PLAID_SYNCS_DAILY);

export const backupDatabaseDailyQueue = lazyQueue(QUEUE_NAMES.BACKUP_DATABASE_DAILY);

export const exportBeancountDailyQueue = lazyQueue(QUEUE_NAMES.EXPORT_BEANCOUNT_DAILY);

export const detectAnomaliesDailyQueue = lazyQueue(QUEUE_NAMES.DETECT_ANOMALIES_DAILY);

export const refreshFundamentalsWeeklyQueue = lazyQueue(QUEUE_NAMES.REFRESH_FUNDAMENTALS_WEEKLY);

export const backfillWatchlistSymbolQueue = lazyQueue(QUEUE_NAMES.BACKFILL_WATCHLIST_SYMBOL);

export const evaluatePriceTargetsQueue = lazyQueue(QUEUE_NAMES.EVALUATE_PRICE_TARGETS);

export const materializeContributionsQueue = lazyQueue(QUEUE_NAMES.MATERIALIZE_CONTRIBUTIONS);
