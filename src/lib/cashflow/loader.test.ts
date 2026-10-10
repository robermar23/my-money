// @vitest-environment node
import { db } from "@/db/client.ts";
import {
  accountSnapshots,
  accounts,
  categories,
  householdProfile,
  incomeSources,
  obligationOccurrences,
  plannedExpenses,
  transactions,
} from "@/db/schema/index.ts";
import { Money } from "@/lib/money/money.ts";
import { eq, inArray, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { cashFlowAlerts } from "./alerts.ts";
import { loadCashFlow } from "./loader.ts";
import { materializeOccurrences } from "./materialize.ts";
import { upsertObligation } from "./queries.ts";

/**
 * P16-30 — the cash-flow assembly, against the real database.
 *
 * The pure engine already has its own suites; what only this layer can be wrong
 * about is which rows it feeds them. Four of those choices move the number a
 * family makes a spending decision on, and each gets a test that fails if the
 * choice is reversed:
 *
 *   1. **The residual is a residual** (ADR-038 §2 — the phase's defining rule).
 *      Confirming a bill must not increase the projected outflow, because the
 *      bill was already inside observed spend. Get this wrong and safe-to-spend
 *      is silently, plausibly too low.
 *   2. **Operating cash only** (§6). Savings must not open the walk, or a
 *      checking shortfall hides behind money that is not going to be spent.
 *   3. **An unsnapshotted account is not zero.** It is named as a missing input.
 *   4. **A settled occurrence is not charged again.** A `skipped` bill is not
 *      happening and a `matched` one already posted.
 *   5. **A recorded one-off cost is charged to its day and to the rate NEVER**
 *      (P18-29/P18-30). It must move the low-water mark, and it must leave the
 *      everyday rate and its coverage exactly where they were.
 */

const TODAY = "2026-04-15";
const NOW = new Date(`${TODAY}T09:00:00Z`);

/**
 * Enough history to clear the three-month gate.
 *
 * Deliberately longer than {@link RESIDUAL_WINDOW_DAYS}: the rate window and the
 * honesty gate are different lengths, and a fixture that conflated them would
 * hide the difference. See the note on `RESIDUAL_WINDOW_DAYS`.
 */
const HISTORY_DAYS = 130;

async function reset(): Promise<void> {
  await db.execute(
    sql`TRUNCATE planned_expenses, obligation_occurrences, scheduled_obligations, income_sources, account_snapshots, transactions, categories, household_profile, accounts CASCADE`,
  );
}

beforeEach(reset);

async function seedAccount(name: string, subtype: string, balance: string | null): Promise<string> {
  const [account] = await db
    .insert(accounts)
    .values({ name, institution: "M&T", type: "depository", subtype, currency: "USD" })
    .returning({ id: accounts.id });
  if (!account) throw new Error("seed account");
  if (balance !== null) {
    await db.insert(accountSnapshots).values({ accountId: account.id, date: TODAY, balance });
  }
  return account.id;
}

/** `days` of identical daily spend ending yesterday, all in one expense category. */
async function seedSpend(accountId: string, days: number, perDay: string): Promise<void> {
  const [category] = await db
    .insert(categories)
    .values({ name: "Groceries", kind: "expense" })
    .returning({ id: categories.id });
  const rows = [];
  for (let i = 1; i <= days; i += 1) {
    const day = new Date(Date.parse(`${TODAY}T00:00:00Z`) - i * 86_400_000)
      .toISOString()
      .slice(0, 10);
    rows.push({
      accountId,
      postedAt: day,
      amount: `-${perDay}`,
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
  over: { expectedAmount?: string; startDate?: string; active?: boolean } = {},
): Promise<string> {
  return upsertObligation({
    accountId,
    categoryId: null,
    label: "Mortgage",
    expectedAmount: over.expectedAmount ?? "600.00",
    direction: "outflow",
    currency: "USD",
    cadence: "monthly",
    anchorDate: "2026-01-01",
    startDate: over.startDate ?? "2026-01-01",
    endDate: null,
    active: over.active ?? true,
    amountMode: "fixed",
    source: "manual",
    detectionKey: null,
    liabilityId: null,
    confidence: null,
    notes: null,
  });
}

/** Total projected outflow across the whole horizon. */
function totalOutflow(points: readonly { outflow: string }[]): Money {
  return points.reduce(
    (sum, point) => sum.add(Money.fromString(point.outflow, "USD")),
    Money.zero("USD"),
  );
}

describe("loadCashFlow — the residual is a residual (ADR-038 §2)", () => {
  it("does not increase projected outflow when a bill inside observed spend is confirmed", async () => {
    // The double-count, as an executable assertion. The household spends $40 a
    // day, of which a $600 monthly bill is part. Confirming that bill must move
    // spend from the flat rate onto its due date — not add it on top.
    const accountId = await seedAccount("Checking", "checking", "50000.00");
    await seedSpend(accountId, HISTORY_DAYS, "40.00");
    const before = await loadCashFlow({ today: TODAY, now: NOW });

    const obligationId = await seedObligation(accountId);
    await materializeOccurrences(
      {
        id: obligationId,
        cadence: "monthly",
        anchorDate: "2026-01-01",
        startDate: "2026-01-01",
        endDate: null,
        expectedAmount: "600.00",
        active: true,
      },
      "2026-08-01",
    );
    const after = await loadCashFlow({ today: TODAY, now: NOW });

    const outflowBefore = totalOutflow(before.projection.points);
    const outflowAfter = totalOutflow(after.projection.points);
    // Never MORE. It may legitimately be a little less, because the flat rate
    // truncates down and the dated bill does not.
    expect(outflowAfter.compare(outflowBefore)).toBeLessThanOrEqual(0);
  });

  it("drops the daily rate once bills account for part of observed spend", async () => {
    const accountId = await seedAccount("Checking", "checking", "50000.00");
    await seedSpend(accountId, HISTORY_DAYS, "40.00");
    const before = await loadCashFlow({ today: TODAY, now: NOW });
    const rateBefore = before.projection.points[0]?.events.find(
      (event) => event.kind === "discretionary",
    );

    const obligationId = await seedObligation(accountId);
    await materializeOccurrences(
      {
        id: obligationId,
        cadence: "monthly",
        anchorDate: "2026-01-01",
        startDate: "2026-01-01",
        endDate: null,
        expectedAmount: "600.00",
        active: true,
      },
      "2026-08-01",
    );
    const after = await loadCashFlow({ today: TODAY, now: NOW });
    const rateAfter = after.projection.points[0]?.events.find(
      (event) => event.kind === "discretionary",
    );

    expect(rateBefore).toBeDefined();
    expect(rateAfter).toBeDefined();
    expect(
      Money.fromString(rateAfter?.amount ?? "0", "USD").compare(
        Money.fromString(rateBefore?.amount ?? "0", "USD"),
      ),
    ).toBe(-1);
  });

  it("reports coverage so a thin subtraction is visible rather than buried", async () => {
    const accountId = await seedAccount("Checking", "checking", "50000.00");
    await seedSpend(accountId, HISTORY_DAYS, "40.00");
    const obligationId = await seedObligation(accountId);
    await materializeOccurrences(
      {
        id: obligationId,
        cadence: "monthly",
        anchorDate: "2026-01-01",
        startDate: "2026-01-01",
        endDate: null,
        expectedAmount: "600.00",
        active: true,
      },
      "2026-08-01",
    );

    const snapshot = await loadCashFlow({ today: TODAY, now: NOW });

    expect(snapshot.projection.coverage).not.toBeNull();
    expect(Number.parseFloat(snapshot.projection.coverage ?? "0")).toBeGreaterThan(0);
  });

  it("reports coverage as null — not zero — when there is nothing to attribute", async () => {
    await seedAccount("Checking", "checking", "1000.00");

    const snapshot = await loadCashFlow({ today: TODAY, now: NOW });

    expect(snapshot.projection.coverage).toBeNull();
  });
});

describe("loadCashFlow — operating cash only (ADR-038 §6)", () => {
  it("opens the walk on checking, never on savings", async () => {
    await seedAccount("Checking", "checking", "1000.00");
    await seedAccount("Emergency fund", "savings", "40000.00");

    const snapshot = await loadCashFlow({ today: TODAY, now: NOW });

    expect(snapshot.operating.map((row) => row.name)).toEqual(["Checking"]);
    expect(snapshot.projection.points[0]?.opening).toBe("1000.00");
  });

  it("names an unsnapshotted account instead of counting it as zero", async () => {
    await seedAccount("Checking", "checking", "1000.00");
    await seedAccount("Second checking", "checking", null);

    const snapshot = await loadCashFlow({ today: TODAY, now: NOW });

    expect(snapshot.projection.points[0]?.opening).toBe("1000.00");
    const named = snapshot.projection.inputsUsed.find(
      (input) => input.label === "Accounts with no balance yet",
    );
    expect(named?.value).toContain("Second checking");
    expect(named?.missing).toBe(true);
  });

  it("refuses to project at all with no operating account classified", async () => {
    await seedAccount("Emergency fund", "savings", "40000.00");

    const snapshot = await loadCashFlow({ today: TODAY, now: NOW });

    expect(snapshot.projection.status).toBe("no_operating_account");
    expect(snapshot.projection.inputsUsed.some((input) => input.missing === true)).toBe(true);
  });
});

describe("loadCashFlow — settled occurrences are not charged again", () => {
  it("leaves a skipped occurrence out of the projection", async () => {
    const accountId = await seedAccount("Checking", "checking", "50000.00");
    await seedSpend(accountId, HISTORY_DAYS, "40.00");
    const obligationId = await seedObligation(accountId);
    await materializeOccurrences(
      {
        id: obligationId,
        cadence: "monthly",
        anchorDate: "2026-01-01",
        startDate: "2026-01-01",
        endDate: null,
        expectedAmount: "600.00",
        active: true,
      },
      "2026-08-01",
    );

    const before = await loadCashFlow({ today: TODAY, now: NOW });
    const chargedBefore = before.projection.points.flatMap((point) =>
      point.events.filter((event) => event.kind === "obligation"),
    ).length;

    await db
      .update(obligationOccurrences)
      .set({ status: "skipped" })
      .where(eq(obligationOccurrences.dueDate, "2026-05-01"));
    const after = await loadCashFlow({ today: TODAY, now: NOW });
    const chargedAfter = after.projection.points.flatMap((point) =>
      point.events.filter((event) => event.kind === "obligation"),
    ).length;

    expect(chargedBefore).toBeGreaterThan(0);
    expect(chargedAfter).toBe(chargedBefore - 1);
  });
});

describe("loadCashFlow — what counts as spend a bill already explains (ADR-038 §2)", () => {
  /**
   * Attribution decides whether the residual rate is honest, and it turns on
   * occurrence STATUS. The ADR states the rule for two of the four
   * ("attribution uses the occurrence match … unmatched-but-confirmed
   * obligations are excluded at their occurrence `expected_amount`") and the
   * lifecycle in ADR-037 later added two more. These tests pin what the loader
   * actually does for each, so every one of them is a decision on the record
   * rather than a fall-through.
   *
   * The direction of each error is what matters. Attributing MORE than actually
   * posted lowers the rate, lowers projected outflow, and RAISES safe-to-spend —
   * the direction ADR-038 §5 names as the dangerous one. Attributing less
   * understates the figure, which is merely unhelpful.
   *
   * ── The open question, recorded rather than silently decided ──────────────
   * `missed` currently attributes at `expected_amount`, exactly like
   * `scheduled`. That is defensible — a missed mortgage is usually late rather
   * than cancelled, and the money is still owed — but it has a consequence
   * worth stating: the occurrence is not re-dated into the future either, so a
   * missed bill leaves the projection entirely, and safe-to-spend rises by its
   * share of the rate. The alternative (treat `missed` like `skipped`) errs the
   * safe way but would double-charge a bill that DID post under a renamed payee
   * and was only marked missed because matching failed. Either is arguable; the
   * point of this test is that changing it has to be a decision someone makes
   * here, not a line someone edits by accident.
   */

  /**
   * The three occurrences inside the 90-day residual window.
   *
   * January's falls outside it (the window opens 2026-01-16), which is why
   * the arithmetic below is over three bills and not four.
   */
  const IN_WINDOW_OCCURRENCES = ["2026-02-01", "2026-03-01", "2026-04-01"];

  /**
   * Seed a household, force every in-window occurrence to `status`, and report
   * the coverage the loader derives.
   *
   * @param status - The occurrence status to apply.
   * @param matchedAmount - What posted, for the `matched` case.
   * @returns Coverage as the loader reports it.
   */
  async function coverageAt(
    status: "scheduled" | "matched" | "missed" | "skipped",
    matchedAmount: string | null = null,
  ): Promise<string | null> {
    await reset();
    const accountId = await seedAccount("Checking", "checking", "50000.00");
    // `seedSpend` posts through YESTERDAY, so the 90-day window holds 89 days
    // of $40 = $3,560 of observed expense. The bill itself is deliberately NOT
    // seeded as a transaction: attribution has to come from the occurrence,
    // which is the thing under test.
    await seedSpend(accountId, HISTORY_DAYS, "40.00");
    const obligationId = await seedObligation(accountId);
    await materializeOccurrences(
      {
        id: obligationId,
        cadence: "monthly",
        anchorDate: "2026-01-01",
        startDate: "2026-01-01",
        endDate: null,
        expectedAmount: "600.00",
        active: true,
      },
      TODAY,
    );
    await db
      .update(obligationOccurrences)
      .set({ status, matchedAmount })
      .where(inArray(obligationOccurrences.dueDate, IN_WINDOW_OCCURRENCES));

    const snapshot = await loadCashFlow({ today: TODAY, now: NOW });
    return snapshot.projection.coverage;
  }

  it("attributes a confirmed bill whose window is still open, at its expectation", async () => {
    // 3 x $600 = $1,800 against $3,560 of observed spend.
    expect(await coverageAt("scheduled")).toBe("0.5056");
  });

  it("attributes a matched bill at what actually posted, not what was expected", async () => {
    // $750 posted against a $600 expectation: 3 x $750 = $2,250 / $3,560.
    expect(await coverageAt("matched", "-750.00")).toBe("0.6320");
  });

  it("attributes nothing for a bill the household said is not happening", async () => {
    // `skipped` is intent. Subtracting it would remove spend that never
    // occurred from a total that never contained it, and inflate the figure.
    expect(await coverageAt("skipped")).toBe("0.0000");
  });

  it("still attributes a bill the sweep recorded as missed — see the note above", async () => {
    // Identical to `scheduled`. Recorded so the choice is visible: this is the
    // one status where the loader assumes money left the account on evidence
    // that it did not.
    expect(await coverageAt("missed")).toBe("0.5056");
    expect(await coverageAt("missed")).toBe(await coverageAt("scheduled"));
  });
});

describe("loadCashFlow — the honesty ladder (ADR-038 §7)", () => {
  it("says insufficient_history on a household with six weeks of data", async () => {
    const accountId = await seedAccount("Checking", "checking", "1000.00");
    await seedSpend(accountId, 42, "40.00");
    await seedObligation(accountId);

    const snapshot = await loadCashFlow({ today: TODAY, now: NOW });

    expect(snapshot.projection.status).toBe("insufficient_history");
  });

  it("charges no discretionary rate when the history is too thin to rate", async () => {
    // A rate from six weeks of data is a guess wearing a decimal point.
    const accountId = await seedAccount("Checking", "checking", "1000.00");
    await seedSpend(accountId, 42, "40.00");

    const snapshot = await loadCashFlow({ today: TODAY, now: NOW });

    for (const point of snapshot.projection.points) {
      expect(point.events.some((event) => event.kind === "discretionary")).toBe(false);
    }
  });

  it("says run_rate_only when there is history but no confirmed bill", async () => {
    const accountId = await seedAccount("Checking", "checking", "1000.00");
    await seedSpend(accountId, HISTORY_DAYS, "40.00");

    const snapshot = await loadCashFlow({ today: TODAY, now: NOW });

    expect(snapshot.projection.status).toBe("run_rate_only");
  });

  it("says ok once both are present", async () => {
    const accountId = await seedAccount("Checking", "checking", "1000.00");
    await seedSpend(accountId, HISTORY_DAYS, "40.00");
    await seedObligation(accountId);

    const snapshot = await loadCashFlow({ today: TODAY, now: NOW });

    expect(snapshot.projection.status).toBe("ok");
  });

  it("skips the candidate derivation once a bill is confirmed", async () => {
    // The count exists only to drive the run-rate-only fix link, and detection
    // walks two years of transactions. Paying for it on every load would be a
    // cost with no reader.
    const accountId = await seedAccount("Checking", "checking", "1000.00");
    await seedSpend(accountId, HISTORY_DAYS, "40.00");
    await seedObligation(accountId);

    const snapshot = await loadCashFlow({ today: TODAY, now: NOW });

    expect(snapshot.candidateCount).toBe(0);
  });
});

describe("loadCashFlow — inflows come from observed take-home (ADR-038 §3)", () => {
  it("projects deposits that landed, not the gross on the income source", async () => {
    const accountId = await seedAccount("Checking", "checking", "1000.00");
    await seedSpend(accountId, HISTORY_DAYS, "40.00");
    const [incomeCategory] = await db
      .insert(categories)
      .values({ name: "Salary", kind: "income" })
      .returning({ id: categories.id });
    // Two months of a $3,000 monthly deposit — the take-home that ACTUALLY
    // landed, against a $5,000 gross that must never be projected.
    await db.insert(transactions).values([
      {
        accountId,
        postedAt: "2026-03-15",
        amount: "3000.00",
        name: "EMPLOYER PAYROLL",
        fitid: "pay-2026-03-15",
        categoryId: incomeCategory?.id ?? null,
        source: "manual" as const,
      },
      {
        accountId,
        postedAt: "2026-04-15",
        amount: "3000.00",
        name: "EMPLOYER PAYROLL",
        fitid: "pay-2026-04-15",
        categoryId: incomeCategory?.id ?? null,
        source: "manual" as const,
      },
    ]);
    await db.insert(incomeSources).values({
      name: "Employer",
      cadence: "monthly",
      grossPerPeriod: "5000.00",
      currency: "USD",
      anchorDate: "2026-01-15",
      startDate: "2026-01-15",
      active: true,
    });

    const snapshot = await loadCashFlow({ today: TODAY, now: NOW });

    const incomeEvents = snapshot.projection.points.flatMap((point) =>
      point.events.filter((event) => event.kind === "income"),
    );
    expect(incomeEvents.length).toBeGreaterThan(0);
    for (const event of incomeEvents) {
      expect(event.amount).not.toBe("5000.00");
      expect(
        Money.fromString(event.amount, "USD").compare(Money.fromString("5000.00", "USD")),
      ).toBe(-1);
    }
  });

  it("projects no paycheck at all when no deposit has ever been observed", async () => {
    // A "$0.00 paycheck" on the calendar is indistinguishable from a real one
    // that happened to be zero, so the source is skipped and named instead.
    const accountId = await seedAccount("Checking", "checking", "1000.00");
    await seedSpend(accountId, HISTORY_DAYS, "40.00");
    await db.insert(incomeSources).values({
      name: "Employer",
      cadence: "monthly",
      grossPerPeriod: "5000.00",
      currency: "USD",
      anchorDate: "2026-01-15",
      startDate: "2026-01-15",
      active: true,
    });

    const snapshot = await loadCashFlow({ today: TODAY, now: NOW });

    expect(
      snapshot.projection.points.flatMap((point) =>
        point.events.filter((event) => event.kind === "income"),
      ),
    ).toEqual([]);
    const named = snapshot.projection.inputsUsed.find(
      (input) => input.label === "Take-home per month",
    );
    expect(named?.missing).toBe(true);
  });

  it("projects a stated take-home exactly, and shares only the remainder (ADR-049)", async () => {
    // One $3,000 monthly median, two monthly sources. Unstated, each would get
    // $1,500 — the even split that put one figure on every payday. Stating
    // $2,200 for one must land $2,200 on its payday and $800 on the other's.
    const accountId = await seedAccount("Checking", "checking", "1000.00");
    await seedSpend(accountId, HISTORY_DAYS, "40.00");
    const [incomeCategory] = await db
      .insert(categories)
      .values({ name: "Salary", kind: "income" })
      .returning({ id: categories.id });
    await db.insert(transactions).values(
      ["2026-02-15", "2026-03-15", "2026-04-15"].map((postedAt) => ({
        accountId,
        postedAt,
        amount: "3000.00",
        name: "DEPOSIT",
        fitid: `pay-${postedAt}`,
        categoryId: incomeCategory?.id ?? null,
        source: "manual" as const,
      })),
    );
    const base = {
      cadence: "monthly",
      grossPerPeriod: "5000.00",
      currency: "USD",
      startDate: "2026-01-01",
      active: true,
    };
    await db.insert(incomeSources).values([
      { ...base, name: "Stated", anchorDate: "2026-01-20", netPerPeriod: "2200.00" },
      { ...base, name: "Shared", anchorDate: "2026-01-25" },
    ]);

    const snapshot = await loadCashFlow({ today: TODAY, now: NOW });

    const amounts = new Map<string, Set<string>>();
    for (const point of snapshot.projection.points) {
      for (const event of point.events) {
        if (event.kind !== "income") continue;
        const set = amounts.get(event.label) ?? new Set<string>();
        set.add(event.amount);
        amounts.set(event.label, set);
      }
    }
    expect([...(amounts.get("Stated") ?? [])]).toEqual(["2200.00"]);
    expect([...(amounts.get("Shared") ?? [])]).toEqual(["800.00"]);
    const perPaycheck = snapshot.projection.inputsUsed.find(
      (input) => input.label === "Take-home per paycheck",
    );
    expect(perPaycheck?.value).toBe("1 of 2 stated");
    expect(perPaycheck?.missing).toBe(false);
  });
});

describe("loadCashFlow — the horizon and the floor are stated", () => {
  it("honours the household's own horizon", async () => {
    await seedAccount("Checking", "checking", "1000.00");
    await db.insert(householdProfile).values({ projectionHorizonDays: 30 });

    const snapshot = await loadCashFlow({ today: TODAY, now: NOW });

    expect(snapshot.projection.horizonDays).toBe(30);
    expect(snapshot.projection.points).toHaveLength(30);
  });

  it("defaults the floor to zero rather than inventing a cushion", async () => {
    await seedAccount("Checking", "checking", "1000.00");

    const snapshot = await loadCashFlow({ today: TODAY, now: NOW });

    expect(snapshot.projection.cashFloor).toBe("0.00");
  });

  it("subtracts the household's stated floor from safe-to-spend", async () => {
    await seedAccount("Checking", "checking", "1000.00");
    await db.insert(householdProfile).values({ cashFloor: "400.00" });

    const snapshot = await loadCashFlow({ today: TODAY, now: NOW });

    expect(snapshot.projection.safeToSpend.floor).toBe("400.00");
    expect(snapshot.projection.safeToSpend.amount).toBe("600.00");
  });
});

/** One recorded one-off cost. `notes` is deliberately never seeded or read here. */
async function seedPlannedExpense(over: {
  label?: string;
  amount?: string;
  dueDate?: string;
  currency?: string;
  status?: "planned" | "paid" | "cancelled";
}): Promise<void> {
  await db.insert(plannedExpenses).values({
    label: over.label ?? "New roof",
    amount: over.amount ?? "4000.00",
    currency: over.currency ?? "USD",
    dueDate: over.dueDate ?? "2026-05-15",
    accrualStartDate: "2026-01-15",
    status: over.status ?? "planned",
  });
}

/** The day's everyday-spending event amount, or `null` when the rate is zero. */
function dailyRateOn(point: { events: readonly { kind: string; amount: string }[] }):
  | string
  | null {
  return point.events.find((event) => event.kind === "discretionary")?.amount ?? null;
}

describe("loadCashFlow — recorded one-off costs (P18-29)", () => {
  it("charges a cost inside the horizon to its due date", async () => {
    const accountId = await seedAccount("Checking", "checking", "50000.00");
    await seedSpend(accountId, HISTORY_DAYS, "40.00");
    await seedPlannedExpense({ dueDate: "2026-05-15" });

    const snapshot = await loadCashFlow({ today: TODAY, now: NOW });

    const day = snapshot.projection.points.find((point) => point.date === "2026-05-15");
    expect(day?.events).toContainEqual(
      expect.objectContaining({
        kind: "planned_expense",
        amount: "4000.00",
        direction: "outflow",
        label: "New roof",
      }),
    );
  });

  it("moves the low-water mark by the whole cost, which is the point of the phase", async () => {
    // Without the fourth event kind a $4,000 cost forty days out is invisible
    // here, and safe-to-spend overstates by the entire amount — the optimistic
    // direction ADR-038 §3 calls the dangerous one.
    const accountId = await seedAccount("Checking", "checking", "50000.00");
    await seedSpend(accountId, HISTORY_DAYS, "40.00");
    const before = await loadCashFlow({ today: TODAY, now: NOW });

    await seedPlannedExpense({ dueDate: "2026-05-15" });
    const after = await loadCashFlow({ today: TODAY, now: NOW });

    const lowBefore = Money.fromString(before.projection.lowWaterMark?.balance ?? "0.00", "USD");
    const lowAfter = Money.fromString(after.projection.lowWaterMark?.balance ?? "0.00", "USD");
    expect(lowBefore.sub(lowAfter).toString()).toBe("4000.00");
    expect(before.projection.safeToSpend.amount).not.toBe(after.projection.safeToSpend.amount);
  });

  it("leaves a cost dated past the horizon out of the projection entirely", async () => {
    const accountId = await seedAccount("Checking", "checking", "50000.00");
    await seedSpend(accountId, HISTORY_DAYS, "40.00");
    const before = await loadCashFlow({ today: TODAY, now: NOW });

    // Nine months out: inside the sinking fund's twelve-month horizon, well
    // outside the sixty-day projection. `/plan/sinking` is where it is answered.
    await seedPlannedExpense({ dueDate: "2027-01-15" });
    const after = await loadCashFlow({ today: TODAY, now: NOW });

    expect(totalOutflow(after.projection.points).toString()).toBe(
      totalOutflow(before.projection.points).toString(),
    );
  });

  it.each([["paid"], ["cancelled"]] as const)(
    "charges nothing for a %s cost, even one dated inside the horizon",
    async (status) => {
      const accountId = await seedAccount("Checking", "checking", "50000.00");
      await seedSpend(accountId, HISTORY_DAYS, "40.00");
      const before = await loadCashFlow({ today: TODAY, now: NOW });

      await seedPlannedExpense({ dueDate: "2026-05-15", status });
      const after = await loadCashFlow({ today: TODAY, now: NOW });

      expect(totalOutflow(after.projection.points).toString()).toBe(
        totalOutflow(before.projection.points).toString(),
      );
    },
  );

  it("keeps a cost the walk cannot add out of it, and names it rather than dropping it", async () => {
    // No surface writes a second currency today, but the column exists. The
    // event is left out because converting without `fx_rates` is the one thing
    // that must never happen to a money figure (CLAUDE.md §Money) — and it is
    // NAMED, because a silent filter understates outflow.
    const accountId = await seedAccount("Checking", "checking", "50000.00");
    await seedSpend(accountId, HISTORY_DAYS, "40.00");
    const before = await loadCashFlow({ today: TODAY, now: NOW });

    await seedPlannedExpense({ label: "Paris flat", currency: "EUR", dueDate: "2026-05-15" });
    const after = await loadCashFlow({ today: TODAY, now: NOW });

    expect(totalOutflow(after.projection.points).toString()).toBe(
      totalOutflow(before.projection.points).toString(),
    );
    expect(after.projection.inputsUsed).toContainEqual(
      expect.objectContaining({ label: "Costs in another currency", missing: true }),
    );
  });

  it("names an empty cost list as not recorded rather than as zero", async () => {
    const accountId = await seedAccount("Checking", "checking", "50000.00");
    await seedSpend(accountId, HISTORY_DAYS, "40.00");

    const snapshot = await loadCashFlow({ today: TODAY, now: NOW });

    // ADR-046 §5, and the `null` != "0.00" rule the whole advice phase rests on:
    // a household with no rows has not told the app it expects nothing
    // irregular, and a "$0.00" here would read as the projection having checked.
    expect(snapshot.projection.inputsUsed).toContainEqual(
      expect.objectContaining({
        label: "One-off costs you recorded",
        value: null,
        missing: true,
        href: "/plan/sinking",
      }),
    );
  });

  it("states the cost in the audit trail once there is one", async () => {
    const accountId = await seedAccount("Checking", "checking", "50000.00");
    await seedSpend(accountId, HISTORY_DAYS, "40.00");
    await seedPlannedExpense({ dueDate: "2026-05-15" });

    const snapshot = await loadCashFlow({ today: TODAY, now: NOW });

    expect(snapshot.projection.inputsUsed).toContainEqual(
      expect.objectContaining({
        label: "One-off costs you recorded",
        value: "$4,000.00",
        missing: false,
      }),
    );
  });
});

/**
 * P18-30 — the residual-rate interaction, checked rather than assumed.
 *
 * The analogue of ADR-038 §2 for this phase, and the answer is that **nothing
 * is owed**. The residual subtracts what trailing observed spend already
 * contains; a cost dated in the future has not been spent, so there is nothing
 * to subtract. Both directions are wrong and both are asserted here, because
 * the claim "this changed nothing" is only worth as much as a test that would
 * fail if it had:
 *
 *   - subtracting it would understate the everyday rate for a payment that has
 *     not happened, which overstates safe-to-spend on every day of the horizon;
 *   - counting it as attributed would inflate `coverage`, the one figure a
 *     household uses to judge how much of the projection to believe.
 */
describe("loadCashFlow — a recorded cost does not touch the everyday rate (P18-30)", () => {
  it("leaves the daily rate and coverage byte-identical", async () => {
    const accountId = await seedAccount("Checking", "checking", "50000.00");
    await seedSpend(accountId, HISTORY_DAYS, "40.00");
    // A confirmed bill as well, so `coverage` is a real fraction rather than
    // `null` and the assertion below has something to be wrong about.
    const obligationId = await seedObligation(accountId);
    await materializeOccurrences(
      {
        id: obligationId,
        cadence: "monthly",
        anchorDate: "2026-01-01",
        startDate: "2026-01-01",
        endDate: null,
        expectedAmount: "600.00",
        active: true,
      },
      "2026-08-01",
    );
    const before = await loadCashFlow({ today: TODAY, now: NOW });

    // Dated INSIDE the residual window as well as the horizon, which is the
    // only arrangement that could tempt an implementation into subtracting it.
    await seedPlannedExpense({ dueDate: "2026-04-20" });
    const after = await loadCashFlow({ today: TODAY, now: NOW });

    expect(after.projection.coverage).toBe(before.projection.coverage);
    expect(dailyRateOn(after.projection.points[0] ?? { events: [] })).toBe(
      dailyRateOn(before.projection.points[0] ?? { events: [] }),
    );
    // And the audit trail's stated rate with it, since that is the figure a
    // household actually reads.
    const rateInput = (snapshot: typeof before) =>
      snapshot.projection.inputsUsed.find((input) => input.label === "Everyday spending, per day");
    expect(rateInput(after)?.value).toBe(rateInput(before)?.value);
  });

  it("never lets a recorded cost reach an alert, which is content-free by contract", async () => {
    // The projection now carries household free text (`planned_expenses.label`)
    // into the module the daily job reads for alerts. ADR-015 says an alert is
    // content-free, and the job hand-picks four fields rather than passing the
    // points — so this cannot leak. That is worth an assertion precisely
    // because it is structural: the next field someone adds is where it breaks.
    const accountId = await seedAccount("Checking", "checking", "1000.00");
    await seedSpend(accountId, HISTORY_DAYS, "40.00");
    await seedPlannedExpense({ label: "Fertility treatment", dueDate: "2026-05-15" });

    const snapshot = await loadCashFlow({ today: TODAY, now: NOW });
    const detected = cashFlowAlerts({
      shortfall: {
        status: snapshot.projection.status,
        safeToSpend: snapshot.projection.safeToSpend,
        lowWaterMark: snapshot.projection.lowWaterMark,
        horizonDays: snapshot.projection.horizonDays,
        coverage: snapshot.projection.coverage,
        close: snapshot.shortfallClose,
      },
      missed: [],
      amountChanges: [],
    });

    // The shortfall is real — otherwise this test proves nothing.
    expect(detected.map((alert) => alert.type)).toContain("projected_shortfall");
    expect(JSON.stringify(detected)).not.toContain("Fertility");
  });
});
