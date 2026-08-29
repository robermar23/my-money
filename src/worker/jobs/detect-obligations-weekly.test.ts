// @vitest-environment node
import { db } from "@/db/client.ts";
import { accounts, scheduledObligations, transactions } from "@/db/schema/index.ts";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { detectObligationsWeeklyProcessor } from "./detect-obligations-weekly.ts";

/**
 * P16-26 — the weekly detector, and the guarantee it exists to keep.
 *
 * The headline assertion is a NEGATIVE one: after a run that finds a textbook
 * recurring series, `scheduled_obligations` is still empty. That is ADR-036 §2
 * — detection proposes, the user disposes — expressed as a test rather than as a
 * comment, because a comment cannot fail. It is also the reason the plan's
 * "persist candidates only" reads as "persist ONLY candidates": there is
 * nothing else this job is allowed to write.
 *
 * The fixture is built relative to the real clock, because the job reads its own
 * `today` from the injected `now` and the detector needs a series that looks
 * current rather than abandoned.
 */

const NOW = new Date("2026-04-30T09:00:00Z");

async function reset(): Promise<void> {
  await db.execute(
    sql`TRUNCATE obligation_occurrences, scheduled_obligations, transactions, accounts CASCADE`,
  );
}

beforeEach(reset);

/** A monthly mortgage, nine months of it — enough to corroborate a cadence. */
async function seedMonthlySeries(): Promise<string> {
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

  const rows = [];
  for (let i = 9; i >= 1; i -= 1) {
    const due = new Date(Date.UTC(2026, 3 - i + 1, 1)).toISOString().slice(0, 10);
    rows.push({
      accountId: account.id,
      postedAt: due,
      amount: "-2150.00",
      name: "ACME MORTGAGE CO",
      fitid: `mortgage-${due}`,
      source: "manual" as const,
    });
  }
  await db.insert(transactions).values(rows);
  return account.id;
}

async function obligationCount(): Promise<number> {
  const rows = await db.select({ id: scheduledObligations.id }).from(scheduledObligations);
  return rows.length;
}

describe("detectObligationsWeeklyProcessor", () => {
  it("writes no obligation, however confident the detector is (ADR-036 §2)", async () => {
    await seedMonthlySeries();

    const result = await detectObligationsWeeklyProcessor(undefined, { now: () => NOW });

    // Non-vacuity: the fixture really does produce a proposal, so the zero
    // below is a decision the job made rather than an empty database.
    expect(result.candidates).toBeGreaterThan(0);
    expect(await obligationCount()).toBe(0);
  });

  it("reports how many of the proposals are strong", async () => {
    await seedMonthlySeries();

    const result = await detectObligationsWeeklyProcessor(undefined, { now: () => NOW });

    expect(result.highConfidence).toBeGreaterThan(0);
    expect(result.highConfidence).toBeLessThanOrEqual(result.candidates);
  });

  it("returns zero on an install with no transactions at all", async () => {
    await expect(detectObligationsWeeklyProcessor(undefined, { now: () => NOW })).resolves.toEqual({
      candidates: 0,
      highConfidence: 0,
    });
  });

  it("counts what the review page counts, by running the same code path", async () => {
    // Not a tautology: the job takes `loadCandidates` as its default, so this
    // asserts it has not been quietly swapped for a second derivation that
    // could disagree with the page.
    await seedMonthlySeries();
    const { loadCandidates } = await import("@/lib/cashflow/candidate-loader.ts");

    const [job, page] = await Promise.all([
      detectObligationsWeeklyProcessor(undefined, { now: () => NOW }),
      loadCandidates({ today: NOW.toISOString().slice(0, 10), now: NOW }),
    ]);

    expect(job.candidates).toBe(page.length);
  });

  it("is a no-op on a second run — it has nothing to be idempotent about", async () => {
    await seedMonthlySeries();

    const first = await detectObligationsWeeklyProcessor(undefined, { now: () => NOW });
    const second = await detectObligationsWeeklyProcessor(undefined, { now: () => NOW });

    expect(second).toEqual(first);
    expect(await obligationCount()).toBe(0);
  });
});
