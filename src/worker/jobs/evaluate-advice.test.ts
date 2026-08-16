// @vitest-environment node
import { db } from "@/db/client.ts";
import { alerts } from "@/db/schema/index.ts";
import { adviceDedupHash } from "@/lib/advice/alerts.ts";
import type { DetectedAlert } from "@/lib/alerts/rules.ts";
import type { Job } from "bullmq";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { evaluateAdviceProcessor } from "./evaluate-advice.ts";

/**
 * The persist + dedup + notify wiring (P15-36).
 *
 * The mapping itself is tested in `src/lib/advice/alerts.test.ts` as a pure
 * function; the loader is injected here so this file tests only what the job
 * adds — that a standing condition inserts once, that a re-run is a no-op, and
 * that the notification stays content-free.
 */

const fakeJob = { id: "test" } as unknown as Job;
const NOW = new Date("2026-08-15T12:00:00.000Z");
const noEnvNotify = vi.fn(async () => ({ sent: false }));

async function reset(): Promise<void> {
  await db.execute(sql`TRUNCATE alerts CASCADE`);
}

function detected(over: Partial<DetectedAlert> = {}): DetectedAlert {
  return {
    type: "advice",
    severity: "critical",
    dedupHash: adviceDedupHash("emergency_fund", "", "critical|action"),
    title: "Guidance: Emergency fund",
    detail: {
      ruleId: "emergency_fund",
      recommendation: "Build your emergency fund to $18,000.00",
      impact: "16800.00",
      href: "/plan",
    },
    ...over,
  };
}

describe("evaluateAdviceProcessor", () => {
  beforeEach(reset);
  afterAll(reset);

  it("persists a material recommendation as one alert", async () => {
    const result = await evaluateAdviceProcessor(fakeJob, {
      now: () => NOW,
      notify: noEnvNotify,
      load: async () => [detected()],
    });

    expect(result).toMatchObject({ detected: 1, created: 1 });
    const rows = await db.select().from(alerts).where(eq(alerts.type, "advice"));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.severity).toBe("critical");
  });

  it("does not re-nag about a standing condition", async () => {
    // The property the whole dedup design exists for: an under-funded reserve is
    // still under-funded tomorrow, and firing nightly would train the user to
    // ignore the alerts page.
    const deps = { now: () => NOW, notify: noEnvNotify, load: async () => [detected()] };
    await evaluateAdviceProcessor(fakeJob, deps);
    const second = await evaluateAdviceProcessor(fakeJob, deps);

    expect(second.detected).toBe(1);
    expect(second.created).toBe(0);
    expect(await db.$count(alerts)).toBe(1);
  });

  it("fires again when the state genuinely changes", async () => {
    await evaluateAdviceProcessor(fakeJob, {
      now: () => NOW,
      notify: noEnvNotify,
      load: async () => [
        detected({
          severity: "warning",
          dedupHash: adviceDedupHash("emergency_fund", "", "warning|action"),
        }),
      ],
    });
    await evaluateAdviceProcessor(fakeJob, {
      now: () => NOW,
      notify: noEnvNotify,
      load: async () => [detected()],
    });

    expect(await db.$count(alerts)).toBe(2);
  });

  it("writes nothing when the household has nothing urgent", async () => {
    const result = await evaluateAdviceProcessor(fakeJob, {
      now: () => NOW,
      notify: noEnvNotify,
      load: async () => [],
    });

    expect(result).toEqual({ detected: 0, created: 0, notified: 0 });
    expect(await db.$count(alerts)).toBe(0);
  });

  it("stores no figure in the alert title", async () => {
    // ADR-015 at the persistence layer, not just in the mapper.
    await evaluateAdviceProcessor(fakeJob, {
      now: () => NOW,
      notify: noEnvNotify,
      load: async () => [detected()],
    });

    const [row] = await db.select().from(alerts);
    expect(row?.title).toBe("Guidance: Emergency fund");
    expect(row?.title).not.toMatch(/\d/);
    // …while the figures are present in `detail`, which is never emailed.
    expect(row?.detail.impact).toBe("16800.00");
  });

  it("notifies with a count only, and stamps notified_at", async () => {
    const notify = vi.fn(async () => ({ sent: true }));
    const result = await evaluateAdviceProcessor(fakeJob, {
      now: () => NOW,
      notify,
      load: async () => [detected()],
    });

    expect(result.notified).toBe(1);
    // A count and a date. Nothing else crosses the SMTP boundary.
    expect(notify).toHaveBeenCalledWith(1, "2026-08-15");
    const [row] = await db.select().from(alerts);
    expect(row?.notifiedAt?.toISOString()).toBe(NOW.toISOString());
  });

  it("leaves notified_at unset when SMTP is not configured", async () => {
    await evaluateAdviceProcessor(fakeJob, {
      now: () => NOW,
      notify: noEnvNotify,
      load: async () => [detected()],
    });

    const [row] = await db.select().from(alerts);
    expect(row?.notifiedAt).toBeNull();
  });

  it("does not resolve an advice alert on a later quiet run", async () => {
    // `advice` is exempt from the resolve sweep: a rule going quiet may mean the
    // input went missing, not that the situation improved.
    await evaluateAdviceProcessor(fakeJob, {
      now: () => NOW,
      notify: noEnvNotify,
      load: async () => [detected()],
    });
    await evaluateAdviceProcessor(fakeJob, {
      now: () => NOW,
      notify: noEnvNotify,
      load: async () => [],
    });

    const [row] = await db.select().from(alerts);
    expect(row?.resolvedAt).toBeNull();
  });
});
