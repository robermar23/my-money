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
 */
import { backupDatabaseDailyProcessor } from "./jobs/backup-database-daily.ts";
import { computeSnapshotsDailyProcessor } from "./jobs/compute-snapshots-daily.ts";
import { exportBeancountDailyProcessor } from "./jobs/export-beancount-daily.ts";
import { fetchPricesDailyProcessor } from "./jobs/fetch-prices-daily.ts";
import { heartbeatProcessor } from "./jobs/heartbeat.ts";
import { processImportProcessor } from "./jobs/process-import.ts";
import { recategorizeAllProcessor } from "./jobs/recategorize-all.ts";

const jobName = process.argv[2];

const PROCESSORS: Record<string, (job: never) => Promise<unknown>> = {
  "compute-snapshots-daily": computeSnapshotsDailyProcessor as never,
  "fetch-prices-daily": (async (job: never) => fetchPricesDailyProcessor(job)) as never,
  heartbeat: heartbeatProcessor as never,
  "process-import": processImportProcessor as never,
  "recategorize-all": recategorizeAllProcessor as never,
  "backup-database-daily": backupDatabaseDailyProcessor as never,
  "export-beancount-daily": exportBeancountDailyProcessor as never,
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
