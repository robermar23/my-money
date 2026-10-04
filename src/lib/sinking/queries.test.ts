// @vitest-environment node
import { db } from "@/db/client.ts";
import {
  accounts,
  obligationOccurrences,
  plannedExpenses,
  scheduledObligations,
} from "@/db/schema/index.ts";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { loadKnownFutureCosts } from "./queries.ts";

/**
 * P18-19 — the loader, against the real database.
 *
 * **This file exists for one assertion**, and it is one no mock can make.
 * `buildCostStream` dates an obligation-sourced cost's accrual window from the
 * PREVIOUS occurrence of the same obligation, *whatever its status* (ADR-045
 * §3) — and the previous occurrence of an annual premium is almost always
 * `matched`, because it was paid a year ago. So the occurrence query must
 * **not** filter `status = 'scheduled'`, however naturally that filter reads
 * next to "the stream admits only scheduled occurrences". With it, `fundingStart`
 * falls back to the horizon start, twelve months of accrual collapse to zero,
 * and the requirement is **silently understated** — the same failure, in the same
 * direction, that P18-11 had to fix in the materializer. PLAN18's own P18-19
 * wording says *"eligible **scheduled** occurrences"*, so this is also the test
 * that catches the plan being read literally.
 *
 * The second test is what makes the first mean something: it shows the figure
 * the wrong query would have produced, so the difference between $900 and $0 is
 * on the screen rather than in an argument.
 */

const TODAY = "2026-10-04";

beforeEach(async () => {
  await db.execute(
    sql`TRUNCATE planned_expenses, obligation_occurrences, scheduled_obligations, accounts CASCADE`,
  );
});

/** An annual premium paid last January, due again this coming January. */
async function seedAnnualPremium(): Promise<void> {
  const [account] = await db
    .insert(accounts)
    .values({ name: "Checking", institution: "M&T", type: "depository", currency: "USD" })
    .returning({ id: accounts.id });
  if (!account) throw new Error("seed account");

  const [obligation] = await db
    .insert(scheduledObligations)
    .values({
      accountId: account.id,
      label: "Car insurance",
      expectedAmount: "1200.00",
      direction: "outflow",
      currency: "USD",
      cadence: "annual",
      anchorDate: "2026-01-04",
      startDate: "2026-01-01",
      source: "manual",
    })
    .returning({ id: scheduledObligations.id });
  if (!obligation) throw new Error("seed obligation");

  await db.insert(obligationOccurrences).values([
    // Last year's premium: PAID, and therefore `matched`. This is the row the
    // accrual window starts at.
    {
      obligationId: obligation.id,
      dueDate: "2026-01-04",
      expectedAmount: "1200.00",
      status: "matched",
    },
    {
      obligationId: obligation.id,
      dueDate: "2027-01-04",
      expectedAmount: "1200.00",
      status: "scheduled",
    },
  ]);
}

describe("loadKnownFutureCosts — the previous occurrence dates the accrual", () => {
  it("funds an annual premium from the matched occurrence a year earlier", async () => {
    await seedAnnualPremium();

    const costs = await loadKnownFutureCosts(TODAY);

    expect(costs).toHaveLength(1);
    expect(costs[0]?.label).toBe("Car insurance");
    expect(costs[0]?.dueDate).toBe("2027-01-04");
    // Twelve months of accrual, because last January's row is visible.
    expect(costs[0]?.fundingStart).toBe("2026-01-04");
  });

  it("would understate the requirement if the matched row were filtered out", async () => {
    await seedAnnualPremium();
    const costs = await loadKnownFutureCosts(TODAY);
    const fundingStart = costs[0]?.fundingStart;

    // The failure this file is for, stated as the difference it makes: with the
    // matched row hidden, `fundingStart` would be today's date, nine months of
    // accrual would vanish, and the page would report a confident, too-small
    // number with nothing anywhere in red.
    expect(fundingStart).not.toBe(TODAY);
    // ISO dates compare correctly as strings, which is why nothing here parses
    // one to order two of them.
    expect(fundingStart === undefined || fundingStart < TODAY).toBe(true);
  });
});

describe("loadKnownFutureCosts — what the queries admit", () => {
  async function seedExpenses(): Promise<void> {
    await db.insert(plannedExpenses).values([
      {
        label: "Dental work",
        amount: "1800.00",
        dueDate: "2027-02-04",
        accrualStartDate: "2026-08-04",
      },
      // Settled: visible on the page with its status, but no longer a cost.
      {
        label: "Last year's braces",
        amount: "4000.00",
        dueDate: "2026-11-01",
        accrualStartDate: "2025-11-01",
        status: "paid",
      },
      // ADR-045 §5's hard edge: thirteen months out, deliberately absent.
      {
        label: "Roof, eventually",
        amount: "9000.00",
        dueDate: "2027-11-04",
        accrualStartDate: "2026-04-04",
      },
      // Overdue and still planned — in scope, in red (ADR-043 §6).
      {
        label: "Vet bill",
        amount: "600.00",
        dueDate: "2026-09-01",
        accrualStartDate: "2026-06-01",
      },
    ]);
  }

  it("takes planned costs inside the horizon, including past-due ones", async () => {
    await seedExpenses();

    const costs = await loadKnownFutureCosts(TODAY);

    expect(costs.map((cost) => cost.label)).toEqual(["Vet bill", "Dental work"]);
    expect(costs.every((cost) => cost.source === "planned_expense")).toBe(true);
    expect(costs.every((cost) => cost.status === "planned")).toBe(true);
  });

  it("excludes a monthly obligation, so nothing is required twice", async () => {
    // ADR-045 §2, the trap of the phase, enforced in SQL by the list the
    // compile-checked record produced. A monthly bill is already inside
    // `essentials.monthly`; requiring a sinking reserve for it would demand a
    // second copy of money the household already budgets every month.
    const [account] = await db
      .insert(accounts)
      .values({ name: "Checking", institution: "M&T", type: "depository", currency: "USD" })
      .returning({ id: accounts.id });
    if (!account) throw new Error("seed account");

    const [rent] = await db
      .insert(scheduledObligations)
      .values({
        accountId: account.id,
        label: "Rent",
        expectedAmount: "2200.00",
        direction: "outflow",
        currency: "USD",
        cadence: "monthly",
        anchorDate: "2026-10-01",
        startDate: "2026-01-01",
        source: "manual",
      })
      .returning({ id: scheduledObligations.id });
    if (!rent) throw new Error("seed rent");

    await db.insert(obligationOccurrences).values({
      obligationId: rent.id,
      dueDate: "2026-11-01",
      expectedAmount: "2200.00",
      status: "scheduled",
    });

    expect(await loadKnownFutureCosts(TODAY)).toEqual([]);
  });

  it("returns both sources in one stream, ordered by due date", async () => {
    await seedAnnualPremium();
    await seedExpenses();

    const costs = await loadKnownFutureCosts(TODAY);

    expect(costs.map((cost) => [cost.source, cost.label])).toEqual([
      ["planned_expense", "Vet bill"],
      ["obligation", "Car insurance"],
      ["planned_expense", "Dental work"],
    ]);
  });

  it("is empty on a household that has recorded nothing", async () => {
    // Not an error path — the normal state of a fresh install, and the one
    // ADR-046 §5 makes a degradation rather than a pass.
    expect(await loadKnownFutureCosts(TODAY)).toEqual([]);
  });
});
