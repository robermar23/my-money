import type { RepeatOptions } from "bullmq";

/**
 * Every cron-scheduled job's pattern and the clock it runs on (PLAN19 P19-24).
 *
 * ── Two clocks, on purpose ─────────────────────────────────────────────────
 * Before P19-24 no pattern named a zone, so every job fired in the process's
 * local time. That was UTC only because the container set no `TZ`; an operator
 * who added one (Unraid templates set `TZ` on every container) would have
 * silently moved the whole chain. Each job now names its clock:
 *
 *   - `utc` — the data chain. These jobs date what they write by the UTC date
 *     at the moment they run, and the price fetch stores Yahoo's *latest*
 *     price under that date. 01:30 UTC is after the US close and after the UTC
 *     day turns, so the row dated D holds D-1's close, which is what every
 *     snapshot, chart and rung has been computed against. Moved to an
 *     operator's 01:30 in Sydney (14:30/15:30 UTC) the fetch would land
 *     mid-session and store an intraday price as that day's close, for good.
 *     Pinning these to UTC is what keeps Hard boundary #3 (no figure moves)
 *     true for every zone, not just the author's.
 *   - `operator` — jobs that write no figure: the encrypted backup and the
 *     Beancount mirror. They follow `TZ` so "nightly" means the operator's
 *     night. No zone's daylight-saving change skips or repeats 04:00 or
 *     04:30 local: checked on 2026-10-10 across all 418 zones Node's ICU
 *     ships, for 2026 and 2027. That matters because cron-parser 4.9 moves a
 *     skipped time onto the next hour, where it can collide with a job that
 *     already runs there (seen at 02:00 in the America/New_York change).
 *
 * ── Re-registration, not duplication ───────────────────────────────────────
 * Each scheduler id is stable and the worker removes then upserts it at boot,
 * so a changed `TZ` replaces the schedule in place. Verified against Redis on
 * 2026-10-10: after no-tz, UTC, Sydney and New York in turn there was one
 * scheduler and one pending job, at the new zone's next 04:00.
 *
 * Ordering consequence: `detect-anomalies-daily` (05:00 UTC) used to run an
 * hour after the backup. With `TZ` set they are no longer ordered, so the
 * email for a failed backup can wait until the next 05:00 UTC run. The
 * `backup_failure` alert row itself is written by the backup job immediately.
 */

export type ScheduleClock = "utc" | "operator";

export interface ScheduleEntry {
  readonly pattern: string;
  readonly clock: ScheduleClock;
}

export const SCHEDULES = {
  "fetch-prices-daily-cron": { pattern: "30 1 * * *", clock: "utc" },
  "materialize-contributions-cron": { pattern: "45 1 * * *", clock: "utc" },
  "compute-snapshots-daily-cron": { pattern: "0 2 * * *", clock: "utc" },
  "enqueue-plaid-syncs-daily-cron": { pattern: "0 3 * * *", clock: "utc" },
  "backup-database-daily-cron": { pattern: "0 4 * * *", clock: "operator" },
  "export-beancount-daily-cron": { pattern: "30 4 * * *", clock: "operator" },
  "detect-anomalies-daily-cron": { pattern: "0 5 * * *", clock: "utc" },
  "refresh-fundamentals-weekly-cron": { pattern: "0 6 * * 0", clock: "utc" },
  "detect-obligations-weekly-cron": { pattern: "30 6 * * 0", clock: "utc" },
} as const satisfies Record<string, ScheduleEntry>;

export type SchedulerId = keyof typeof SCHEDULES;

/**
 * The repeat options for one scheduler: its pattern, and the zone its clock
 * resolves to.
 *
 * @param id - The scheduler id.
 * @param operatorZone - The operator's resolved zone (`effectiveZone`).
 * @returns BullMQ repeat options with an explicit `tz`.
 */
export function repeatFor(id: SchedulerId, operatorZone: string): RepeatOptions {
  const { pattern, clock } = SCHEDULES[id];
  return { pattern, tz: clock === "utc" ? "UTC" : operatorZone };
}
