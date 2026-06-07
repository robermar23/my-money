import { createHash } from "node:crypto";
import { db } from "@/db/client.ts";
import { alerts } from "@/db/schema/index.ts";
import { and, eq, isNull } from "drizzle-orm";

/**
 * `backup_failure` alert hooks (P6-16, ADR-014/015).
 *
 * The backup job (P6-04) writes a `backup_failure` alert when a dump fails, so a
 * failed backup surfaces in `/alerts` (and the notification email) instead of
 * dying silently in the logs. Deduped per day — repeated BullMQ retries on the
 * same date collapse to one row. A later success clears any open one.
 *
 * Unlike the rule-driven alerts, `backup_failure` is written here directly (not
 * by `detect-anomalies-daily`), and the detection job deliberately never sweeps
 * it — it clears only on backup success or user dismissal.
 */

export async function recordBackupFailure(now: Date, error: string): Promise<void> {
  const date = now.toISOString().slice(0, 10);
  const dedupHash = createHash("sha256").update(`backup_failure|backup|${date}`).digest("hex");
  await db
    .insert(alerts)
    .values({
      type: "backup_failure",
      severity: "critical",
      dedupHash,
      title: "Nightly database backup failed",
      detail: { date, error: error.slice(0, 500) },
    })
    .onConflictDoNothing({ target: alerts.dedupHash });
}

export async function clearBackupFailure(now: Date): Promise<void> {
  await db
    .update(alerts)
    .set({ resolvedAt: now })
    .where(and(eq(alerts.type, "backup_failure"), isNull(alerts.resolvedAt)));
}
