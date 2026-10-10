// @vitest-environment node
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { db } from "@/db/client.ts";
import { alerts } from "@/db/schema/index.ts";
import { RULE_ALERT_TYPES } from "@/lib/alerts/rules.ts";
import { backupDatabaseDailyProcessor } from "@/worker/jobs/backup-database-daily.ts";
import { detectAnomaliesDailyProcessor } from "@/worker/jobs/detect-anomalies-daily.ts";
import type { Job } from "bullmq";
import { eq, isNull, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { recordBackupNotConfigured } from "./backup-alert.ts";

/**
 * P19-08 (ADR-052): `backup_not_configured` against the real `alerts` table,
 * driven through the backup job with its DB-backed default hooks. Only
 * `pg_dump`/`age` and the filesystem are faked.
 */

const fakeJob = { id: "test" } as unknown as Job;
const OCT = new Date("2026-10-10T04:00:00.000Z");
const OCT_LATER = new Date("2026-10-11T04:00:00.000Z");
const NOV = new Date("2026-11-10T04:00:00.000Z");

interface FakeChild extends EventEmitter {
  stdout: PassThrough;
  stderr: PassThrough;
  stdin: PassThrough;
}

/** A spawn stand-in whose children exit with `code`. */
function fakeSpawn(code: number) {
  return ((_cmd: string) => {
    const child = new EventEmitter() as FakeChild;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    process.nextTick(() => {
      child.stdout.end();
      child.stderr.end();
      child.emit("close", code);
    });
    return child;
    // biome-ignore lint/suspicious/noExplicitAny: minimal spawn stand-in for tests
  }) as any;
}

const fs = { readdir: async () => [], unlink: async () => {} };
const unconfigured = { DATABASE_URL: "postgres://x" };
const configured = { DATABASE_URL: "postgres://x", BACKUP_AGE_RECIPIENT: "age1abc" };

function runBackup(env: Record<string, string>, now: Date, exitCode = 0) {
  return backupDatabaseDailyProcessor(fakeJob, {
    spawn: fakeSpawn(exitCode),
    fs,
    env,
    now: () => now,
  });
}

async function openOfType(type: string) {
  return db
    .select()
    .from(alerts)
    .where(sql`${alerts.type} = ${type} AND ${alerts.resolvedAt} IS NULL`);
}

async function reset(): Promise<void> {
  await db.execute(sql`TRUNCATE alerts`);
}

describe("backup_not_configured (P19-08)", () => {
  beforeEach(reset);
  afterAll(reset);

  it("the disabled path raises exactly one warning, with no figure or secret", async () => {
    await runBackup(unconfigured, OCT);

    const rows = await db.select().from(alerts);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.type).toBe("backup_not_configured");
    expect(rows[0]?.severity).toBe("warning");
    expect(rows[0]?.detail).toEqual({ missing: "BACKUP_AGE_RECIPIENT", doc: "docs/BACKUP.md" });
  });

  it("a second run in the same period raises none", async () => {
    await runBackup(unconfigured, OCT);
    await runBackup(unconfigured, OCT_LATER);
    expect(await db.select().from(alerts)).toHaveLength(1);
  });

  it("a standing condition stays one open alert across a month boundary", async () => {
    await runBackup(unconfigured, OCT);
    await runBackup(unconfigured, NOV);
    expect(await openOfType("backup_not_configured")).toHaveLength(1);
  });

  it("returns the next month after a dismissal that did not fix the cause", async () => {
    await recordBackupNotConfigured(OCT);
    await db.update(alerts).set({ resolvedAt: OCT_LATER }); // the user dismisses it
    await runBackup(unconfigured, OCT_LATER); // same month → stays dismissed
    expect(await openOfType("backup_not_configured")).toHaveLength(0);
    await runBackup(unconfigured, NOV);
    expect(await openOfType("backup_not_configured")).toHaveLength(1);
  });

  it("a successful backup resolves it", async () => {
    await runBackup(unconfigured, OCT);
    await runBackup(configured, OCT_LATER);
    expect(await openOfType("backup_not_configured")).toHaveLength(0);
    const [row] = await db.select().from(alerts);
    expect(row?.resolvedAt).toEqual(OCT_LATER);
  });

  it("a failed backup raises backup_failure and not this type", async () => {
    await expect(runBackup(configured, OCT, 1)).rejects.toThrow(/failed/);
    const rows = await db.select().from(alerts);
    expect(rows.map((r) => r.type)).toEqual(["backup_failure"]);
  });

  it("the two conditions do not mask each other", async () => {
    // Not configured, then configured-but-failing: both stay visible until a
    // backup actually succeeds, which clears both.
    await runBackup(unconfigured, OCT);
    await expect(runBackup(configured, OCT_LATER, 1)).rejects.toThrow(/failed/);
    const open = await db.select().from(alerts).where(isNull(alerts.resolvedAt));
    expect(open.map((r) => r.type).sort()).toEqual(["backup_failure", "backup_not_configured"]);

    await runBackup(configured, NOV);
    expect(await db.select().from(alerts).where(isNull(alerts.resolvedAt))).toHaveLength(0);
  });

  it("the anomaly sweep leaves it alone", async () => {
    expect(RULE_ALERT_TYPES).not.toContain("backup_not_configured");
    await runBackup(unconfigured, OCT);

    const result = await detectAnomaliesDailyProcessor(fakeJob, {
      env: {},
      now: () => OCT_LATER,
      notify: async () => ({ sent: false }),
      load: async () => ({
        recentTxns: [],
        balancePairs: [],
        brokenItems: [],
        accountStaleness: [],
        symbolStaleness: [],
        failedRuns: [],
      }),
    });
    expect(result.resolved).toBe(0);
    const [row] = await db.select().from(alerts).where(eq(alerts.type, "backup_not_configured"));
    expect(row?.resolvedAt).toBeNull();
  });
});
