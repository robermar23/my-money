/**
 * Pure verdicts for `/settings/instance` (PLAN19 P19-10, ADR-052 §5,
 * ADR-054 §5).
 *
 * No I/O and no clock reading: the loaders in `./queries.ts` fetch, these
 * functions judge, so every verdict the page shows is unit-tested. Each
 * returns a discriminated union rather than a flag, because each verdict has
 * a different sentence and a different remedy.
 */

/** One entry of `drizzle/meta/_journal.json`. */
export interface JournalEntry {
  readonly tag: string;
  /** The migration's folder timestamp — what drizzle stores as `created_at`. */
  readonly when: number;
}

export type MigrationStatus =
  | { readonly kind: "current"; readonly latest: string }
  | {
      readonly kind: "behind";
      /** The newest applied migration, or null on a never-migrated database. */
      readonly applied: string | null;
      readonly latest: string;
      readonly pending: readonly string[];
    }
  /** The database holds a migration this image does not know (an older image). */
  | { readonly kind: "ahead"; readonly latest: string }
  /** The image carries no migrations at all (should not happen in a real build). */
  | { readonly kind: "empty" };

/**
 * Compare the migrations in this image against the newest one applied.
 *
 * Uses drizzle's own rule: a migration is pending when its folder timestamp is
 * later than the newest `created_at` in `drizzle.__drizzle_migrations`. Counting
 * rows instead would disagree with `drizzle-kit migrate` on any database whose
 * history was ever repaired by hand.
 *
 * @param journal - The image's migrations, in journal order.
 * @param appliedMaxWhen - The newest applied `created_at`, or null if none.
 * @returns The verdict, naming migrations by their tag.
 */
export function migrationStatus(
  journal: readonly JournalEntry[],
  appliedMaxWhen: number | null,
): MigrationStatus {
  const last = journal.at(-1);
  if (!last) return { kind: "empty" };

  const pending = journal.filter((m) => appliedMaxWhen === null || m.when > appliedMaxWhen);
  if (pending.length > 0) {
    const applied =
      appliedMaxWhen === null
        ? null
        : (journal.find((m) => m.when === appliedMaxWhen)?.tag ?? null);
    return { kind: "behind", applied, latest: last.tag, pending: pending.map((m) => m.tag) };
  }
  if (appliedMaxWhen !== null && appliedMaxWhen > last.when) {
    return { kind: "ahead", latest: last.tag };
  }
  return { kind: "current", latest: last.tag };
}

/** The heartbeat runs every 60 s; five missed beats is not a hiccup. */
export const WORKER_STALE_AFTER_MS = 5 * 60_000;

export type WorkerLiveness =
  | { readonly kind: "alive"; readonly lastSeen: Date }
  | { readonly kind: "stale"; readonly lastSeen: Date }
  /** No completed heartbeat in Redis: the worker has not run since Redis was emptied. */
  | { readonly kind: "never" };

/**
 * Judge worker liveness from the newest completed heartbeat.
 *
 * @param lastSeenMs - That job's `finishedOn` (ms epoch), or null if none.
 * @param now - The current time.
 * @returns alive, stale, or never.
 */
export function workerLiveness(lastSeenMs: number | null, now: Date): WorkerLiveness {
  if (lastSeenMs === null) return { kind: "never" };
  const lastSeen = new Date(lastSeenMs);
  return now.getTime() - lastSeenMs > WORKER_STALE_AFTER_MS
    ? { kind: "stale", lastSeen }
    : { kind: "alive", lastSeen };
}

/** CLAUDE.md §Backup Discipline: the restore runbook is tested at least quarterly. */
export const DRILL_DUE_AFTER_DAYS = 92;

export type DrillStatus =
  | { readonly kind: "never" }
  | {
      readonly kind: "recorded";
      readonly at: Date;
      readonly ageDays: number;
      readonly due: boolean;
    };

/**
 * Age the last self-reported restore drill against the quarterly expectation.
 *
 * @param at - When the operator recorded a drill, or null.
 * @param now - The current time.
 * @returns never, or the drill's age in whole days and whether one is due.
 */
export function drillStatus(at: Date | null, now: Date): DrillStatus {
  if (at === null) return { kind: "never" };
  const ageDays = Math.max(0, Math.floor((now.getTime() - at.getTime()) / 86_400_000));
  return { kind: "recorded", at, ageDays, due: ageDays > DRILL_DUE_AFTER_DAYS };
}

export interface LimitCoverage {
  readonly years: readonly number[];
  /** True when the current calendar year has statutory limits configured. */
  readonly currentYearConfigured: boolean;
  /** The first year from now on that is missing, so the page can name it. */
  readonly firstMissingYear: number | null;
}

/**
 * Report statutory-limit coverage (ADR-053 §2).
 *
 * `limitsForYear()` returns null for an unconfigured year and every caller
 * suppresses its output with a reason (ADR-034 §5). This only makes the
 * maintenance burden visible: which years exist, and the first one that will
 * be missing.
 *
 * @param years - `configuredLimitYears()`, ascending.
 * @param currentYear - The current calendar year.
 * @returns The coverage verdict.
 */
export function limitCoverage(years: readonly number[], currentYear: number): LimitCoverage {
  const have = new Set(years);
  let year = currentYear;
  while (have.has(year)) year += 1;
  return {
    years,
    currentYearConfigured: have.has(currentYear),
    // Only "missing" when it is this year or next — further out is not news.
    firstMissingYear: year <= currentYear + 1 ? year : null,
  };
}
