// @vitest-environment node
import { db } from "@/db/client.ts";
import { recordRestoreDrill } from "@/lib/household/queries.ts";
import { sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import journal from "../../../drizzle/meta/_journal.json";

/**
 * P19-10 / P19-12 loaders against the real test database. The two BullMQ queues
 * are faked — the jobs they return are the shapes BullMQ stores.
 */

interface FakeJob {
  readonly finishedOn?: number;
  readonly returnvalue: unknown;
}

const queues = vi.hoisted(() => ({
  heartbeat: [] as FakeJob[],
  backup: [] as FakeJob[],
  heartbeatError: null as Error | null,
}));

vi.mock("@/lib/queue/queues.ts", () => ({
  heartbeatQueue: {
    getJobs: async () => {
      if (queues.heartbeatError) throw queues.heartbeatError;
      return queues.heartbeat.slice(0, 1);
    },
  },
  backupDatabaseDailyQueue: { getJobs: async () => queues.backup },
}));

const { loadInstanceState } = await import("./queries.ts");

const NOW = new Date("2026-10-10T12:00:00.000Z");
const latestTag = journal.entries.at(-1)?.tag;

const workerConfig = {
  backups: { enabled: true, dir: "/backups", retainDays: 14 },
  beancount: { enabled: false },
  email: { smtpSet: false, recipientSet: false },
  plaid: { env: "sandbox", clientIdSet: false, secretSet: false, webhookUrlSet: false },
  sessionCookieSecure: false,
};

async function reset(): Promise<void> {
  await db.execute(sql`TRUNCATE household_profile`);
  queues.heartbeat = [];
  queues.backup = [];
  queues.heartbeatError = null;
}

describe("loadInstanceState", () => {
  beforeEach(reset);
  afterAll(reset);

  it("reports the migrated test database as current with this build's journal", async () => {
    const state = await loadInstanceState(NOW);
    expect(state.migrations).toEqual({ kind: "current", latest: latestTag });
  });

  it("reads the worker's own report and its liveness from the newest heartbeat", async () => {
    queues.heartbeat = [
      { finishedOn: NOW.getTime() - 30_000, returnvalue: { config: workerConfig } },
    ];
    const state = await loadInstanceState(NOW);
    expect(state.worker).toMatchObject({ liveness: { kind: "alive" }, config: workerConfig });
  });

  it("ignores a heartbeat report it cannot validate rather than trusting it", async () => {
    queues.heartbeat = [{ finishedOn: NOW.getTime(), returnvalue: { config: { backups: "yes" } } }];
    const state = await loadInstanceState(NOW);
    expect(state.worker).toMatchObject({ liveness: { kind: "alive" }, config: null });
  });

  it("degrades to unavailable when Redis fails, without failing the page", async () => {
    queues.heartbeatError = new Error("redis down");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const state = await loadInstanceState(NOW);
    expect(state.worker).toEqual({ kind: "unavailable" });
    expect(state.migrations).toMatchObject({ kind: "current" });
  });

  it("takes the newest backup that wrote a file, skipping skipped runs", async () => {
    const good = NOW.getTime() - 86_400_000;
    queues.backup = [
      { finishedOn: NOW.getTime(), returnvalue: { skipped: true } },
      { finishedOn: good, returnvalue: { outPath: "/backups/x.dump.age", pruned: 0 } },
    ];
    const state = await loadInstanceState(NOW);
    expect(state.backup).toEqual({ lastSuccessAt: new Date(good) });
  });

  it("shows a restore drill only once one is recorded (P19-12)", async () => {
    expect((await loadInstanceState(NOW)).drill).toEqual({ kind: "never" });

    const at = new Date("2026-10-01T12:00:00.000Z");
    await recordRestoreDrill(at);
    expect((await loadInstanceState(NOW)).drill).toEqual({
      kind: "recorded",
      at,
      ageDays: 9,
      due: false,
    });
  });

  it("recording a drill keeps the singleton a singleton", async () => {
    await recordRestoreDrill(new Date("2026-09-01T00:00:00.000Z"));
    await recordRestoreDrill(new Date("2026-10-01T00:00:00.000Z"));
    const rows = await db.execute(sql`SELECT count(*)::int AS n FROM household_profile`);
    expect(rows[0]?.n).toBe(1);
  });
});
