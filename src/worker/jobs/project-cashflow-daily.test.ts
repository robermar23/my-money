// @vitest-environment node
import { db } from "@/db/client.ts";
import {
  accountSnapshots,
  accounts,
  alerts,
  categories,
  householdProfile,
  obligationOccurrences,
  transactions,
} from "@/db/schema/index.ts";
import { upsertObligation } from "@/lib/cashflow/queries.ts";
import { asc, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { projectCashFlowDailyProcessor } from "./project-cashflow-daily.ts";

/**
 * Call-order recorder for the ordering test below.
 *
 * Both mocks DELEGATE to the real implementation, so every other test in this
 * file still exercises the genuine code path; the only thing added is a
 * note of which ran first.
 */
const callOrder: string[] = [];

vi.mock("@/lib/cashflow/sweep.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/cashflow/sweep.ts")>();
  return {
    ...actual,
    sweepOccurrences: async (...args: Parameters<typeof actual.sweepOccurrences>) => {
      callOrder.push("sweep");
      return actual.sweepOccurrences(...args);
    },
  };
});

vi.mock("@/lib/cashflow/loader.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/cashflow/loader.ts")>();
  return {
    ...actual,
    loadCashFlow: async (...args: Parameters<typeof actual.loadCashFlow>) => {
      callOrder.push("project");
      return actual.loadCashFlow(...args);
    },
  };
});

/**
 * P16-27 / P16-28 / P16-29 — the nightly cash-flow pass, end to end.
 *
 * Against the real database, because three of the four properties worth
 * asserting here are database constraints rather than code paths: the
 * materialization UNIQUE key, the `dedup_hash` UNIQUE index, and the sweep's
 * single transaction.
 *
 * The failure-path review (P16-29) is expressed as tests rather than as prose:
 *
 *   - **Resumable.** Running the whole job twice writes nothing the second time.
 *   - **Never re-nagging.** A shortfall that stands for a second night inserts
 *     no second alert (ADR-026).
 *   - **Debuggable without leaking.** No figure reaches a title, and the job
 *     writes no log line at all on the happy path (CLAUDE.md §Privacy).
 */

const NOW = new Date("2026-04-15T02:00:00Z");
const TODAY = "2026-04-15";
const notify = async (): Promise<{ sent: boolean }> => ({ sent: false });

async function reset(): Promise<void> {
  await db.execute(
    sql`TRUNCATE obligation_occurrences, scheduled_obligations, alerts, account_snapshots, transactions, categories, household_profile, accounts CASCADE`,
  );
}

beforeEach(async () => {
  callOrder.length = 0;
  await reset();
});

/** A checking account with a snapshotted balance — day zero of the walk. */
async function seedAccount(balance: string): Promise<string> {
  const [account] = await db
    .insert(accounts)
    .values({
      name: "Checking",
      institution: "M&T",
      type: "depository",
      subtype: "checking",
      currency: "USD",
    })
    .returning({ id: accounts.id });
  if (!account) throw new Error("seed account");
  await db.insert(accountSnapshots).values({ accountId: account.id, date: TODAY, balance });
  return account.id;
}

/** Four months of ordinary spend, so the honesty ladder clears its history gate. */
async function seedHistory(accountId: string): Promise<void> {
  const [category] = await db
    .insert(categories)
    .values({ name: "Groceries", kind: "expense" })
    .returning({ id: categories.id });
  const rows = [];
  for (let i = 1; i <= 120; i += 1) {
    const day = new Date(Date.parse(`${TODAY}T00:00:00Z`) - i * 86_400_000)
      .toISOString()
      .slice(0, 10);
    rows.push({
      accountId,
      postedAt: day,
      amount: "-40.00",
      name: "GROCERY MART",
      fitid: `grocery-${day}`,
      categoryId: category?.id ?? null,
      source: "manual" as const,
    });
  }
  await db.insert(transactions).values(rows);
}

