// @vitest-environment node
import { db } from "@/db/client.ts";
import { accounts, obligationOccurrences, scheduledObligations } from "@/db/schema/index.ts";
import { asc, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { materializeOccurrences } from "./materialize.ts";
import type { ObligationPatch } from "./queries.ts";
import { upsertObligation } from "./queries.ts";

/**
 * P16-21 — materialization idempotency, against the real database.
 *
 * The UNIQUE `(obligation_id, due_date)` is the idempotency key (ADR-037 §2/§5),
 * and a mock cannot enforce a unique index — so these run against Postgres like
 * every other query-module suite. The property under test is the one the
 * unattended `project-cashflow-daily` job depends on: a job that dies halfway,
 * a Redis retry, or a user extending the horizon must all converge on the same
 * rows rather than accumulating duplicates a human has to reconcile.
 */

async function reset(): Promise<void> {
  await db.execute(sql`TRUNCATE obligation_occurrences, scheduled_obligations, accounts CASCADE`);
}

beforeEach(reset);

async function seedAccount(): Promise<string> {
  const [account] = await db
    .insert(accounts)
    .values({ name: "Checking", institution: "M&T", type: "depository", currency: "USD" })
    .returning({ id: accounts.id });
  if (!account) throw new Error("seed account");
  return account.id;
}

async function seedObligation(over: Partial<ObligationPatch> = {}): Promise<string> {
  const accountId = over.accountId ?? (await seedAccount());
  return upsertObligation({
    accountId,
    categoryId: null,
    label: "Mortgage",
    expectedAmount: "2150.00",
    direction: "outflow",
    currency: "USD",
    cadence: "monthly",
    anchorDate: "2026-01-01",
    startDate: "2026-01-01",
    endDate: null,
    active: true,
    amountMode: "fixed",
    source: "manual",
    detectionKey: null,
    confidence: null,
    notes: null,
    ...over,
  });
}

async function dueDates(obligationId: string): Promise<string[]> {
  const rows = await db
    .select({ dueDate: obligationOccurrences.dueDate })
    .from(obligationOccurrences)
    .where(eq(obligationOccurrences.obligationId, obligationId))
    .orderBy(asc(obligationOccurrences.dueDate));
  return rows.map((row) => row.dueDate);
}

describe("materializeOccurrences", () => {
  it("writes one row per due date from the start through the horizon", async () => {
    const id = await seedObligation();

    const result = await materializeOccurrences(await loadObligation(id), "2026-04-15");

    expect(result.created).toBe(4);
    expect(await dueDates(id)).toEqual(["2026-01-01", "2026-02-01", "2026-03-01", "2026-04-01"]);
  });

  it("snapshots the expected amount rather than pointing at the obligation", async () => {
    // ADR-037 §5: raising the rent in June must not retroactively claim the
    // household paid the new figure in March.
    const id = await seedObligation();
    await materializeOccurrences(await loadObligation(id), "2026-02-15");

    await db
      .update(scheduledObligations)
      .set({ expectedAmount: "2400.00" })
      .where(eq(scheduledObligations.id, id));
    await materializeOccurrences(await loadObligation(id), "2026-03-15");

    const rows = await db
      .select({
        dueDate: obligationOccurrences.dueDate,
        expectedAmount: obligationOccurrences.expectedAmount,
      })
      .from(obligationOccurrences)
      .where(eq(obligationOccurrences.obligationId, id))
      .orderBy(asc(obligationOccurrences.dueDate));

    expect(rows.map((r) => r.expectedAmount)).toEqual(["2150.00", "2150.00", "2400.00"]);
  });

  it("is a provable no-op on a second run over the same horizon", async () => {
    // The property the whole job rests on. Not "usually fine" — the UNIQUE
    // index makes it structural, and this is the assertion that says so.
    const id = await seedObligation();
    const obligation = await loadObligation(id);

    const first = await materializeOccurrences(obligation, "2026-06-15");
    const second = await materializeOccurrences(obligation, "2026-06-15");

    expect(first.created).toBe(6);
    expect(second.created).toBe(0);
    expect(await dueDates(id)).toHaveLength(6);
  });

  it("adds only the new tail when the horizon is extended", async () => {
    const id = await seedObligation();
    const obligation = await loadObligation(id);

    await materializeOccurrences(obligation, "2026-03-15");
    const extended = await materializeOccurrences(obligation, "2026-06-15");

    expect(extended.created).toBe(3);
    expect(await dueDates(id)).toEqual([
      "2026-01-01",
      "2026-02-01",
      "2026-03-01",
      "2026-04-01",
      "2026-05-01",
      "2026-06-01",
    ]);
  });

  it("writes nothing when the horizon is shorter than what already exists", async () => {
    // A job re-run with a shortened horizon must not delete the tail it wrote
    // before. Materialization only ever adds.
    const id = await seedObligation();
    const obligation = await loadObligation(id);
    await materializeOccurrences(obligation, "2026-06-15");

    const shrunk = await materializeOccurrences(obligation, "2026-02-15");

    expect(shrunk.created).toBe(0);
    expect(await dueDates(id)).toHaveLength(6);
  });

  it("stops at end_date even when the horizon runs past it", async () => {
    const id = await seedObligation({ endDate: "2026-03-15" });

    await materializeOccurrences(await loadObligation(id), "2026-12-31");

    expect(await dueDates(id)).toEqual(["2026-01-01", "2026-02-01", "2026-03-01"]);
  });

  it("materializes nothing for a deactivated obligation", async () => {
    // Deactivation pauses materialization without deleting the history that
    // explains past months (CLAUDE.md §Database).
    const id = await seedObligation({ active: false });

    const result = await materializeOccurrences(await loadObligation(id), "2026-06-15");

    expect(result.created).toBe(0);
    expect(await dueDates(id)).toEqual([]);
  });

  it("materializes nothing when the horizon precedes the start date", async () => {
    const id = await seedObligation({ startDate: "2027-01-01", anchorDate: "2027-01-01" });

    const result = await materializeOccurrences(await loadObligation(id), "2026-06-15");

    expect(result.created).toBe(0);
  });

  it("preserves a match when the next run walks back over that due date", async () => {
    // ON CONFLICT DO NOTHING, not DO UPDATE. A materializer that upserted would
    // wipe `status`, `matched_transaction_id` and `matched_amount` — erasing the
    // reconciliation the residual subtraction reads (ADR-038 §2).
    //
    // The row under test is the LAST one materialized, because that is the row
    // the next run is guaranteed to walk over again: a run resumes AT the last
    // due date rather than the day after it, so this conflict happens nightly.
    // Matching an earlier row would prove nothing — the next run never reaches it.
    const id = await seedObligation();
    const obligation = await loadObligation(id);
    await materializeOccurrences(obligation, "2026-02-15");

    await db
      .update(obligationOccurrences)
      .set({ status: "matched", matchedAmount: "-2149.31", matchedAt: new Date() })
      .where(eq(obligationOccurrences.dueDate, "2026-02-01"));

    await materializeOccurrences(obligation, "2026-06-15");

    const [february] = await db
      .select({
        status: obligationOccurrences.status,
        matchedAmount: obligationOccurrences.matchedAmount,
        expectedAmount: obligationOccurrences.expectedAmount,
      })
      .from(obligationOccurrences)
      .where(eq(obligationOccurrences.dueDate, "2026-02-01"));

    expect(february).toMatchObject({
      status: "matched",
      matchedAmount: "-2149.31",
      expectedAmount: "2150.00",
    });
  });

  it("resumes from where a partial run stopped", async () => {
    // A job killed mid-write leaves some rows. The next run must fill the gap
    // and not re-report the rows it already has.
    const id = await seedObligation();
    const obligation = await loadObligation(id);
    await materializeOccurrences(obligation, "2026-03-15");
    await db.delete(obligationOccurrences).where(eq(obligationOccurrences.dueDate, "2026-03-01"));

    const resumed = await materializeOccurrences(obligation, "2026-06-15");

    expect(resumed.created).toBe(4);
    expect(await dueDates(id)).toEqual([
      "2026-01-01",
      "2026-02-01",
      "2026-03-01",
      "2026-04-01",
      "2026-05-01",
      "2026-06-01",
    ]);
  });

  it("expands the long cadences obligations added", async () => {
    const id = await seedObligation({ cadence: "quarterly", anchorDate: "2026-01-15" });

    await materializeOccurrences(await loadObligation(id), "2026-12-31");

    expect(await dueDates(id)).toEqual(["2026-01-15", "2026-04-15", "2026-07-15", "2026-10-15"]);
  });

  it("rejects a horizon that is not a real date rather than writing a partial calendar", async () => {
    const id = await seedObligation();

    await expect(materializeOccurrences(await loadObligation(id), "2026-02-30")).rejects.toThrow(
      /not a real date/i,
    );
  });
});

/** Read one obligation back in the shape the materializer takes. */
async function loadObligation(id: string): Promise<Parameters<typeof materializeOccurrences>[0]> {
  const [row] = await db.select().from(scheduledObligations).where(eq(scheduledObligations.id, id));
  if (!row) throw new Error("loadObligation: not found");
  return {
    id: row.id,
    cadence: row.cadence as "monthly",
    anchorDate: row.anchorDate,
    startDate: row.startDate,
    endDate: row.endDate,
    expectedAmount: row.expectedAmount,
    active: row.active,
  };
}
