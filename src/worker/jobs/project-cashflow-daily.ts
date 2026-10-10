import { db } from "@/db/client.ts";
import { alerts } from "@/db/schema/index.ts";
import { notifyNewAlerts } from "@/lib/alerts/notify.ts";
import { CASHFLOW_SWEPT_ALERT_TYPES, type DetectedAlert } from "@/lib/alerts/rules.ts";
import { cashFlowAlerts } from "@/lib/cashflow/alerts.ts";
import {
  DEFAULT_PROJECTION_HORIZON_DAYS,
  MATERIALIZATION_LEAD_DAYS,
} from "@/lib/cashflow/constants.ts";
import { loadCashFlow } from "@/lib/cashflow/loader.ts";
import { materializeOccurrences } from "@/lib/cashflow/materialize.ts";
import { listMaterializableObligations, sweepOccurrences } from "@/lib/cashflow/sweep.ts";
import { loadHousehold } from "@/lib/household/queries.ts";
import { materializationDaysAhead } from "@/lib/sinking/coverage.ts";
import type { Job } from "bullmq";
import { and, eq, inArray, isNull, notInArray } from "drizzle-orm";

/**
 * P16-27 — the nightly cash-flow pass: materialize, reconcile, then judge.
 *
 * Three steps, in an order that is a correctness requirement rather than a
 * preference:
 *
 *   1. **Materialize** every active obligation forward through the horizon
 *      (P16-21). Without this the sweep has nothing to sweep and the calendar
 *      runs out mid-projection.
 *   2. **Sweep** the undecided occurrences against what actually posted
 *      (P16-22/P16-27). This must precede the projection, because the residual
 *      rate subtracts *matched* spend (ADR-038 §2) — projecting first would
 *      compute the rate from yesterday's reconciliation and double-count
 *      anything that settled overnight.
 *   3. **Project and alert** (P16-28).
 *
 * ── Chained after `compute-snapshots-daily`, not scheduled ─────────────────
 * Day zero of the projection is the latest `account_snapshots` row per account.
 * A cron that happened to fire before the 02:00 snapshot job would open the walk
 * on yesterday's balance and be wrong by a day in the one direction that
 * matters — the family reads this number to decide whether to spend today. Same
 * reasoning that put `evaluate-advice` (P15-36) and `evaluate-price-targets`
 * (P11-12) behind the jobs whose output they read.
 *
 * ── Idempotent by construction, per CLAUDE.md §Background Jobs ─────────────
 * Every write in this job is guarded by a database constraint rather than by
 * application bookkeeping:
 *
 *   - Materialization is `ON CONFLICT (obligation_id, due_date) DO NOTHING`.
 *     This is also what makes P18-11's **widened lead** a safe change to a
 *     shipped repeatable job: a longer window adds only the tail, and every due
 *     date already written is a no-op insert. The job's schedule, its queue and
 *     its repeat options are untouched — the only change is the `through` date,
 *     computed per cadence.
 *   - The sweep only ever decides rows still marked `scheduled`, inside a single
 *     transaction.
 *   - Alerts are `ON CONFLICT (dedup_hash) DO NOTHING`.
 *
 * A run that dies at any point is safely resumable, and a Redis retry writes
 * nothing new. There is a test that runs the whole job twice and asserts the
 * second run creates no rows.
 *
 * ── Which alerts resolve, and which do not ────────────────────────────────
 * Only {@link CASHFLOW_SWEPT_ALERT_TYPES} — that is, `projected_shortfall`, the
 * one standing condition. `obligation_missed` and `obligation_amount_changed`
 * are one-shot facts about a specific occurrence; the mortgage either posted in
 * its window or it did not, and that does not un-happen. The sweep here is
 * scoped to this job's own types so it can never touch the anomaly detector's.
 *
 * No figure is logged. The counts this returns are counts (CLAUDE.md §Privacy).
 */

export interface ProjectCashFlowDailyResult {
  /** Occurrence rows materialized this run (post-dedup). */
  readonly materialized: number;
  /** Undecided occurrences the sweep considered. */
  readonly swept: number;
  /** Occurrences moved to `matched`. */
  readonly matched: number;
  /** Occurrences moved to `missed`. */
  readonly missed: number;
  /** Alert rows detected this run, before dedup. */
  readonly detected: number;
  /** New `alerts` rows inserted (post-dedup). */
  readonly created: number;
  /** Standing shortfall alerts closed because the projection recovered. */
  readonly resolved: number;
  /** Alerts the content-free email covered (0 when SMTP is unset). */
  readonly notified: number;
}