async function seedObligation(
  accountId: string,
  expectedAmount: string,
  over: { anchorDate?: string; startDate?: string; detectionKey?: string | null } = {},
): Promise<string> {
  return upsertObligation({
    accountId,
    categoryId: null,
    label: "Mortgage",
    expectedAmount,
    direction: "outflow",
    currency: "USD",
    cadence: "monthly",
    anchorDate: over.anchorDate ?? "2026-01-01",
    startDate: over.startDate ?? "2026-01-01",
    endDate: null,
    active: true,
    amountMode: "fixed",
    source: "detected",
    detectionKey: over.detectionKey === undefined ? "acme mortgage co" : over.detectionKey,
    liabilityId: null,
    confidence: "high",
    notes: null,
  });
}

async function alertRows(): Promise<
  { type: string; severity: string; title: string; resolvedAt: Date | null }[]
> {
  return db
    .select({
      type: alerts.type,
      severity: alerts.severity,
      title: alerts.title,
      resolvedAt: alerts.resolvedAt,
    })
    .from(alerts)
    .orderBy(asc(alerts.type));
}

describe("projectCashFlowDailyProcessor", () => {
  it("runs on an empty install without writing anything", async () => {
    const result = await projectCashFlowDailyProcessor(undefined, { now: () => NOW, notify });

    expect(result).toMatchObject({ materialized: 0, swept: 0, created: 0 });
    expect(await alertRows()).toEqual([]);
  });

  it("materializes the calendar forward for an active obligation", async () => {
    const accountId = await seedAccount("5000.00");
    await seedObligation(accountId, "2150.00");

    const result = await projectCashFlowDailyProcessor(undefined, { now: () => NOW, notify });

    expect(result.materialized).toBeGreaterThan(0);
    const rows = await db
      .select({ dueDate: obligationOccurrences.dueDate })
      .from(obligationOccurrences);
    expect(rows.length).toBe(result.materialized);
  });

  it("is a no-op on a second run — every write is constraint-guarded", async () => {
    const accountId = await seedAccount("5000.00");
    await seedObligation(accountId, "2150.00");
    await seedHistory(accountId);

    await projectCashFlowDailyProcessor(undefined, { now: () => NOW, notify });
    const occurrencesAfterFirst = await db
      .select({ id: obligationOccurrences.id, status: obligationOccurrences.status })
      .from(obligationOccurrences)
      .orderBy(asc(obligationOccurrences.id));
    const alertsAfterFirst = await alertRows();

    const second = await projectCashFlowDailyProcessor(undefined, { now: () => NOW, notify });

    expect(second.materialized).toBe(0);
    expect(second.created).toBe(0);
    expect(
      await db
        .select({ id: obligationOccurrences.id, status: obligationOccurrences.status })
        .from(obligationOccurrences)
        .orderBy(asc(obligationOccurrences.id)),
    ).toEqual(occurrencesAfterFirst);
    expect(await alertRows()).toEqual(alertsAfterFirst);
  });

  it("resumes a partially materialized calendar without duplicating a due date", async () => {
    // P16-29's resumability ask, literally. A run that died halfway leaves some
    // occurrences written; the next run must add only the tail. The guarantee is
    // the UNIQUE `(obligation_id, due_date)` index, not bookkeeping — so this
    // asserts the outcome the index is there to produce.
    const accountId = await seedAccount("5000.00");
    const obligationId = await seedObligation(accountId, "2150.00");
    const { materializeOccurrences } = await import("@/lib/cashflow/materialize.ts");
    await materializeOccurrences(
      {
        id: obligationId,
        cadence: "monthly",
        anchorDate: "2026-01-01",
        startDate: "2026-01-01",
        endDate: null,
        expectedAmount: "2150.00",
        active: true,
      },
      // Stops short of the horizon — the "died halfway" state.
      "2026-05-01",
    );
    const partial = await db
      .select({ dueDate: obligationOccurrences.dueDate })
      .from(obligationOccurrences);

    const result = await projectCashFlowDailyProcessor(undefined, { now: () => NOW, notify });

    const all = await db
      .select({ dueDate: obligationOccurrences.dueDate })
      .from(obligationOccurrences);
    expect(result.materialized).toBeGreaterThan(0);
    expect(all.length).toBe(partial.length + result.materialized);
    // No due date written twice.
    expect(new Set(all.map((row) => row.dueDate)).size).toBe(all.length);
  });

  it("raises a shortfall when the projection dips below the floor", async () => {
    // A thin balance, a big monthly bill, and a stated buffer: the low-water
    // mark lands under the floor well inside the horizon.
    const accountId = await seedAccount("2500.00");
    await seedHistory(accountId);
    await db.insert(householdProfile).values({ cashFloor: "1000.00" });
    await seedObligation(accountId, "2150.00");

    const result = await projectCashFlowDailyProcessor(undefined, { now: () => NOW, notify });

    const shortfalls = (await alertRows()).filter((row) => row.type === "projected_shortfall");
    expect(shortfalls).toHaveLength(1);
    expect(result.created).toBeGreaterThan(0);
  });

  it("does not re-nag a shortfall that is still standing (ADR-026)", async () => {
    const accountId = await seedAccount("2500.00");
    await seedHistory(accountId);
    await db.insert(householdProfile).values({ cashFloor: "1000.00" });
    await seedObligation(accountId, "2150.00");

    await projectCashFlowDailyProcessor(undefined, { now: () => NOW, notify });
    const tomorrow = new Date("2026-04-16T02:00:00Z");
    await projectCashFlowDailyProcessor(undefined, { now: () => tomorrow, notify });

    const shortfalls = (await alertRows()).filter((row) => row.type === "projected_shortfall");
    expect(shortfalls).toHaveLength(1);
    expect(shortfalls[0]?.resolvedAt).toBeNull();
  });

  it("resolves the shortfall once the projection recovers", async () => {
    const accountId = await seedAccount("2500.00");
    await seedHistory(accountId);
    await db.insert(householdProfile).values({ cashFloor: "1000.00" });
    const obligationId = await seedObligation(accountId, "2150.00");

    await projectCashFlowDailyProcessor(undefined, { now: () => NOW, notify });

    // The household comes into money.
    await db
      .update(accountSnapshots)
      .set({ balance: "80000.00" })
      .where(eq(accountSnapshots.accountId, accountId));
    await projectCashFlowDailyProcessor(undefined, { now: () => NOW, notify });

    const shortfalls = (await alertRows()).filter((row) => row.type === "projected_shortfall");
    expect(shortfalls).toHaveLength(1);
    expect(shortfalls[0]?.resolvedAt).not.toBeNull();
    expect(obligationId).toBeTruthy();
  });

  it("raises a miss when a confirmed bill's window closes with nothing found", async () => {
    const accountId = await seedAccount("50000.00");
    await seedHistory(accountId);
    // Anchored on the 1st and started last month, so April 1 is comfortably
    // past its ±5-day window by April 15 and nothing posted against it.
    await seedObligation(accountId, "2150.00", { startDate: "2026-04-01" });

    const result = await projectCashFlowDailyProcessor(undefined, { now: () => NOW, notify });

    expect(result.missed).toBeGreaterThan(0);
    expect((await alertRows()).some((row) => row.type === "obligation_missed")).toBe(true);
  });

  it("raises an amount change when the bill posts for materially more", async () => {
    // $2,400 against an expected $2,150 is +11.6%: past the 5% alert threshold
    // and still inside the matcher's 15% tolerance. That band — "recognizably
    // the same bill, for a different amount" — is exactly what this alert is.
    const accountId = await seedAccount("50000.00");
    await seedHistory(accountId);
    await seedObligation(accountId, "2150.00", { startDate: "2026-04-01" });
    await db.insert(transactions).values({
      accountId,
      postedAt: "2026-04-01",
      amount: "-2400.00",
      name: "ACME MORTGAGE CO",
      fitid: "mortgage-2026-04-01",
      source: "manual",
    });

    const result = await projectCashFlowDailyProcessor(undefined, { now: () => NOW, notify });

    expect(result.matched).toBeGreaterThan(0);
    const changed = (await alertRows()).filter((row) => row.type === "obligation_amount_changed");
    expect(changed).toHaveLength(1);
  });

  it("reports a bill that moved MORE than the tolerance as missed, not changed", async () => {
    // The boundary, recorded rather than left to be rediscovered. A payment
    // 21% away from the expectation is outside what the matcher will accept as
    // the same event — it cannot tell that apart from a different charge at the
    // same merchant — so the household is told the bill did not post as
    // scheduled. That is the honest answer, and the fix is one edit to the
    // expected amount on /plan/cashflow/review.
    const accountId = await seedAccount("50000.00");
    await seedHistory(accountId);
    await seedObligation(accountId, "2150.00", { startDate: "2026-04-01" });
    await db.insert(transactions).values({
      accountId,
      postedAt: "2026-04-01",
      amount: "-2600.00",
      name: "ACME MORTGAGE CO",
      fitid: "mortgage-2026-04-01",
      source: "manual",
    });

    const result = await projectCashFlowDailyProcessor(undefined, { now: () => NOW, notify });

    expect(result.matched).toBe(0);
    const types = (await alertRows()).map((row) => row.type);
    expect(types).toContain("obligation_missed");
    expect(types).not.toContain("obligation_amount_changed");
  });

  it("never puts a figure in an alert title (ADR-015)", async () => {
    const accountId = await seedAccount("2500.00");
    await seedHistory(accountId);
    await db.insert(householdProfile).values({ cashFloor: "1000.00" });
    await seedObligation(accountId, "2150.00", { startDate: "2026-04-01" });

    await projectCashFlowDailyProcessor(undefined, { now: () => NOW, notify });

    const rows = await alertRows();
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.title).not.toMatch(/\d/);
    }
  });

  it("logs nothing at all on the happy path", async () => {
    // An unattended job that prints a balance at 02:00 has put a figure in a
    // file that outlives the process (CLAUDE.md §Privacy).
    const accountId = await seedAccount("2500.00");
    await seedHistory(accountId);
    await seedObligation(accountId, "2150.00");
    const spies = [
      vi.spyOn(console, "log").mockImplementation(() => {}),
      vi.spyOn(console, "info").mockImplementation(() => {}),
      vi.spyOn(console, "warn").mockImplementation(() => {}),
      vi.spyOn(console, "error").mockImplementation(() => {}),
    ];

    await projectCashFlowDailyProcessor(undefined, { now: () => NOW, notify });

    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    }
  });

  it("stays silent when the household has no operating account to project", async () => {
    // ADR-038 §7: no projection at all, rather than a projection from savings.
    const [account] = await db
      .insert(accounts)
      .values({
        name: "Savings",
        institution: "Ally",
        type: "depository",
        subtype: "savings",
        currency: "USD",
      })
      .returning({ id: accounts.id });
    if (!account) throw new Error("seed");
    await db
      .insert(accountSnapshots)
      .values({ accountId: account.id, date: TODAY, balance: "10.00" });
    await db.insert(householdProfile).values({ cashFloor: "5000.00" });

    await projectCashFlowDailyProcessor(undefined, { now: () => NOW, notify });

    expect((await alertRows()).some((row) => row.type === "projected_shortfall")).toBe(false);
  });

  it("reconciles BEFORE it projects, so the attribution is not a day stale", async () => {
    // Not a style preference. The residual rate subtracts spend attributable to
    // confirmed bills, and "attributable" means MATCHED (ADR-038 §2). A
    // projection computed before the sweep would price an occurrence that
    // settled overnight at its expectation rather than at what actually posted,
    // and every figure downstream — coverage, the rate, safe-to-spend — would
    // be a day behind on the one morning the household is asking.
    const accountId = await seedAccount("50000.00");
    await seedHistory(accountId);
    await seedObligation(accountId, "2150.00", { startDate: "2026-04-01" });

    await projectCashFlowDailyProcessor(undefined, { now: () => NOW, notify });

    expect(callOrder).toEqual(["sweep", "project"]);
  });

  it("stays silent on a household without enough history to rate", async () => {
    // No `seedHistory` — under three months, so the ladder says
    // `insufficient_history` and the app does not alert off a number it has
    // already labelled untrustworthy.
    const accountId = await seedAccount("100.00");
    await db.insert(householdProfile).values({ cashFloor: "9000.00" });
    await seedObligation(accountId, "2150.00");

    await projectCashFlowDailyProcessor(undefined, { now: () => NOW, notify });

    expect((await alertRows()).some((row) => row.type === "projected_shortfall")).toBe(false);
  });
});
