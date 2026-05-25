/**
 * One-off worker runner: invokes a single job processor directly (no Redis
 * scheduling), useful for manual verification and CI smoke tests.
 *
 * Usage:
 *   node --env-file=.env.local --import tsx src/worker/run-once.ts <job-name>
 *
 * Supported job names:
 *   - compute-snapshots-daily
 *   - heartbeat
 */
import { computeSnapshotsDailyProcessor } from "./jobs/compute-snapshots-daily.ts";
import { heartbeatProcessor } from "./jobs/heartbeat.ts";

const jobName = process.argv[2];

const PROCESSORS: Record<string, (job: never) => Promise<void>> = {
  "compute-snapshots-daily": computeSnapshotsDailyProcessor as never,
  heartbeat: heartbeatProcessor as never,
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
