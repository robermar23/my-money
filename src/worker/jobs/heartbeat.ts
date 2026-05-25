import type { Job } from "bullmq";

/**
 * Phase 0 placeholder job. Logs a heartbeat so we can confirm the worker is
 * running and Redis is reachable. Phase 1 replaces this with the nightly
 * snapshot job.
 */
export async function heartbeatProcessor(job: Job): Promise<void> {
  // biome-ignore lint/suspicious/noConsoleLog: structured logger arrives in Phase 1+.
  console.log(`[heartbeat] tick at ${new Date().toISOString()} (job id: ${job.id})`);
}
