// @vitest-environment node
import { db } from "@/db/client.ts";
import { accounts, obligationOccurrences, transactions } from "@/db/schema/index.ts";
import { asc, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { materializeOccurrences } from "./materialize.ts";
import type { ObligationPatch } from "./queries.ts";
import { upsertObligation } from "./queries.ts";
import {
  MISS_ALERT_WINDOW_DAYS,
  listMaterializableObligations,
  sweepOccurrences,
} from "./sweep.ts";

/**
 * P16-27 / P16-29 — the match sweep against the real database.
 *
 * [match.test.ts](./match.test.ts) owns the matching CONTRACT; this file owns
 * everything that only a database can demonstrate: that the decisions land, that
 * a second run is a no-op, that a transaction claimed by one occurrence cannot
 * be claimed by another on a later run, and that a terminal row is never
 * re-decided.
 *
 * The last three are the ones that move money. An over-claimed transaction
 * over-subtracts from the residual rate and INFLATES safe-to-spend (ADR-038 §5),
 * which is the direction a household would not think to question.
 */

const TODAY = "2026-04-30";

/** The raw bank descriptor, and the `detection_key` it normalizes to. */
const PAYEE_NAME = "ACME MORTGAGE CO";
const DETECTION_KEY = "acme mortgage co";

async function reset(): Promise<void> {
  await db.execute(
    sql`TRUNCATE obligation_occurrences, scheduled_obligations, transactions, accounts CASCADE`,
  );
}

beforeEach(reset);

async function seedAccount(name = "Checking"): Promise<string> {
  const [account] = await db
    .insert(accounts)
    .values({ name, institution: "M&T", type: "depository", subtype: "checking", currency: "USD" })
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
    source: "detected",
    detectionKey: DETECTION_KEY,
    confidence: "high",
    notes: null,
    ...over,
  });
}

async function seedTransaction(
  accountId: string,
  postedAt: string,
  amount: string,
  name = PAYEE_NAME,
): Promise<string> {
  const [row] = await db
    .insert(transactions)
    .values({
      accountId,
      postedAt,
      amount,
      name,
      // The OFX dedup key; `(account_id, fitid)` is UNIQUE.
      fitid: `${name}-${postedAt}-${amount}`,
      source: "manual",
    })
    .returning({ id: transactions.id });
  if (!row) throw new Error("seed transaction");
  return row.id;
}

async function occurrenceRows(): Promise<
  { id: string; dueDate: string; status: string; matchedTransactionId: string | null }[]
> {
  return db
    .select({
      id: obligationOccurrences.id,
      dueDate: obligationOccurrences.dueDate,
      status: obligationOccurrences.status,
      matchedTransactionId: obligationOccurrences.matchedTransactionId,
    })
    .from(obligationOccurrences)
    .orderBy(asc(obligationOccurrences.dueDate));
}

