import "server-only";

import { db } from "@/db/client.ts";
import { householdProfile } from "@/db/schema/index.ts";
import { configuredLimitYears } from "@/lib/advice/constants.ts";
import { backupDatabaseDailyQueue, heartbeatQueue } from "@/lib/queue/queues.ts";
import { sql } from "drizzle-orm";
import { z } from "zod";
import journal from "../../../drizzle/meta/_journal.json";
import pkg from "../../../package.json";
import { type InstanceConfigState, instanceConfigState } from "./config-state.ts";
import {
  type DrillStatus,
  type LimitCoverage,
  type MigrationStatus,
  type WorkerLiveness,
  drillStatus,
  limitCoverage,
  migrationStatus,
  workerLiveness,
} from "./status.ts";

/**
 * Loaders for `/settings/instance` (PLAN19 P19-10, ADR-052 §5).
 *
 * ── Never throws (ADR-052 §7) ──────────────────────────────────────────────
 * Each loader catches its own failure and returns `{ kind: "unavailable" }`,
 * with a timeout so a wedged Redis cannot hang the render. The page that a
 * second operator opens *because something is wrong* must still render when
 * that something is the database or Redis.
 *
 * ── Where each fact comes from (recorded, per P19-10) ──────────────────────
 *   - **Worker liveness and the worker's configuration**: the newest completed
 *     `heartbeat` job in Redis — its `finishedOn` and its return value (see
 *     `src/worker/jobs/heartbeat.ts`). Chosen over a new table or column because
 *     BullMQ already persists both, and a liveness row the worker rewrites every
 *     minute would be the busiest table in a database whose job is history.
 *   - **Last successful backup**: the newest completed `backup-database-daily`
 *     job whose return value has an `outPath`. The app container does not mount
 *     the backups volume, so it cannot list the files. BullMQ keeps the last
 *     1,000 completed jobs per queue, which for a nightly job is years.
 *   - **Migrations**: `drizzle.__drizzle_migrations` against the journal bundled
 *     into this build — which is, exactly, "the migrations present in this
 *     image".
 *   - **Version**: `package.json`, bundled at build time. **Image**: the
 *     `MONEY_IMAGE_REPO` / `MONEY_IMAGE_TAG` the compose file passes in — the
 *     tag the operator asked for, which is what they need to quote.
 *
 * Every fact here is configuration or time. None is a figure (ADR-052 §6).
 */

const PROBE_TIMEOUT_MS = 2_000;

export type Loaded<T> = T | { readonly kind: "unavailable" };

const UNAVAILABLE = { kind: "unavailable" } as const;

/** Reject if `promise` doesn't settle within `ms` — same guard as `/api/health`. */
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("instance probe timed out")), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Run a loader; on any failure, log the reason server-side and degrade. */
async function guarded<T>(label: string, load: () => Promise<T>): Promise<Loaded<T>> {
  try {
    return await withTimeout(load(), PROBE_TIMEOUT_MS);
  } catch (err) {
    console.error(`[settings/instance] ${label} unavailable:`, err);
    return UNAVAILABLE;
  }
}

/** The worker's report, validated: it crossed a process boundary through Redis. */
const workerConfigSchema = z.object({
  backups: z.object({ enabled: z.boolean(), dir: z.string(), retainDays: z.number() }),
  beancount: z.object({ enabled: z.boolean() }),
  email: z.object({ smtpSet: z.boolean(), recipientSet: z.boolean() }),
  plaid: z.object({
    env: z.enum(["sandbox", "production", "unset", "other"]),
    clientIdSet: z.boolean(),
    secretSet: z.boolean(),
    webhookUrlSet: z.boolean(),
  }),
  sessionCookieSecure: z.boolean(),
  autoMigrate: z.boolean(),
});

const heartbeatReportSchema = z.object({ config: workerConfigSchema });

export interface WorkerState {
  readonly liveness: WorkerLiveness;
  /** Null when no heartbeat has completed, or one predates this release's report. */
  readonly config: InstanceConfigState | null;
}

async function loadWorker(now: Date): Promise<WorkerState> {
  const [job] = await heartbeatQueue.getJobs(["completed"], 0, 0, false);
  const report = heartbeatReportSchema.safeParse(job?.returnvalue);
  return {
    liveness: workerLiveness(job?.finishedOn ?? null, now),
    config: report.success ? report.data.config : null,
  };
}

export interface BackupState {
  /** When the newest successful backup finished, or null if none is on record. */
  readonly lastSuccessAt: Date | null;
}

async function loadBackup(): Promise<BackupState> {
  const jobs = await backupDatabaseDailyQueue.getJobs(["completed"], 0, 99, false);
  for (const job of jobs) {
    const value: unknown = job.returnvalue;
    if (value && typeof value === "object" && "outPath" in value && job.finishedOn) {
      return { lastSuccessAt: new Date(job.finishedOn) };
    }
  }
  return { lastSuccessAt: null };
}

async function loadMigrations(): Promise<MigrationStatus> {
  const rows = await db.execute<{ max: string | null }>(
    sql`SELECT max(created_at)::text AS max FROM drizzle.__drizzle_migrations`,
  );
  const raw = rows[0]?.max ?? null;
  return migrationStatus(journal.entries, raw === null ? null : Number(raw));
}

async function loadDrill(now: Date): Promise<DrillStatus> {
  const [row] = await db
    .select({ at: householdProfile.restoreDrillAt })
    .from(householdProfile)
    .limit(1);
  return drillStatus(row?.at ?? null, now);
}

export interface InstanceState {
  /** This (app) process's own configuration. */
  readonly app: InstanceConfigState;
  readonly worker: Loaded<WorkerState>;
  readonly backup: Loaded<BackupState>;
  readonly migrations: Loaded<MigrationStatus>;
  readonly drill: Loaded<DrillStatus>;
  readonly limits: LimitCoverage;
  readonly version: string;
  /** `repo:tag` as configured, or null when the app runs outside compose. */
  readonly image: string | null;
}

/**
 * Load everything `/settings/instance` shows. Never throws.
 *
 * @param now - The current time (injectable for tests).
 * @returns The instance's configuration-and-time state; no figures.
 */
export async function loadInstanceState(now: Date = new Date()): Promise<InstanceState> {
  const [worker, backup, migrations, drill] = await Promise.all([
    guarded("worker heartbeat", () => loadWorker(now)),
    guarded("backup history", loadBackup),
    guarded("migrations", loadMigrations),
    guarded("restore drill", () => loadDrill(now)),
  ]);
  const repo = process.env.MONEY_IMAGE_REPO?.trim();
  const tag = process.env.MONEY_IMAGE_TAG?.trim();
  return {
    app: instanceConfigState(),
    worker,
    backup,
    migrations,
    drill,
    limits: limitCoverage(configuredLimitYears(), now.getUTCFullYear()),
    version: pkg.version,
    image: repo && tag ? `${repo}:${tag}` : null,
  };
}
