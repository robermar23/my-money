// @vitest-environment node
import { db } from "@/db/client.ts";
import { accounts, obligationOccurrences, scheduledObligations } from "@/db/schema/index.ts";
import { materializeOccurrences } from "@/lib/cashflow/materialize.ts";
import { type ObligationPatch, upsertObligation } from "@/lib/cashflow/queries.ts";
import { parseIsoDate } from "@/lib/schedule/occurrences.ts";
import { asc, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { buildCostStream } from "./costs.ts";
import { materializationDaysAhead } from "./coverage.ts";

/**
 * P18-11 — the occurrence-coverage fix, end to end, against the real database.
 *
 * **This file exists because the fix is otherwise only proven in halves.**
 * [coverage.test.ts](./coverage.test.ts) asserts the widened lead as a number
 * and [costs.test.ts](./costs.test.ts) asserts the stream admits an eleven-month
 * cost *given the row* — but the thing that can actually be wrong is whether the
 * row gets written. That is the materializer's job, the UNIQUE index is what
 * makes it idempotent, and neither can be checked by a mock. So this runs the
 * real `materializeOccurrences` and then the real `buildCostStream` over what it
 * wrote, which is PLAN18 acceptance criterion 5 as one assertion.
 *
 * The second test is the one that makes the first mean something: with the
 * cash-flow lead the row is **absent**, the requirement is silently understated,
 * and nothing anywhere is red. That is the failure this phase was most likely to
 * ship.
 */

/** The shipped cash-flow default: 60-day horizon + 30-day lead. */
const CASH_FLOW_DAYS_AHEAD = 90;
const TODAY = "2026-10-04";
/** Twelve months out (ADR-045 §5). */
const HORIZON_TO = "2027-10-04";
/** An annual premium eleven months away — the criterion's own example. */
const PREMIUM_DUE = "2027-09-01";
const MS_PER_DAY = 86_400_000;

/** Test scaffolding: `YYYY-MM-DD` shifted by whole days, via the one parser. */
function shiftDays(iso: string, days: number): string {
  return new Date(parseIsoDate(iso, "iso") + days * MS_PER_DAY).toISOString().slice(0, 10);
}

beforeEach(async () => {
  await db.execute(sql`TRUNCATE obligation_occurrences, scheduled_obligations, accounts CASCADE`);
});

async function seedAnnualPremium(): Promise<string> {
  const [account] = await db
    .insert(accounts)
    .values({ name: "Checking", institution: "M&T", type: "depository", currency: "USD" })
    .returning({ id: accounts.id });
  if (!account) throw new Error("seed account");

  const patch: ObligationPatch = {
    accountId: account.id,
    categoryId: null,
    label: "Car insurance",
    expectedAmount: "1340.00",
    direction: "outflow",
    currency: "USD",
    cadence: "annual",
    // Phased so the next occurrence lands eleven months out.
    anchorDate: PREMIUM_DUE,
    startDate: TODAY,
    endDate: null,
    active: true,
    amountMode: "fixed",
    source: "manual",
    detectionKey: null,
    liabilityId: null,
    confidence: null,
    notes: null,
  };
  return upsertObligation(patch);
}

/** Materialize one obligation `daysAhead` of `TODAY`, as both call sites do. */
async function materialize(obligationId: string, daysAhead: number): Promise<void> {
  const [row] = await db
    .select()
    .from(scheduledObligations)
    .where(eq(scheduledObligations.id, obligationId));
  if (!row) throw new Error("obligation not found");
  await materializeOccurrences(
    {
      id: row.id,
      cadence: "annual",
      anchorDate: row.anchorDate,
      startDate: row.startDate,
      endDate: row.endDate,
      expectedAmount: row.expectedAmount,
      active: row.active,
    },
    shiftDays(TODAY, daysAhead),
  );
}

/** Everything the pure stream needs, read back from Postgres. */
async function streamFromDatabase() {
  const obligations = await db.select().from(scheduledObligations);
  const occurrences = await db
    .select()
    .from(obligationOccurrences)
    .orderBy(asc(obligationOccurrences.dueDate));

  return buildCostStream({
    horizonFrom: TODAY,
    horizonTo: HORIZON_TO,
    plannedExpenses: [],
    obligations: obligations.map((row) => ({
      id: row.id,
      label: row.label,
      currency: row.currency,
      cadence: "annual",
      direction: "outflow",
      active: row.active,
      categoryId: row.categoryId,
    })),
    occurrences: occurrences.map((row) => ({
      id: row.id,
      obligationId: row.obligationId,
      dueDate: row.dueDate,
      expectedAmount: row.expectedAmount,
      status: "scheduled",
    })),
  });
}

describe("occurrence coverage (P18-11, acceptance criterion 5)", () => {
  it("puts an annual obligation eleven months out into the stream", async () => {
    const id = await seedAnnualPremium();

    await materialize(id, materializationDaysAhead("annual", CASH_FLOW_DAYS_AHEAD));

    const stream = await streamFromDatabase();
    expect(stream.map((cost) => cost.dueDate)).toContain(PREMIUM_DUE);
    expect(stream).toHaveLength(1);
    expect(stream[0]).toMatchObject({
      source: "obligation",
      label: "Car insurance",
      amount: "1340.00",
      dueDate: PREMIUM_DUE,
      // No earlier occurrence exists, so the honest funding start is today
      // rather than last September (ADR-045 §3).
      fundingStart: TODAY,
    });
  });

  it("CATCHES the bug: on the cash-flow lead alone the cost does not exist", async () => {
    // Not hypothetical — this is what the shipped defaults do, and the whole
    // reason the lead is now computed per cadence. The household's $1,340
    // premium is simply missing from a number that looks confident.
    const id = await seedAnnualPremium();

    await materialize(id, CASH_FLOW_DAYS_AHEAD);

    expect(await streamFromDatabase()).toEqual([]);
  });

  it("stays idempotent when the widened lead re-runs over rows it already wrote", async () => {
    // The property the unattended nightly job depends on (ADR-037 §2): the
    // widened window adds only the tail, and a second run writes nothing.
    const id = await seedAnnualPremium();
    const daysAhead = materializationDaysAhead("annual", CASH_FLOW_DAYS_AHEAD);

    await materialize(id, daysAhead);
    const first = await db.select().from(obligationOccurrences);
    await materialize(id, daysAhead);
    const second = await db.select().from(obligationOccurrences);

    expect(second.map((row) => row.id)).toEqual(first.map((row) => row.id));
  });
});
