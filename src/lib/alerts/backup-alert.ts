import { createHash } from "node:crypto";
import { db } from "@/db/client.ts";
import { alerts } from "@/db/schema/index.ts";
import { dedupHash } from "@/lib/alerts/rules.ts";
import { and, eq, inArray, isNull } from "drizzle-orm";

/**
 * Backup alert hooks: `backup_failure` (P6-16, ADR-014/015) and
 * `backup_not_configured` (P19-08, ADR-052).
 *
 * The backup job (P6-04) writes a `backup_failure` alert when a dump fails, so a
 * failed backup surfaces in `/alerts` (and the notification email) instead of
 * dying silently in the logs. Deduped per day — repeated BullMQ retries on the
 * same date collapse to one row. A later success clears any open one.
 *
 * `backup_not_configured` covers the case `backup_failure` structurally cannot:
 * with `BACKUP_AGE_RECIPIENT` unset the job never fails, it skips, so without
 * this alert an instance can run for a year with zero backups and zero signal
 * (ADR-052). It is a standing configuration fact, so a period key alone is not
 * enough: the writer also refuses to open a second row while one is still open.
 * The result is one open alert for as long as the condition holds, and — if the
 * operator dismisses it without fixing the cause — one more the next month.
 *
 * Unlike the rule-driven alerts, both types are written here directly (not by
 * `detect-anomalies-daily`), and the detection job deliberately never sweeps
 * them — they clear only on backup success or user dismissal.
 */

const NOT_CONFIGURED = "backup_not_configured" as const;

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

/**
 * Raise `backup_not_configured` unless one is already open (P19-08).
 *
 * Severity `warning`, not `critical`: a day-one instance legitimately has no
 * backup yet, and a critical alert on first boot trains the operator to ignore
 * the channel (ADR-052 §1). The title and detail carry no figure and no secret —
 * only the name of the variable to set and the document that explains it.
 *
 * @param now - The job's clock; its calendar month is the dedup period.
 */
export async function recordBackupNotConfigured(now: Date): Promise<void> {
  const open = await db
    .select({ id: alerts.id })
    .from(alerts)
    .where(and(eq(alerts.type, NOT_CONFIGURED), isNull(alerts.resolvedAt)))
    .limit(1);
  if (open.length > 0) return;

  const month = now.toISOString().slice(0, 7);
  await db
    .insert(alerts)
    .values({
      type: NOT_CONFIGURED,
      severity: "warning",
      dedupHash: dedupHash(NOT_CONFIGURED, "backup", month),
      title: "Nightly backups are not configured",
      detail: { missing: "BACKUP_AGE_RECIPIENT", doc: "docs/BACKUP.md" },
    })
    .onConflictDoNothing({ target: alerts.dedupHash });
}

/**
 * A good backup clears every open backup alert: the failure it supersedes and
 * the "not configured" warning it disproves (P6-16, P19-08).
 *
 * @param now - Stamped as `resolved_at`.
 */
export async function clearBackupAlerts(now: Date): Promise<void> {
  await db
    .update(alerts)
    .set({ resolvedAt: now })
    .where(
      and(inArray(alerts.type, ["backup_failure", NOT_CONFIGURED]), isNull(alerts.resolvedAt)),
    );
}
