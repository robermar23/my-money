import { db } from "@/db/client.ts";
import { alerts } from "@/db/schema/index.ts";
import { dedupHash } from "@/lib/alerts/rules.ts";
import { and, eq, isNull, sql } from "drizzle-orm";

/**
 * `job_failure` alert hooks — a background job that exhausted its retries.
 *
 * BullMQ retries every job three times with backoff (`src/lib/queue/queues.ts`);
 * before this alert, a job that failed all three only reached the worker log.
 * Several jobs have no other failure signal — the anomaly detector itself, the
 * guidance and cash-flow evaluators, the Beancount export — so a dead job could
 * leave the dashboard quietly stale. The worker now writes one of these when the
 * LAST attempt fails, which puts it on `/alerts` and in the next notification
 * email (whose body is content-free regardless — ADR-015).
 *
 * Deduped per queue per day: a cron job that fails every night produces one row
 * a night at most, and a burst of on-demand failures (imports, syncs) on one day
 * collapses to one. The next successful run of the same queue resolves it, the
 * same "cleared only by success" posture as `backup_failure`, so it is NOT in
 * `RULE_ALERT_TYPES` and the anomaly resolve-sweep never touches it.
 */

/** The minimal job shape the final-attempt check reads. */
export interface FailedJobLike {
  readonly attemptsMade: number;
  readonly finishedOn?: number;
  readonly opts: { readonly attempts?: number };
}

/**
 * Whether a `failed` event is the last one BullMQ will emit for this job.
 *
 * The worker fires `failed` on every attempt, including those that will be
 * retried; only the final one should raise an alert. BullMQ stamps
 * `finishedOn` only when it moves the job to the failed set for good, which
 * also covers an `UnrecoverableError` thrown before the attempts run out; the
 * attempt count is the fallback.
 *
 * @param job - The job from the worker's `failed` event; undefined when BullMQ
 *   lost the job reference, which is treated as final so it is not swallowed.
 * @returns True when no retry is pending.
 */
export function isFinalAttempt(job: FailedJobLike | undefined): boolean {
  if (!job) return true;
  if (job.finishedOn) return true;
  return job.attemptsMade >= (job.opts.attempts ?? 1);
}

/**
 * Raise a `job_failure` alert for `queue` (one per queue per UTC day).
 *
 * The title names only the queue; the error text goes in `detail`, which is
 * shown in the authenticated UI and never emailed (ADR-015).
 *
 * @param queue - The BullMQ queue name, e.g. `detect-anomalies-daily`.
 * @param jobId - The failed job's id, when known.
 * @param error - The final attempt's error message.
 * @param now - The clock; its UTC date is the dedup period.
 */
export async function recordJobFailure(
  queue: string,
  jobId: string | undefined,
  error: string,
  now: Date,
): Promise<void> {
  const date = now.toISOString().slice(0, 10);
  await db
    .insert(alerts)
    .values({
      type: "job_failure",
      severity: "warning",
      dedupHash: dedupHash("job_failure", queue, date),
      title: `Background job failed: ${queue}`,
      detail: { queue, jobId: jobId ?? null, date, error: error.slice(0, 500) },
    })
    .onConflictDoNothing({ target: alerts.dedupHash });
}

/**
 * Resolve any open `job_failure` alert for `queue` — called on a successful run.
 *
 * @param queue - The queue whose job just completed.
 * @param now - Stamped as `resolved_at`.
 */
export async function clearJobFailure(queue: string, now: Date): Promise<void> {
  await db
    .update(alerts)
    .set({ resolvedAt: now })
    .where(
      and(
        eq(alerts.type, "job_failure"),
        isNull(alerts.resolvedAt),
        sql`${alerts.detail}->>'queue' = ${queue}`,
      ),
    );
}
