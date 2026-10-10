import { type InstanceConfigState, instanceConfigState } from "@/lib/instance/config-state.ts";
import type { Job } from "bullmq";

/**
 * The worker's once-a-minute heartbeat.
 *
 * Phase 0 shipped this as a placeholder that only logged, so nothing outside
 * the worker's own log could tell whether the worker was alive. Phase 19
 * (P19-10, ADR-052 §5) gives it one job: its **return value** is the worker's
 * report about itself, which BullMQ stores on the completed job in Redis.
 * `/settings/instance` reads the newest completed heartbeat and gets two facts
 * with no new table, no new column and no new write path:
 *
 *   - liveness — the job's `finishedOn` is when the worker last proved it was
 *     running and reaching Redis;
 *   - the worker's configuration — the backup, Beancount and email variables
 *     are set on the worker container only, so the app process cannot see them
 *     itself (see `src/lib/instance/config-state.ts`).
 *
 * The report is presence-and-state only, never a secret, so storing it in Redis
 * beside every other job's return value adds nothing an attacker on that box
 * did not already have.
 */
export interface HeartbeatReport {
  readonly config: InstanceConfigState;
}

/**
 * Report this worker's configuration.
 *
 * @param job - The heartbeat job; its completion time is the liveness signal.
 * @returns The worker's {@link HeartbeatReport}, stored by BullMQ as the
 *   job's return value.
 */
export async function heartbeatProcessor(job: Job): Promise<HeartbeatReport> {
  // biome-ignore lint/suspicious/noConsoleLog: the tick operators already watch for in the logs.
  console.log(`[heartbeat] tick at ${new Date().toISOString()} (job id: ${job.id})`);
  return { config: instanceConfigState() };
}
