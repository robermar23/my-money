/**
 * The operator's time zone, as the worker's schedule and `/settings/instance`
 * read it (PLAN19 P19-24/P19-25).
 *
 * ── When a job runs is not what date it computes against ───────────────────
 * my-money dates its days in UTC, deliberately and everywhere: snapshots,
 * prices, "today" in every form, every range helper. None of that reads this
 * module and none of it changes when `TZ` does. This module only answers
 * *when* the operator-facing jobs fire and *how the page describes the UTC
 * day* to someone whose day is not UTC. Conflating the two is how somebody
 * "fixes" the UTC math and moves every snapshot boundary the app has ever
 * written. `utc-discipline.test.ts` keeps local-clock getters out of `src/`.
 *
 * The zone comes from the container's `TZ` (compose sets it from `MONEY_TZ`).
 * Pure and dependency-free so both the worker and the app can import it.
 */

/** What `TZ` resolved to. `invalid` keeps the raw value so the page can name it. */
export type ScheduleZone =
  | { readonly kind: "unset" }
  | { readonly kind: "zone"; readonly zone: string }
  | { readonly kind: "invalid"; readonly raw: string };

/** Longest raw value echoed back on the page; a time zone name is far shorter. */
const MAX_RAW = 64;

/**
 * Resolve a `TZ` value to an IANA zone the scheduler can use.
 *
 * Validated through `Intl`, which is what the cron library (via luxon) uses,
 * so a zone that passes here is one the scheduler accepts. A value it would
 * reject — `Mars/Olympus`, a POSIX rule string, `:/etc/localtime` — is reported
 * as `invalid` rather than thrown: the scheduler's own error for it is
 * `CronDate: unhandled timestamp: null`, raised at worker boot, which would
 * stop every job including the backup.
 *
 * @param raw - The `TZ` value, possibly undefined.
 * @returns The resolved zone. Never throws.
 */
export function resolveScheduleZone(raw: string | undefined): ScheduleZone {
  const value = raw?.trim() ?? "";
  if (value === "") return { kind: "unset" };
  try {
    const zone = new Intl.DateTimeFormat("en-US", { timeZone: value }).resolvedOptions().timeZone;
    return { kind: "zone", zone };
  } catch {
    return { kind: "invalid", raw: value.slice(0, MAX_RAW) };
  }
}

/**
 * The zone the operator-clock jobs actually run in: the resolved zone, or UTC
 * when `TZ` is unset or invalid (exactly what they ran in before P19-24).
 *
 * @param state - A resolved zone.
 * @returns An IANA zone name.
 */
export function effectiveZone(state: ScheduleZone): string {
  return state.kind === "zone" ? state.zone : "UTC";
}

/**
 * The zone's offset from UTC at an instant, as `UTC+11:00`, `UTC-04:00` or
 * `UTC`. An instant is required because the answer changes with daylight time.
 *
 * @param zone - A valid IANA zone name.
 * @param at - The instant to evaluate the offset at.
 * @returns The offset label.
 */
export function utcOffsetLabel(zone: string, at: Date): string {
  const part = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "longOffset" })
    .formatToParts(at)
    .find((p) => p.type === "timeZoneName");
  // `longOffset` renders UTC itself as "GMT" or "GMT+00:00", by ICU version.
  const label = (part?.value ?? "GMT").replace("GMT", "UTC");
  return label === "UTC+00:00" ? "UTC" : label;
}

/**
 * Wall-clock time in `zone` at an instant, as `HH:MM` (24-hour).
 *
 * @param zone - A valid IANA zone name.
 * @param at - The instant.
 * @returns The local time of day.
 */
export function localTimeOfDay(zone: string, at: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: zone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(at);
}
