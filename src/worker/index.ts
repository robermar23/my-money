import { redisConnection } from "@/lib/queue/connection.ts";
import {
  QUEUE_NAMES,
  backfillWatchlistSymbolQueue,
  backupDatabaseDailyQueue,
  computeSnapshotsDailyQueue,
  detectAnomaliesDailyQueue,
  detectObligationsWeeklyQueue,
  enqueuePlaidSyncsDailyQueue,
  evaluateAdviceQueue,
  evaluatePriceTargetsQueue,
  exportBeancountDailyQueue,
  fetchPricesDailyQueue,
  heartbeatQueue,
  materializeContributionsQueue,
  processImportQueue,
  projectCashFlowDailyQueue,
  recategorizeAllQueue,
  refreshFundamentalsWeeklyQueue,
  syncInvestmentsItemQueue,
  syncPlaidItemQueue,
} from "@/lib/queue/queues.ts";
import { effectiveZone, resolveScheduleZone } from "@/lib/schedule/zone.ts";
import { Worker } from "bullmq";
import { backfillWatchlistSymbolProcessor } from "./jobs/backfill-watchlist-symbol.ts";
import { backupDatabaseDailyProcessor } from "./jobs/backup-database-daily.ts";
import { computeSnapshotsDailyProcessor } from "./jobs/compute-snapshots-daily.ts";
import { detectAnomaliesDailyProcessor } from "./jobs/detect-anomalies-daily.ts";
import { detectObligationsWeeklyProcessor } from "./jobs/detect-obligations-weekly.ts";
import { enqueuePlaidSyncsDailyProcessor } from "./jobs/enqueue-plaid-syncs-daily.ts";
import { evaluateAdviceProcessor } from "./jobs/evaluate-advice.ts";
import { evaluatePriceTargetsProcessor } from "./jobs/evaluate-price-targets.ts";
import { exportBeancountDailyProcessor } from "./jobs/export-beancount-daily.ts";
import { fetchPricesDailyProcessor } from "./jobs/fetch-prices-daily.ts";
import { heartbeatProcessor } from "./jobs/heartbeat.ts";
import { materializeContributionsProcessor } from "./jobs/materialize-contributions.ts";
import { processImportProcessor } from "./jobs/process-import.ts";
import { projectCashFlowDailyProcessor } from "./jobs/project-cashflow-daily.ts";
import { recategorizeAllProcessor } from "./jobs/recategorize-all.ts";
import { refreshFundamentalsWeeklyProcessor } from "./jobs/refresh-fundamentals-weekly.ts";
import { syncInvestmentsItemProcessor } from "./jobs/sync-investments-item.ts";
import { syncPlaidItemProcessor } from "./jobs/sync-plaid-item.ts";
import { repeatFor } from "./schedule.ts";

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
  async (job) => {
    await computeSnapshotsDailyProcessor(job);
    // P15-36 — chain the guidance evaluation off the balances we just wrote.
    // The waterfall reads `account_snapshots`, so a cron that fired before this
    // job would evaluate against yesterday's numbers and could fire an alert
    // that is already wrong. Enqueued here (not inside the processor) so the
    // snapshot processor stays offline-testable.
    await evaluateAdviceQueue.add("evaluate-advice", {});
    // P16-27 — same reasoning, one step sharper: day zero of the cash-flow
    // projection IS the latest `account_snapshots` row per account, so a
    // projection built before this job ran is wrong by a day in exactly the
    // direction the household is asking about ("can I spend this today?").
    await projectCashFlowDailyQueue.add("project-cashflow-daily", {});
  },
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

// Phase 15 (P15-36): daily guidance evaluation. No cron — it rides the 02:00
// snapshot job above, so it always reads fresh balances.
const evaluateAdviceWorker = new Worker(
  QUEUE_NAMES.EVALUATE_ADVICE,
  async (job) => {
    await evaluateAdviceProcessor(job);
  },
  { connection: redisConnection, concurrency: 1 },
);
evaluateAdviceWorker.on("failed", (job, err) => {
  console.error(`[worker] evaluate-advice job ${job?.id} failed:`, err);
});

