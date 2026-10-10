// @vitest-environment node
import { db } from "@/db/client.ts";
import { alerts } from "@/db/schema/index.ts";
import type { AlertInputs } from "@/lib/alerts/rules.ts";
import type { Job } from "bullmq";
import { eq, isNull, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { detectAnomaliesDailyProcessor } from "./detect-anomalies-daily.ts";

const fakeJob = { id: "test" } as unknown as Job;
const NOW = new Date("2026-06-07T12:00:00.000Z");

const EMPTY: AlertInputs = {
  recentTxns: [],
  balancePairs: [],
  brokenItems: [],
  accountStaleness: [],
  symbolStaleness: [],
  failedRuns: [],
};

/** A large txn + a broken Plaid item → two distinct open alerts. */
function inputsWith(over: Partial<AlertInputs>): AlertInputs {
  return { ...EMPTY, ...over };
}

const bigTxn = {
  id: "t1",
  accountId: "a1",
  postedAt: "2026-06-07",
  amount: "-5000.00",
  name: "Wire",
};
const brokenItem = { id: "i1", institutionName: "M&T", status: "login_required" };

async function reset(): Promise<void> {
  await db.execute(sql`TRUNCATE alerts`);
}

// SMTP disabled by default so notify is a no-op unless a test injects one.
const noEnv = {};

describe("detectAnomaliesDailyProcessor", () => {
  beforeEach(reset);
  afterAll(reset);

  it("creates one open alert per detected condition", async () => {
    const result = await detectAnomaliesDailyProcessor(fakeJob, {
      env: noEnv,
      now: () => NOW,
      load: async () => inputsWith({ recentTxns: [bigTxn], brokenItems: [brokenItem] }),
    });
    expect(result.created).toBe(2);

    const open = await db.select().from(alerts).where(isNull(alerts.resolvedAt));
    expect(open).toHaveLength(2);
    expect(open.map((a) => a.type).sort()).toEqual(["item_login_required", "large_transaction"]);
  });

  it("is idempotent: a second identical run inserts zero new rows", async () => {
    const deps = {
      env: noEnv,
      now: () => NOW,
      load: async () => inputsWith({ recentTxns: [bigTxn], brokenItems: [brokenItem] }),
    };
    await detectAnomaliesDailyProcessor(fakeJob, deps);
    const second = await detectAnomaliesDailyProcessor(fakeJob, deps);
    expect(second.created).toBe(0);
    expect(await db.$count(alerts)).toBe(2);
  });

  it("resolves a cleared condition while leaving still-open ones", async () => {
    // Run 1: both conditions present.
    await detectAnomaliesDailyProcessor(fakeJob, {
      env: noEnv,
      now: () => NOW,
      load: async () => inputsWith({ recentTxns: [bigTxn], brokenItems: [brokenItem] }),
    });
    // Run 2: the item is fixed (no longer broken); the txn still detected.
    const result = await detectAnomaliesDailyProcessor(fakeJob, {
      env: noEnv,
      now: () => NOW,
      load: async () => inputsWith({ recentTxns: [bigTxn] }),
    });
    expect(result.resolved).toBe(1);

    const itemAlert = await db.select().from(alerts).where(eq(alerts.type, "item_login_required"));
    const txnAlert = await db.select().from(alerts).where(eq(alerts.type, "large_transaction"));
    expect(itemAlert[0]?.resolvedAt).not.toBeNull(); // resolved
    expect(txnAlert[0]?.resolvedAt).toBeNull(); // still open
  });

  it("sends a notification for open un-notified alerts and stamps notified_at on success", async () => {
    const notify = vi.fn(async () => ({ sent: true }));
    const result = await detectAnomaliesDailyProcessor(fakeJob, {
      env: noEnv,
      now: () => NOW,
      notify,
      load: async () => inputsWith({ recentTxns: [bigTxn] }),
    });
    expect(notify).toHaveBeenCalledWith(1, "2026-06-07");
    expect(result.notified).toBe(1);

    const open = await db.select().from(alerts).where(isNull(alerts.resolvedAt));
    expect(open[0]?.notifiedAt).not.toBeNull();
  });

  it("does not stamp notified_at when the email is not sent", async () => {
    const notify = vi.fn(async () => ({ sent: false }));
    await detectAnomaliesDailyProcessor(fakeJob, {
      env: noEnv,
      now: () => NOW,
      notify,
      load: async () => inputsWith({ recentTxns: [bigTxn] }),
    });
    const open = await db.select().from(alerts).where(isNull(alerts.resolvedAt));
    expect(open[0]?.notifiedAt).toBeNull();
  });

  it("never auto-resolves a backup_failure alert, but does notify it", async () => {
    // The backup job writes this row DIRECTLY; backup_failure is NOT a rule type,
    // so the resolve sweep (which iterates RULE_ALERT_TYPES only) must leave it
    // open even on a run where no rule fires. It clears only on a successful
    // backup (clearBackupAlerts), not here.
    await db.insert(alerts).values({
      type: "backup_failure",
      severity: "critical",
      dedupHash: "backup-failure-2026-06-07",
      title: "Nightly database backup failed",
      detail: { date: "2026-06-07" },
    });

    const notify = vi.fn(async () => ({ sent: true }));
    const result = await detectAnomaliesDailyProcessor(fakeJob, {
      env: noEnv,
      now: () => NOW,
      notify,
      load: async () => EMPTY, // no rule fires
    });

    // If the resolve loop ever swept all types, this would be 1 → regression.
    expect(result.resolved).toBe(0);
    const row = await db.select().from(alerts).where(eq(alerts.type, "backup_failure"));
    expect(row[0]?.resolvedAt).toBeNull();
    // The standing failure is still surfaced in the content-free notification.
    expect(notify).toHaveBeenCalledWith(1, "2026-06-07");
    expect(row[0]?.notifiedAt).not.toBeNull();
  });
});