export interface ProjectCashFlowDailyDeps {
  /** Injected for tests so "today" is deterministic. */
  readonly now?: () => Date;
  readonly notify?: (count: number, date: string) => Promise<{ sent: boolean }>;
}

const MS_PER_DAY = 86_400_000;
const isoDate = (d: Date): string => d.toISOString().slice(0, 10);

/** `iso` shifted by whole UTC days — no local clock, so DST cannot move it. */
function shiftDays(iso: string, days: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + days * MS_PER_DAY).toISOString().slice(0, 10);
}

export async function projectCashFlowDailyProcessor(
  _job: Job | undefined,
  deps: ProjectCashFlowDailyDeps = {},
): Promise<ProjectCashFlowDailyResult> {
  const now = (deps.now ?? (() => new Date()))();
  const today = isoDate(now);

  // ── 1. Materialize forward ───────────────────────────────────────────────
  // A little past the horizon (MATERIALIZATION_LEAD_DAYS) so the calendar never
  // runs out between nightly runs, and so nudging the horizon does not require
  // a re-materialization before the line can be drawn.
  const household = await loadHousehold();
  const horizonDays = household.profile?.projectionHorizonDays ?? DEFAULT_PROJECTION_HORIZON_DAYS;
  const cashFlowDaysAhead = horizonDays + MATERIALIZATION_LEAD_DAYS;

  let materialized = 0;
  for (const obligation of await listMaterializableObligations()) {
    // The lead is PER CADENCE (P18-11, ADR-045 consequence 2). The sinking-fund
    // requirement reads materialized occurrence rows rather than re-expanding
    // schedules, so it can only see as far as this loop has written — and at the
    // cash-flow defaults that is about 90 days against a 365-day horizon, which
    // would silently omit every annual and semiannual cost beyond it. Quarterly,
    // semiannual and annual obligations therefore run ~13 months out; monthly
    // and shorter ones keep the cash-flow lead untouched, because a weekly bill
    // materialized 13 months ahead is 56 rows nobody reads.
    const through = shiftDays(
      today,
      materializationDaysAhead(obligation.cadence, cashFlowDaysAhead),
    );
    // One obligation at a time, each idempotent on its own. A malformed
    // schedule stops the run — see the failure-path note in the header — but
    // everything already written stays written and the re-run resumes from it.
    const result = await materializeOccurrences(obligation, through);
    materialized += result.created;
  }

  // ── 2. Reconcile against reality ─────────────────────────────────────────
  const sweep = await sweepOccurrences({ today, now });

  // ── 3. Project, then judge ───────────────────────────────────────────────
  const snapshot = await loadCashFlow({ today, now });
  const detected: DetectedAlert[] = cashFlowAlerts({
    shortfall: {
      status: snapshot.projection.status,
      safeToSpend: snapshot.projection.safeToSpend,
      lowWaterMark: snapshot.projection.lowWaterMark,
      horizonDays: snapshot.projection.horizonDays,
      coverage: snapshot.projection.coverage,
      // ADR-048 §4: the grade, not a silence. A shortfall the emergency fund
      // covers drops to `info` and is still written.
      close: snapshot.shortfallClose,
    },
    missed: sweep.missAlerts,
    amountChanges: sweep.amountChanges,
  });

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

  // Resolve a standing shortfall the projection has recovered from. Scoped to
  // this job's own swept types so it can never close an anomaly alert.
  const detectedHashes = detected.map((d) => d.dedupHash);
  let resolved = 0;
  for (const type of CASHFLOW_SWEPT_ALERT_TYPES) {
    const conditions = [eq(alerts.type, type), isNull(alerts.resolvedAt)];
    if (detectedHashes.length > 0) conditions.push(notInArray(alerts.dedupHash, detectedHashes));
    const rows = await db
      .update(alerts)
      .set({ resolvedAt: now })
      .where(and(...conditions))
      .returning({ id: alerts.id });
    resolved += rows.length;
  }

  // Ring the content-free doorbell for everything open + un-notified, exactly
  // as the other alert-writing jobs do — one email per run, not one per source,
  // and it carries a count and a date and nothing else (P6-14, ADR-015).
  let notified = 0;
  const unnotified = await db
    .select({ id: alerts.id })
    .from(alerts)
    .where(and(isNull(alerts.notifiedAt), isNull(alerts.resolvedAt)));
  if (unnotified.length > 0) {
    const notifyFn = deps.notify ?? ((c: number, d: string) => notifyNewAlerts(c, d));
    const res = await notifyFn(unnotified.length, today);
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

  return {
    materialized,
    swept: sweep.considered,
    matched: sweep.matched,
    missed: sweep.missed,
    detected: detected.length,
    created,
    resolved,
    notified,
  };
}
