import { Worker } from "bullmq";
import { redisConnection } from "../../src/lib/queue/connection.ts";
import { QUEUE_NAMES, heartbeatQueue } from "../../src/lib/queue/queues.ts";
import { heartbeatProcessor } from "../../src/worker/jobs/heartbeat.ts";

/**
 * Run the worker's real heartbeat through BullMQ exactly once, then exit
 * (PLAN19 P19-38).
 *
 * `/settings/instance` learns the worker's configuration from the newest
 * completed heartbeat job in Redis, and a Playwright run has no worker. This is
 * the smallest real one: the shipped processor, on the shipped queue, over
 * whatever environment the caller passes — so "backups not configured" on the
 * page is the worker's own report, not a fixture.
 *
 * Run with the worker's loaders, as `pnpm worker` is:
 * `node --import tsx --import ./scripts/loaders/register.mjs e2e/helpers/heartbeat-once.ts`
 */

const worker = new Worker(QUEUE_NAMES.HEARTBEAT, heartbeatProcessor, {
  connection: redisConnection,
});

// Listen before enqueueing, so a job that finishes before `add` resolves is
// still seen.
const settled = new Map<string, Error | null>();
const waiters = new Map<string, (err: Error | null) => void>();
function settle(id: string | undefined, err: Error | null): void {
  if (id === undefined) return;
  settled.set(id, err);
  waiters.get(id)?.(err);
}
worker.on("completed", (job) => settle(job.id, null));
worker.on("failed", (job, err) => settle(job?.id, err));

try {
  const job = await heartbeatQueue.add("heartbeat-e2e", {});
  const id = job.id ?? "";
  const err = await new Promise<Error | null>((resolve, reject) => {
    if (settled.has(id)) return resolve(settled.get(id) ?? null);
    const timer = setTimeout(() => reject(new Error("heartbeat did not complete")), 30_000);
    waiters.set(id, (e) => {
      clearTimeout(timer);
      resolve(e);
    });
  });
  if (err) throw err;
} finally {
  await worker.close();
  await heartbeatQueue.close();
  redisConnection.disconnect();
}
