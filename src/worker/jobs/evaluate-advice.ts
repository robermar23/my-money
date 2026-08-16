import { db } from "@/db/client.ts";
import { alerts } from "@/db/schema/index.ts";
import { adviceAlerts } from "@/lib/advice/alerts.ts";
import { loadPlan } from "@/lib/advice/plan.ts";
import { notifyNewAlerts } from "@/lib/alerts/notify.ts";
import type { DetectedAlert } from "@/lib/alerts/rules.ts";
import type { Job } from "bullmq";
import { and, inArray, isNull } from "drizzle-orm";

/**
 * Phase 15 (P15-36) — daily household-guidance evaluation.
 *
 * Thin by design. It loads the plan through the *same* `loadPlan()` the `/plan`
 * page and the dashboard card use, maps the material recommendations to alerts
 * with the pure {@link adviceAlerts}, persists them idempotently, and rings the
 * content-free notification doorbell (P6-14). Every judgement about what counts
 * as material lives in the pure mapper, where it is unit-testable without Redis,
 * Postgres or a clock.
 *
 * ── Chained after `compute-snapshots-daily`, not scheduled ─────────────────
 * The waterfall reads yesterday's balances through `account_snapshots`, so
 * running on a cron that happened to fire before the snapshot job would evaluate
 * guidance against stale balances and fire an alert that is already wrong by the
 * time the user reads it. Chaining off the 02:00 snapshot job removes the race
 * entirely — the same reasoning that put `evaluate-price-targets` behind the
 * price fetch (P11-12).
 *
 * ── Idempotent, and quiet on a standing condition ──────────────────────────
 * Persist is `ON CONFLICT DO NOTHING` on `dedup_hash`, and the hash covers
 * `(rule_id, subject_key, severity|status)`. A household that is under-reserved
 * again tomorrow produces the same hash and inserts nothing. A re-run of this
 * job on the same day is a no-op by the same mechanism.
 *
 * ── Nothing here resolves ──────────────────────────────────────────────────
 * `advice` is not in `RULE_ALERT_TYPES`, and this job deliberately does not add
 * its own sweep. See `src/lib/advice/alerts.ts` on why silence from a rule is
 * not evidence the situation improved.
 *
 * No figure is logged. The `notified` count is a count, not a statement about
 * anyone's money (CLAUDE.md §Privacy).
 */

export interface EvaluateAdviceResult {
  /** Recommendations that qualified as material this run. */
  readonly detected: number;
  /** New `alerts` rows inserted (post-dedup). */
  readonly created: number;
  /** Alerts the content-free email covered (0 when SMTP is unset). */
  readonly notified: number;
}

export interface EvaluateAdviceDeps {
  /** Injected for tests; defaults to the real snapshot → engine composition. */
  readonly load?: (now: Date) => Promise<readonly DetectedAlert[]>;
  readonly now?: () => Date;
  readonly notify?: (count: number, date: string) => Promise<{ sent: boolean }>;
}

const isoDate = (d: Date): string => d.toISOString().slice(0, 10);

/** Default loader: run the engine for today and map it to alert rows. */
async function loadAdviceAlerts(now: Date): Promise<readonly DetectedAlert[]> {
  const plan = await loadPlan({ today: isoDate(now) }, now);
  return adviceAlerts(plan.advice);
}

export async function evaluateAdviceProcessor(
  _job: Job,
  deps: EvaluateAdviceDeps = {},
): Promise<EvaluateAdviceResult> {
  const now = (deps.now ?? (() => new Date()))();
  const detected = await (deps.load ?? loadAdviceAlerts)(now);

  let created = 0;
  if (detected.length > 0) {
    const inserted = await db
      .insert(alerts)
      .values(
        detected.map((d) => ({
          type: d.type,
          severity: d.severity,
          dedupHash: d.dedupHash,
          title: d.title,
          detail: d.detail,
        })),
      )
      .onConflictDoNothing({ target: alerts.dedupHash })
      .returning({ id: alerts.id });
    created = inserted.length;
  }

  // Ring the doorbell for everything open + un-notified, exactly as the other
  // alert-writing jobs do — one email per night, not one per source.
  let notified = 0;
  const unnotified = await db
    .select({ id: alerts.id })
    .from(alerts)
    .where(and(isNull(alerts.notifiedAt), isNull(alerts.resolvedAt)));
  if (unnotified.length > 0) {
    const notifyFn = deps.notify ?? ((c: number, d: string) => notifyNewAlerts(c, d));
    const res = await notifyFn(unnotified.length, isoDate(now));
    if (res.sent) {
      await db
        .update(alerts)
        .set({ notifiedAt: now })
        .where(
          inArray(
            alerts.id,
            unnotified.map((r) => r.id),
          ),
        );
      notified = unnotified.length;
    }
  }

  return { detected: detected.length, created, notified };
}
