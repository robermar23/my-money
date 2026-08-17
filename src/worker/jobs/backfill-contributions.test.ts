// @vitest-environment node
import { db } from "@/db/client.ts";
import {
  accounts,
  holdingLots,
  holdings,
  incomeContributions,
  incomeSources,
  prices,
  retirementContributions,
} from "@/db/schema/index.ts";
import { aggregateLots } from "@/lib/investments/lots.ts";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { backfillContributionsProcessor } from "./backfill-contributions.ts";
import { materializeContributions } from "./materialize-contributions.ts";

/**
 * P14-11 — the run-once historical backfill.
 *
 * What matters here is not the per-contribution shape (pinned by the
 * materialize job's tests) but the aggregate: does walking two years of a
 * paycheck produce the right NUMBER of contributions and the right TOTAL cost
 * basis, and does it stay idempotent at that scale? A backfill that silently
 * dropped or duplicated a pay date would put a wrong basis on the 401k forever.
 */

/** Anchored so the biweekly schedule is exactly known across the window. */
const START = "2024-01-05";
const NOW = () => new Date("2026-01-01T09:00:00Z");

async function reset(): Promise<void> {
  await db.execute(
    sql`TRUNCATE income_contributions, retirement_contributions, income_sources,
        investment_transactions, holding_lots, holdings, accounts, prices CASCADE`,
  );
}

/** A biweekly $3,000 paycheck contributing 6% + a 3% match → $270 a period. */
async function seedTwoYearPaycheck(
  sourceOverrides: Partial<typeof incomeSources.$inferInsert> = {},
): Promise<{ holdingId: string }> {
  const [a] = await db
    .insert(accounts)
    .values({ name: "401k", institution: "Fidelity", type: "investment", currency: "USD" })
    .returning({ id: accounts.id });
  if (!a) throw new Error("seed account failed");

  const [h] = await db
    .insert(holdings)
    .values({
      accountId: a.id,
      symbol: "FXAIX",
      quantity: "0",
      quantityUnit: "shares",
      assetClass: "equity",
    })
    .returning({ id: holdings.id });
  if (!h) throw new Error("seed holding failed");

  const [s] = await db
    .insert(incomeSources)
    .values({
      name: "Acme Corp",
      cadence: "biweekly",
      grossPerPeriod: "3000.00",
      anchorDate: START,
      startDate: START,
      ...sourceOverrides,
    })
    .returning({ id: incomeSources.id });
  if (!s) throw new Error("seed source failed");

  await db.insert(retirementContributions).values({
    incomeSourceId: s.id,
    accountId: a.id,
    holdingId: h.id,
    employeeBasis: "percent",
    employeeValue: "6",
    matchBasis: "percent_of_gross",
    matchValue: "3",
  });

  return { holdingId: h.id };
}

describe("backfillContributions", () => {
  beforeEach(reset);
  afterAll(reset);

  it("materializes every historical pay date from the source's start", async () => {
    const { holdingId } = await seedTwoYearPaycheck();

    const result = await backfillContributionsProcessor(undefined, { now: NOW });

    // 2024-01-05 → 2025-12-19 inclusive, every 14 days.
    expect(result.created).toBe(52);
    const rows = await db.select().from(incomeContributions);
    expect(rows).toHaveLength(52);
    expect(rows.map((r) => r.payDate).sort()[0]).toBe(START);

    // 52 × $270 — the number the 401k's cost basis must equal.
    const lots = await db.select().from(holdingLots).where(eq(holdingLots.holdingId, holdingId));
    expect(aggregateLots(lots, "USD").totalCostBasis.toString()).toBe("14040.00");
  });

  it("is idempotent across a full re-run", async () => {
    await seedTwoYearPaycheck();

    await backfillContributionsProcessor(undefined, { now: NOW });
    const second = await backfillContributionsProcessor(undefined, { now: NOW });

    expect(second.created).toBe(0);
    expect(await db.select().from(incomeContributions)).toHaveLength(52);
    expect(await db.select().from(holdingLots)).toHaveLength(52);
  });

  it("degrades per pay date across the start of price history", async () => {
    // The honest case (ADR-031 §3): a backfill that predates our prices records
    // dollars only for the early years and buys real shares once history begins.
    await seedTwoYearPaycheck();
    await db.insert(prices).values({ symbol: "FXAIX", date: "2025-01-01", close: "100.00" });

    const result = await backfillContributionsProcessor(undefined, { now: NOW });

    expect(result.created).toBe(52);
    expect(result.basisOnly).toBe(26); // 2024 — before any close exists
    expect(result.priceable).toBe(26); // 2025 — priced off the 2025-01-01 close

    // Basis is identical either way; only the share count differs.
    const lots = await db.select().from(holdingLots);
    expect(aggregateLots(lots, "USD").totalCostBasis.toString()).toBe("14040.00");
    const zeroQty = lots.filter((l) => Number(l.quantity) === 0);
    expect(zeroQty).toHaveLength(26);
  });

  it("reconstructs a retired paycheck that has been paused", async () => {
    // The reported bug. ADR-030 prescribes end-dating the old source and
    // starting a new one at a job change, and the user pauses the old one — but
    // `active` only ever meant "keep creating contributions going forward".
    // Skipping the paused source left two years of real cost basis off the 401k
    // and cratered the savings rate, with nothing anywhere reporting a problem.
    await seedTwoYearPaycheck({ active: false, endDate: "2025-12-31" });

    const result = await backfillContributionsProcessor(undefined, { now: NOW });

    expect(result.created).toBe(52);
    expect(await db.select().from(incomeContributions)).toHaveLength(52);
  });

  it("honours end_date rather than active when bounding a paused source", async () => {
    // The safety half of the above: including paused sources must not let a
    // finished paycheck leak contributions into the present. `end_date` is what
    // stops it, and it still does.
    await seedTwoYearPaycheck({ active: false, endDate: "2024-12-31" });

    await backfillContributionsProcessor(undefined, { now: NOW });

    const payDates = (await db.select().from(incomeContributions)).map((r) => r.payDate).sort();
    expect(payDates).toHaveLength(26); // 2024 only
    // ISO dates sort lexicographically, so the last one is the latest.
    expect(payDates.at(-1) ?? "").toBe("2024-12-20");
  });

  it("leaves paused sources alone on a nightly run", async () => {
    // `includeInactive` belongs to the backfill only. If the nightly job picked
    // up paused sources it would keep growing a paycheck the user explicitly
    // stopped — the opposite bug.
    await seedTwoYearPaycheck({ active: false });

    const result = await materializeContributions({ from: "2024-01-01", now: NOW });

    expect(result.created).toBe(0);
  });
});