describe("sweepOccurrences", () => {
  it("does nothing, safely, when there is no calendar at all", async () => {
    await expect(sweepOccurrences({ today: TODAY })).resolves.toMatchObject({
      considered: 0,
      matched: 0,
      missed: 0,
    });
  });

  it("records a match with the transaction and its actual amount", async () => {
    const accountId = await seedAccount();
    const obligationId = await seedObligation({ accountId });
    await materializeOccurrences(
      {
        id: obligationId,
        cadence: "monthly",
        anchorDate: "2026-01-01",
        startDate: "2026-03-01",
        endDate: "2026-03-01",
        expectedAmount: "2150.00",
        active: true,
      },
      "2026-03-01",
    );
    const txnId = await seedTransaction(accountId, "2026-03-01", "-2150.00");

    const result = await sweepOccurrences({ today: TODAY });

    expect(result.matched).toBe(1);
    const [row] = await occurrenceRows();
    expect(row?.status).toBe("matched");
    expect(row?.matchedTransactionId).toBe(txnId);
  });

  it("marks an occurrence missed once its window has closed", async () => {
    const accountId = await seedAccount();
    const obligationId = await seedObligation({ accountId });
    await materializeOccurrences(
      {
        id: obligationId,
        cadence: "monthly",
        anchorDate: "2026-01-01",
        startDate: "2026-03-01",
        endDate: "2026-03-01",
        expectedAmount: "2150.00",
        active: true,
      },
      "2026-03-01",
    );

    const result = await sweepOccurrences({ today: TODAY });

    expect(result.missed).toBe(1);
    expect((await occurrenceRows())[0]?.status).toBe("missed");
  });

  it("leaves an occurrence scheduled while its window is still open", async () => {
    const accountId = await seedAccount();
    const obligationId = await seedObligation({ accountId });
    await materializeOccurrences(
      {
        id: obligationId,
        cadence: "monthly",
        anchorDate: "2026-01-01",
        startDate: TODAY,
        endDate: TODAY,
        expectedAmount: "2150.00",
        active: true,
      },
      TODAY,
    );

    // The anchor is the 1st, so today's window has an occurrence only if one
    // falls inside it; either way nothing may be reported missed on the day.
    const result = await sweepOccurrences({ today: TODAY });
    expect(result.missed).toBe(0);
    for (const row of await occurrenceRows()) {
      expect(row.status).toBe("scheduled");
    }
  });

  it("is a no-op on a second run", async () => {
    const accountId = await seedAccount();
    const obligationId = await seedObligation({ accountId });
    await materializeOccurrences(
      {
        id: obligationId,
        cadence: "monthly",
        anchorDate: "2026-01-01",
        startDate: "2026-01-01",
        endDate: "2026-03-01",
        expectedAmount: "2150.00",
        active: true,
      },
      "2026-03-01",
    );
    await seedTransaction(accountId, "2026-03-01", "-2150.00");

    const first = await sweepOccurrences({ today: TODAY });
    const before = await occurrenceRows();
    const second = await sweepOccurrences({ today: TODAY });

    expect(first.considered).toBeGreaterThan(0);
    // Everything was decided on the first pass; there is nothing left undecided.
    expect(second.considered).toBe(0);
    expect(await occurrenceRows()).toEqual(before);
  });

  it("never lets a second occurrence claim a transaction the first one took", async () => {
    // The double-attribution bug: the same $2,150 subtracted twice from the
    // residual would push the rate toward zero and inflate safe-to-spend.
    const accountId = await seedAccount();
    const first = await seedObligation({ accountId, detectionKey: DETECTION_KEY });
    await materializeOccurrences(
      {
        id: first,
        cadence: "monthly",
        anchorDate: "2026-03-01",
        startDate: "2026-03-01",
        endDate: "2026-03-01",
        expectedAmount: "2150.00",
        active: true,
      },
      "2026-03-01",
    );
    const txnId = await seedTransaction(accountId, "2026-03-01", "-2150.00");
    await sweepOccurrences({ today: TODAY });

    // A second obligation for the very same series is added later and
    // materialized over the same due date.
    const second = await seedObligation({
      accountId,
      label: "Mortgage (duplicate)",
      detectionKey: null,
      source: "manual",
      confidence: null,
    });
    await materializeOccurrences(
      {
        id: second,
        cadence: "monthly",
        anchorDate: "2026-03-01",
        startDate: "2026-03-01",
        endDate: "2026-03-01",
        expectedAmount: "2150.00",
        active: true,
      },
      "2026-03-01",
    );

    await sweepOccurrences({ today: TODAY });

    const claimed = (await occurrenceRows()).filter((row) => row.matchedTransactionId === txnId);
    expect(claimed).toHaveLength(1);
  });

  it("never re-decides an occurrence the user skipped", async () => {
    const accountId = await seedAccount();
    const obligationId = await seedObligation({ accountId });
    await materializeOccurrences(
      {
        id: obligationId,
        cadence: "monthly",
        anchorDate: "2026-03-01",
        startDate: "2026-03-01",
        endDate: "2026-03-01",
        expectedAmount: "2150.00",
        active: true,
      },
      "2026-03-01",
    );
    await db.update(obligationOccurrences).set({ status: "skipped" });
    await seedTransaction(accountId, "2026-03-01", "-2150.00");

    const result = await sweepOccurrences({ today: TODAY });

    expect(result.considered).toBe(0);
    expect((await occurrenceRows())[0]?.status).toBe("skipped");
  });

  it("reports a recent miss as an alert and an ancient one as history", async () => {
    const accountId = await seedAccount();
    const obligationId = await seedObligation({ accountId });
    await materializeOccurrences(
      {
        id: obligationId,
        cadence: "monthly",
        anchorDate: "2026-01-01",
        startDate: "2025-06-01",
        endDate: "2026-04-01",
        expectedAmount: "2150.00",
        active: true,
      },
      "2026-04-01",
    );

    const result = await sweepOccurrences({ today: TODAY });

    // Every past occurrence is truthfully marked missed …
    expect(result.missed).toBeGreaterThan(5);
    // … but a household coming back from an outage is not handed a year of
    // alerts about bills it long since dealt with.
    expect(result.missAlerts.length).toBeLessThan(result.missed);
    for (const alert of result.missAlerts) {
      const ageDays =
        (Date.parse(`${TODAY}T00:00:00Z`) - Date.parse(`${alert.dueDate}T00:00:00Z`)) / 86_400_000;
      expect(ageDays).toBeLessThanOrEqual(MISS_ALERT_WINDOW_DAYS);
    }
  });

  it("carries the delta so the amount-change rule can judge it", async () => {
    const accountId = await seedAccount();
    const obligationId = await seedObligation({ accountId });
    await materializeOccurrences(
      {
        id: obligationId,
        cadence: "monthly",
        anchorDate: "2026-03-01",
        startDate: "2026-03-01",
        endDate: "2026-03-01",
        expectedAmount: "2150.00",
        active: true,
      },
      "2026-03-01",
    );
    await seedTransaction(accountId, "2026-03-01", "-2400.00");

    const result = await sweepOccurrences({ today: TODAY });

    expect(result.amountChanges).toHaveLength(1);
    expect(result.amountChanges[0]).toMatchObject({
      expectedAmount: "2150.00",
      matchedAmount: "-2400.00",
      amountDelta: "250.00",
      amountMode: "fixed",
    });
  });

  it("ignores a transaction from a different account entirely", async () => {
    const billsAccount = await seedAccount("Bills");
    const otherAccount = await seedAccount("Spending");
    const obligationId = await seedObligation({ accountId: billsAccount });
    await materializeOccurrences(
      {
        id: obligationId,
        cadence: "monthly",
        anchorDate: "2026-03-01",
        startDate: "2026-03-01",
        endDate: "2026-03-01",
        expectedAmount: "2150.00",
        active: true,
      },
      "2026-03-01",
    );
    await seedTransaction(otherAccount, "2026-03-01", "-2150.00");

    const result = await sweepOccurrences({ today: TODAY });

    expect(result.matched).toBe(0);
    expect(result.missed).toBe(1);
  });
});

describe("listMaterializableObligations", () => {
  it("returns active obligations in materializer shape", async () => {
    const accountId = await seedAccount();
    await seedObligation({ accountId });

    const rows = await listMaterializableObligations();

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ cadence: "monthly", expectedAmount: "2150.00", active: true });
  });

  it("leaves a stopped obligation out — pausing means the calendar stops growing", async () => {
    const accountId = await seedAccount();
    await seedObligation({ accountId, active: false });

    await expect(listMaterializableObligations()).resolves.toEqual([]);
  });
});
