// @vitest-environment node
import { db } from "@/db/client.ts";
import { alerts } from "@/db/schema/index.ts";
import { RULE_ALERT_TYPES } from "@/lib/alerts/rules.ts";
import { sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { clearJobFailure, isFinalAttempt, recordJobFailure } from "./job-failure-alert.ts";

/**
 * `job_failure`: the worker's signal that a job exhausted its retries, against
 * the real `alerts` table.
 */

const MON = new Date("2026-11-09T05:00:00.000Z");
const MON_LATER = new Date("2026-11-09T06:00:00.000Z");
const TUE = new Date("2026-11-10T05:00:00.000Z");

async function openJobFailures() {
  return db
    .select()
    .from(alerts)
    .where(sql`${alerts.type} = 'job_failure' AND ${alerts.resolvedAt} IS NULL`);
}

async function reset(): Promise<void> {
  await db.execute(sql`TRUNCATE alerts`);
}

describe("isFinalAttempt", () => {
  it("is false while a retry is still pending", () => {
    expect(isFinalAttempt({ attemptsMade: 1, opts: { attempts: 3 } })).toBe(false);
  });

  it("is true once the attempts are spent", () => {
    expect(isFinalAttempt({ attemptsMade: 3, opts: { attempts: 3 } })).toBe(true);
  });

  it("is true when BullMQ finished the job early (UnrecoverableError)", () => {
    expect(isFinalAttempt({ attemptsMade: 1, finishedOn: 1, opts: { attempts: 3 } })).toBe(true);
  });

  it("treats a missing job as final rather than swallowing it", () => {
    expect(isFinalAttempt(undefined)).toBe(true);
  });
});

describe("job_failure alert", () => {
  beforeEach(reset);
  afterAll(reset);

  it("records one open alert per queue per day, naming only the queue", async () => {
    await recordJobFailure("detect-anomalies-daily", "1", "boom", MON);
    await recordJobFailure("detect-anomalies-daily", "2", "boom again", MON_LATER);
    await recordJobFailure("evaluate-advice", "3", "other", MON);
    await recordJobFailure("detect-anomalies-daily", "4", "next day", TUE);

    const rows = await openJobFailures();
    expect(rows).toHaveLength(3);
    const anomaly = rows.find((r) => r.detail.jobId === "1");
    expect(anomaly?.title).toBe("Background job failed: detect-anomalies-daily");
    expect(anomaly?.severity).toBe("warning");
    expect(anomaly?.detail.error).toBe("boom");
  });

  it("caps the stored error text", async () => {
    await recordJobFailure("export-beancount-daily", undefined, "x".repeat(2_000), MON);
    const [row] = await openJobFailures();
    expect(String(row?.detail.error)).toHaveLength(500);
    expect(row?.detail.jobId).toBeNull();
  });

  it("is cleared by a later success of the same queue only", async () => {
    await recordJobFailure("detect-anomalies-daily", "1", "boom", MON);
    await recordJobFailure("evaluate-advice", "2", "boom", MON);

    await clearJobFailure("detect-anomalies-daily", TUE);

    const open = await openJobFailures();
    expect(open.map((r) => r.detail.queue)).toEqual(["evaluate-advice"]);
  });

  it("is not swept by the anomaly detector", () => {
    expect(RULE_ALERT_TYPES).not.toContain("job_failure");
  });
});