// Phase 16 (P16-27): daily materialize + match sweep + projection alerts. No
// cron — it rides the 02:00 snapshot job above, so the walk always opens on
// today's balances.
const projectCashFlowDailyWorker = new Worker(
  QUEUE_NAMES.PROJECT_CASHFLOW_DAILY,
  async (job) => {
    await projectCashFlowDailyProcessor(job);
  },
  { connection: redisConnection, concurrency: 1 },
);
projectCashFlowDailyWorker.on("failed", (job, err) => {
  console.error(`[worker] project-cashflow-daily job ${job?.id} failed:`, err);
});

// Phase 16 (P16-26): weekly recurring-obligation detection. Writes nothing —
// it re-derives the candidate list, which is the canary on the detector and the
// count the review surface shows.
const detectObligationsWeeklyWorker = new Worker(
  QUEUE_NAMES.DETECT_OBLIGATIONS_WEEKLY,
  async (job) => {
    await detectObligationsWeeklyProcessor(job);
  },
  { connection: redisConnection, concurrency: 1 },
);
detectObligationsWeeklyWorker.on("failed", (job, err) => {
  console.error(`[worker] detect-obligations-weekly job ${job?.id} failed:`, err);
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

// Phase 14 (P14-09): nightly payroll-contribution materialization. concurrency=1
// — a single sequential pass over the user's rules, each contribution in its own
// DB transaction.
const materializeContributionsWorker = new Worker(
  QUEUE_NAMES.MATERIALIZE_CONTRIBUTIONS,
  // Wrapped so BullMQ's (job, token) signature doesn't land a string in the
  // processor's optional options parameter.
  async (job) => {
    await materializeContributionsProcessor(job);
  },
  { connection: redisConnection, concurrency: 1 },
);
materializeContributionsWorker.on("failed", (job, err) => {
  console.error(`[worker] materialize-contributions job ${job?.id} failed:`, err);
});

// P19-24 — Each cron job below names its clock in `./schedule.ts`: the data
// chain on UTC, the backup and Beancount export on the operator's `TZ`. An
// invalid `TZ` falls back to UTC with this warning instead of reaching the cron
// library, whose error for it would stop the worker at boot, backups included.
const scheduleZone = resolveScheduleZone(process.env.TZ);
const operatorZone = effectiveZone(scheduleZone);
if (scheduleZone.kind === "invalid") {
  console.error(
    `[worker] TZ=${JSON.stringify(scheduleZone.raw)} is not a time zone this runtime knows; the backup and Beancount export run on UTC.`,
  );
}

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

// Nightly price-fetch job: every day at 01:30 UTC. Runs BEFORE the snapshot
// job at 02:00 so today's prices are in the table before holdings get valued.
await fetchPricesDailyQueue.removeJobScheduler("fetch-prices-daily-cron").catch(() => {
  /* first run */
});
await fetchPricesDailyQueue.upsertJobScheduler(
  "fetch-prices-daily-cron",
  repeatFor("fetch-prices-daily-cron", operatorZone),
  { name: "fetch-prices-daily", data: {} },
);

// P14-10 — Nightly contribution materialization at 01:45 UTC, wedged into the
// existing chain: AFTER the 01:30 price fetch so a same-day pay date prices off
// a same-day close, and BEFORE the 02:00 snapshot so the lots and quantities it
// writes are valued that same night. The price ordering is an optimization, not
// a correctness dependency — `latestCloseOnOrBefore` falls back to the previous
// close, and a pay date with no price at all degrades to basis-only (ADR-031).
await materializeContributionsQueue
  .removeJobScheduler("materialize-contributions-cron")
  .catch(() => {
    /* first run */
  });
await materializeContributionsQueue.upsertJobScheduler(
  "materialize-contributions-cron",
  repeatFor("materialize-contributions-cron", operatorZone),
  { name: "materialize-contributions", data: {} },
);

// Nightly snapshot job: every day at 02:00 UTC. Cron pattern "0 2 * * *".
await computeSnapshotsDailyQueue.removeJobScheduler("compute-snapshots-daily-cron").catch(() => {
  /* first run */
});
await computeSnapshotsDailyQueue.upsertJobScheduler(
  "compute-snapshots-daily-cron",
  repeatFor("compute-snapshots-daily-cron", operatorZone),
  { name: "compute-snapshots-daily", data: {} },
);

// P4-27 — Daily Plaid safety-net fan-out at 03:00 UTC. Runs AFTER the snapshot
// job so any cron-triggered sync that produces snapshot drift is captured by
// the next day's snapshot run.
await enqueuePlaidSyncsDailyQueue.removeJobScheduler("enqueue-plaid-syncs-daily-cron").catch(() => {
  /* first run */
});
await enqueuePlaidSyncsDailyQueue.upsertJobScheduler(
  "enqueue-plaid-syncs-daily-cron",
  repeatFor("enqueue-plaid-syncs-daily-cron", operatorZone),
  { name: "enqueue-plaid-syncs-daily", data: {} },
);

// P6-05 — Nightly encrypted backup at 04:00 in the operator's zone (`TZ`,
// P19-24; UTC when unset). Whatever the zone, the most recent 03:00 UTC Plaid
// safety-net has already run, so the dump captures that day's synced data.
await backupDatabaseDailyQueue.removeJobScheduler("backup-database-daily-cron").catch(() => {
  /* first run */
});
await backupDatabaseDailyQueue.upsertJobScheduler(
  "backup-database-daily-cron",
  repeatFor("backup-database-daily-cron", operatorZone),
  { name: "backup-database-daily", data: {} },
);

// P6-10 — Nightly beancount export at 04:30 in the operator's zone, AFTER the
// 04:00 backup so the encrypted dump and the plain-text mirror reflect the same
// day's data. Both follow `TZ`, so that ordering holds in every zone.
await exportBeancountDailyQueue.removeJobScheduler("export-beancount-daily-cron").catch(() => {
  /* first run */
});
await exportBeancountDailyQueue.upsertJobScheduler(
  "export-beancount-daily-cron",
  repeatFor("export-beancount-daily-cron", operatorZone),
  { name: "export-beancount-daily", data: {} },
);

// P6-16 — Nightly anomaly detection at 05:00 UTC. With `TZ` unset that is AFTER
// the 04:00 backup, so a failed backup (which writes a backup_failure alert) is
// detectable + notified; `./schedule.ts` says what setting `TZ` does to that.
await detectAnomaliesDailyQueue.removeJobScheduler("detect-anomalies-daily-cron").catch(() => {
  /* first run */
});
await detectAnomaliesDailyQueue.upsertJobScheduler(
  "detect-anomalies-daily-cron",
  repeatFor("detect-anomalies-daily-cron", operatorZone),
  { name: "detect-anomalies-daily", data: {} },
);

// P9-07 — Weekly security enrichment refresh, Sundays at 06:00 UTC. Cadence is
// weekly because sector/industry/forward-dividend change slowly; running after
// the nightly jobs keeps it off the busy overnight window.
await refreshFundamentalsWeeklyQueue
  .removeJobScheduler("refresh-fundamentals-weekly-cron")
  .catch(() => {
    /* first run */
  });
await refreshFundamentalsWeeklyQueue.upsertJobScheduler(
  "refresh-fundamentals-weekly-cron",
  repeatFor("refresh-fundamentals-weekly-cron", operatorZone),
  { name: "refresh-fundamentals-weekly", data: {} },
);

// P16-26 — Weekly recurring-obligation detection, Sundays at 06:30 UTC.
//
// `cron-doctor` on the expression, because a new schedule IS its trigger
// condition: `"30 6 * * 0"` is minute 30, hour 6, EVERY day-of-month, EVERY
// month, day-of-week 0 (Sunday). The classic cron trap — day-of-month and
// day-of-week being OR'd rather than AND'd, so a schedule fires far more often
// than its author intended — cannot bite here, because day-of-month is `*`;
// the OR only produces surprises when BOTH fields are restricted. Single fixed
// minute, so nothing stacks: the next firing is a week away and this job takes
// seconds. And 06:30 is a genuinely free slot — the 06:00 Sunday fundamentals
// refresh above is the only other weekly job, and it is done long before.
await detectObligationsWeeklyQueue
  .removeJobScheduler("detect-obligations-weekly-cron")
  .catch(() => {
    /* first run */
  });
await detectObligationsWeeklyQueue.upsertJobScheduler(
  "detect-obligations-weekly-cron",
  repeatFor("detect-obligations-weekly-cron", operatorZone),
  { name: "detect-obligations-weekly", data: {} },
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
  await evaluateAdviceWorker.close();
  await materializeContributionsWorker.close();
  await projectCashFlowDailyWorker.close();
  await detectObligationsWeeklyWorker.close();
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
  await evaluateAdviceQueue.close();
  await materializeContributionsQueue.close();
  await projectCashFlowDailyQueue.close();
  await detectObligationsWeeklyQueue.close();
  await redisConnection.quit();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
