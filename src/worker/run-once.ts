/**
 * One-off worker runner: invokes a single job processor directly (no Redis
 * scheduling), useful for manual verification and CI smoke tests.
 *
 * Usage:
 *   node --env-file=.env.local --import tsx src/worker/run-once.ts <job-name>
 *
 * Supported job names:
 *   - compute-snapshots-daily
 *   - fetch-prices-daily
 *   - heartbeat
 *   - backup-database-daily
 *   - export-beancount-daily
 *   - detect-anomalies-daily
 *   - backfill-categories
 *   - backfill-holding-snapshots
 *   - refresh-fundamentals-weekly
 *   - evaluate-price-targets
 *   - evaluate-advice
 *   - materialize-contributions
 *   - backfill-contributions
 */
// Every processor below is imported dynamically, which leaves this file with no
// static imports — and a script with neither imports nor exports is a CommonJS
// script to TypeScript, where top-level `await` is an error. This marks it ESM.
export {};

const jobName = process.argv[2];

/**
 * Job name → a thunk that imports its module and runs it.
 *
 * Every entry is a DYNAMIC import on purpose. Statically importing all fifteen
 * processors meant one job's module graph could abort a run of an unrelated job:
 * `backfill-history.ts` carries Next's `server-only` marker, which resolves only
 * under `scripts/loaders/register.mjs`, so invoking this script without that
 * loader crashed on module load before any job name was even read. Lazy imports
 * pull in exactly the one graph the caller asked for, and a broken job stays
 * broken alone.
 */
const PROCESSORS: Record<string, (job: never) => Promise<unknown>> = {
  "compute-snapshots-daily": (async (job: never) =>
    (await import("./jobs/compute-snapshots-daily.ts")).computeSnapshotsDailyProcessor(
      job,
    )) as never,
  "fetch-prices-daily": (async (job: never) =>
    (await import("./jobs/fetch-prices-daily.ts")).fetchPricesDailyProcessor(job)) as never,
  heartbeat: (async (job: never) =>
    (await import("./jobs/heartbeat.ts")).heartbeatProcessor(job)) as never,
  "process-import": (async (job: never) =>
    (await import("./jobs/process-import.ts")).processImportProcessor(job)) as never,
  "recategorize-all": (async (job: never) =>
    (await import("./jobs/recategorize-all.ts")).recategorizeAllProcessor(job)) as never,
  "backup-database-daily": (async (job: never) =>
    (await import("./jobs/backup-database-daily.ts")).backupDatabaseDailyProcessor(job)) as never,
  "export-beancount-daily": (async (job: never) =>
    (await import("./jobs/export-beancount-daily.ts")).exportBeancountDailyProcessor(job)) as never,
  "detect-anomalies-daily": (async (job: never) =>
    (await import("./jobs/detect-anomalies-daily.ts")).detectAnomaliesDailyProcessor(job)) as never,
  "backfill-categories": (async (job: never) =>
    (await import("./jobs/backfill-categories.ts")).backfillCategoriesProcessor(job)) as never,
  // Not a BullMQ job — a one-shot lib fn; ignore the fake job arg.
  "backfill-holding-snapshots": (async () => {
    const { backfillHoldingSnapshots } = await import("../lib/investments/backfill-history.ts");
    console.info("[run-once] backfill-holding-snapshots:", await backfillHoldingSnapshots());
  }) as never,
  "refresh-fundamentals-weekly": (async (job: never) =>
    (await import("./jobs/refresh-fundamentals-weekly.ts")).refreshFundamentalsWeeklyProcessor(
      job,
    )) as never,
  "evaluate-price-targets": (async (job: never) =>
    (await import("./jobs/evaluate-price-targets.ts")).evaluatePriceTargetsProcessor(job)) as never,
  // P15-36 — logs counts only. A recommendation's figures never reach a log line.
  "evaluate-advice": (async (job: never) => {
    const { evaluateAdviceProcessor } = await import("./jobs/evaluate-advice.ts");
    console.info("[run-once] evaluate-advice:", await evaluateAdviceProcessor(job));
  }) as never,
  // P14-09/P14-11 — the nightly window, then the full historical walk (which
  // also includes paused sources). Both log only counts; no gross, contribution,
  // or match figure is ever printed.
  "materialize-contributions": (async (job: never) => {
    const { materializeContributionsProcessor } = await import(
      "./jobs/materialize-contributions.ts"
    );
    console.info(
      "[run-once] materialize-contributions:",
      await materializeContributionsProcessor(job),
    );
  }) as never,
  "backfill-contributions": (async (job: never) => {
    const { backfillContributionsProcessor } = await import("./jobs/backfill-contributions.ts");
    console.info("[run-once] backfill-contributions:", await backfillContributionsProcessor(job));
  }) as never,
};

if (!jobName || !PROCESSORS[jobName]) {
  console.error(`Unknown or missing job name. Supported: ${Object.keys(PROCESSORS).join(", ")}`);
  process.exit(1);
}

const fakeJob = { id: `manual-${Date.now()}`, name: jobName, data: {} } as never;
try {
  await PROCESSORS[jobName](fakeJob);
  process.exit(0);
} catch (err) {
  console.error(`[run-once] ${jobName} failed:`, err);
  process.exit(1);
}
