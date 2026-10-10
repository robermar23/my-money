// @vitest-environment node
import { db } from "@/db/client.ts";
import { accounts, obligationOccurrences, scheduledObligations } from "@/db/schema/index.ts";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

/* Mocks: requireUser (needs cookies) + next/cache. The DB runs for real. */
vi.mock("@/lib/auth/require-user.ts", () => ({
  requireUser: vi.fn(async () => ({
    id: "00000000-0000-0000-0000-000000000001",
    passwordHash: "fake",
    createdAt: new Date(),
    updatedAt: new Date(),
  })),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const { revalidatePath } = await import("next/cache");
const { listPlannedExpenses } = await import("@/lib/sinking/queries.ts");
const { cancelPlannedExpenseAction, markPlannedExpensePaidAction, savePlannedExpenseAction } =
  await import("./actions.ts");

/**
 * P18-25 — the guarantees Zod structurally cannot make.
 *
 * The schemas ([schemas/planned-expense.ts](../../../lib/schemas/planned-expense.ts))
 * already own the field rules and have their own suite. What is tested here is
 * everything that depends on **what is already in the database**:
 *
 *   1. **A status transition happens once.** A double-cancel, a second
 *      mark-paid, and a mark-paid on a cancelled row must not re-stamp a
 *      timestamp or move a row backwards through the ladder. The guard is in the
 *      `UPDATE`'s own WHERE clause, so two tabs cannot race it.
 *   2. **A collision warns, and "record it anyway" writes.** ADR-045 §4: the app
 *      cannot know whether two $400 costs in the same week are one cost entered
 *      twice or a genuine coincidence, so it warns and the household decides.
 *      The warning comes back with **no error and no write** — a `collisions`
 *      result is not a failure — and the same submission with the
 *      acknowledgement set records the row. What must never happen is a silent
 *      drop: a household that saw neither a warning nor a row would believe they
 *      had recorded something they had not.
 *   3. **Status is never taken from the form.** The create and edit schemas have
 *      no `status` field; a hand-crafted POST must not be able to set one, and
 *      `paid_at` / `cancelled_at` must agree with whatever status the row has.
 *   4. **Three surfaces are revalidated**, because all three now read this data.
 */

const TODAY = new Date().toISOString().slice(0, 10);

/** `YYYY-MM-DD`, `days` from today. Positive is future. */
function fromToday(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

async function reset(): Promise<void> {
  await db.execute(
    sql`TRUNCATE planned_expenses, obligation_occurrences, scheduled_obligations, accounts CASCADE`,
  );
}

beforeEach(async () => {
  await reset();
  vi.mocked(revalidatePath).mockClear();
});

/** A valid create payload, overridable per case. */
function form(overrides: Record<string, string> = {}): FormData {
  const data = new FormData();
  const fields: Record<string, string> = {
    label: "New roof",
    amount: "12000.00",
    currency: "USD",
    dueDate: fromToday(300),
    accrualStartDate: TODAY,
    categoryId: "",
    notes: "",
    ...overrides,
  };
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

async function createOne(overrides: Record<string, string> = {}): Promise<string> {
  const result = await savePlannedExpenseAction({}, form(overrides));
  expect(result.error).toBeUndefined();
  const [row] = await listPlannedExpenses();
  expect(row).toBeDefined();
  return row?.id ?? "";
}

describe("savePlannedExpenseAction", () => {
  it("records a cost and starts it as planned", async () => {
    await createOne({ label: "New roof", amount: "12000.00" });

    const rows = await listPlannedExpenses();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.label).toBe("New roof");
    // The money string is stored, not a float round-trip.
    expect(rows[0]?.amount).toBe("12000.00");
    expect(rows[0]?.status).toBe("planned");
  });

  it("defaults the accrual start to today when the field is blank", async () => {
    await createOne({ accrualStartDate: "" });

    // ADR-044 §4: stated, never inferred from `created_at` — and today is the
    // honest default, since you start setting aside when you decide to.
    expect((await listPlannedExpenses())[0]?.accrualStartDate).toBe(TODAY);
  });

  it("revalidates all three surfaces that read this data", async () => {
    await createOne();

    const paths = vi.mocked(revalidatePath).mock.calls.map(([path]) => path);
    expect(paths).toContain("/plan/sinking");
    expect(paths).toContain("/plan");
    expect(paths).toContain("/plan/cashflow");
  });

  it("rejects an invalid amount without writing anything", async () => {
    const result = await savePlannedExpenseAction({}, form({ amount: "nope" }));

    expect(result.error).toBeTruthy();
    expect(await listPlannedExpenses()).toHaveLength(0);
  });

  it("rejects a zero amount — there is nothing to set aside", async () => {
    const result = await savePlannedExpenseAction({}, form({ amount: "0.00" }));

    expect(result.error).toBeTruthy();
    expect(await listPlannedExpenses()).toHaveLength(0);
  });

  it("rejects a past due date on create and keeps the table empty", async () => {
    const result = await savePlannedExpenseAction({}, form({ dueDate: fromToday(-5) }));

    expect(result.error).toBeTruthy();
    expect(await listPlannedExpenses()).toHaveLength(0);
  });

  it("never echoes a raw database message or serialized issue to the user", async () => {
    const result = await savePlannedExpenseAction({}, form({ amount: "-100.00" }));

    expect(result.error).toBeTruthy();
    // A sentence, not a row dump, a constraint name, or a stringified error
    // object (CLAUDE.md §Privacy). The second half of this matters as much as
    // the first: `JSON.stringify(error.issues)` passes a "no SQL words" test
    // while putting machine output in front of a person.
    expect(result.error).not.toMatch(/planned_expenses|numeric|constraint|violates/i);
    expect(result.error).not.toMatch(/[{}[\]]|"code"|"path"/);
    expect(result.error).toMatch(/^[A-Z].*[.a-z]$/);
  });

  it("edits an existing row in place rather than adding a second", async () => {
    const id = await createOne({ label: "New roof", amount: "12000.00" });

    const result = await savePlannedExpenseAction({}, form({ id, amount: "14500.00" }));

    expect(result.error).toBeUndefined();
    const rows = await listPlannedExpenses();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.amount).toBe("14500.00");
  });

  it("allows an edit to a past due date, which create refuses", async () => {
    const id = await createOne();

    // ADR-043 §6: a row that was legal yesterday must not become uneditable
    // today — that is exactly when the household needs to mark it paid or move
    // the date.
    // The accrual start moves back with it: a cost that is now overdue was
    // being set aside for before today, and `accrual_start <= due_date` is a
    // CHECK on the table, not a rule of the edit path.
    const result = await savePlannedExpenseAction(
      {},
      form({ id, dueDate: fromToday(-3), accrualStartDate: fromToday(-40) }),
    );

    expect(result.error).toBeUndefined();
    expect((await listPlannedExpenses())[0]?.dueDate).toBe(fromToday(-3));
  });

  it("rejects an edit to an unknown id without creating one", async () => {
    const result = await savePlannedExpenseAction(
      {},
      form({ id: "00000000-0000-0000-0000-0000000000ff" }),
    );

    expect(result.error).toBeTruthy();
    expect(await listPlannedExpenses()).toHaveLength(0);
  });

  it("leaves a settled row's status alone when the row is edited", async () => {
    const id = await createOne({ label: "New roof" });
    await markPlannedExpensePaidAction(id);

    const result = await savePlannedExpenseAction({}, form({ id, amount: "9000.00" }));

    expect(result.error).toBeUndefined();
    const rows = await listPlannedExpenses();
    // The edit lands…
    expect(rows[0]?.amount).toBe("9000.00");
    // …and does not resurrect the cost into the figure. `status`, `paid_at` and
    // `cancelled_at` belong to the two transitions, never to the edit form.
    expect(rows[0]?.status).toBe("paid");
  });

  it("cannot be made to set a status from the form", async () => {
    await createOne({ status: "paid", paidAt: new Date().toISOString() });

    // The schema has no `status` field, so the extra keys are ignored and the
    // column default stands. `paid_at` would otherwise disagree with it.
    expect((await listPlannedExpenses())[0]?.status).toBe("planned");
  });
});

describe("savePlannedExpenseAction — the collision warning (ADR-045 §4)", () => {
  /** An annual premium with one occurrence, close to `dueDate` and `amount`. */
  async function seedAnnualPremium(dueDate: string, amount: string): Promise<void> {
    const [account] = await db
      .insert(accounts)
      .values({ name: "Checking", institution: "M&T", type: "depository", currency: "USD" })
      .returning({ id: accounts.id });
    if (account === undefined) throw new Error("seed failed");

    const [obligation] = await db
      .insert(scheduledObligations)
      .values({
        accountId: account.id,
        label: "Car insurance",
        expectedAmount: amount,
        direction: "outflow",
        currency: "USD",
        cadence: "annual",
        anchorDate: dueDate,
        startDate: TODAY,
        active: true,
        amountMode: "fixed",
        source: "manual",
      })
      .returning({ id: scheduledObligations.id });
    if (obligation === undefined) throw new Error("seed failed");

    await db.insert(obligationOccurrences).values({
      obligationId: obligation.id,
      dueDate,
      expectedAmount: amount,
      status: "scheduled",
    });
  }

  it("warns instead of writing, naming the obligation to compare against", async () => {
    const due = fromToday(120);
    await seedAnnualPremium(due, "1340.00");

    const result = await savePlannedExpenseAction(
      {},
      form({ label: "Car insurance premium", amount: "1340.00", dueDate: due }),
    );

    // Not an error — nothing is wrong, and the household may well mean it.
    expect(result.error).toBeUndefined();
    expect(result.ok).toBeUndefined();
    expect(result.collisions).toHaveLength(1);
    expect(result.collisions?.[0]?.obligationLabel).toBe("Car insurance");
    expect(result.collisions?.[0]?.dueDate).toBe(due);
    // The warning arrives BEFORE the double count can reach the headline figure.
    expect(await listPlannedExpenses()).toHaveLength(0);
  });

  it("records it anyway when the household acknowledges the warning", async () => {
    const due = fromToday(120);
    await seedAnnualPremium(due, "1340.00");

    const result = await savePlannedExpenseAction(
      {},
      form({
        label: "Car insurance premium",
        amount: "1340.00",
        dueDate: due,
        acknowledgeCollisions: "true",
      }),
    );

    // A warning, not a rule: two $400 costs in the same week is an ordinary
    // month, and only the household knows which case this is (ADR-045 §4).
    expect(result.error).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(await listPlannedExpenses()).toHaveLength(1);
  });

  it("never merges, filters, or adjusts the recorded amount", async () => {
    const due = fromToday(120);
    await seedAnnualPremium(due, "1340.00");

    await savePlannedExpenseAction(
      {},
      form({ amount: "1340.00", dueDate: due, acknowledgeCollisions: "true" }),
    );

    // The row is exactly what was typed. A collision changes no total, ever.
    const rows = await listPlannedExpenses();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.amount).toBe("1340.00");
  });

  it("warns on an edit that moves a cost onto an obligation's date", async () => {
    const due = fromToday(120);
    await seedAnnualPremium(due, "1340.00");
    const id = await createOne({ label: "Car service", amount: "1340.00", dueDate: fromToday(10) });

    const result = await savePlannedExpenseAction(
      {},
      form({ id, amount: "1340.00", dueDate: due }),
    );

    expect(result.collisions).toHaveLength(1);
    // The row is untouched: the edit did not happen.
    expect((await listPlannedExpenses())[0]?.dueDate).toBe(fromToday(10));
  });

  it("returns no collision when the amount is nowhere near", async () => {
    const due = fromToday(120);
    await seedAnnualPremium(due, "1340.00");

    const result = await savePlannedExpenseAction(
      {},
      form({ label: "Dental work", amount: "180.00", dueDate: due }),
    );

    expect(result.error).toBeUndefined();
    expect(result.collisions ?? []).toHaveLength(0);
    expect(await listPlannedExpenses()).toHaveLength(1);
  });

  it("returns no collision when nothing is scheduled near the date", async () => {
    await seedAnnualPremium(fromToday(120), "1340.00");

    const result = await savePlannedExpenseAction(
      {},
      form({ label: "Car insurance premium", amount: "1340.00", dueDate: fromToday(300) }),
    );

    expect(result.error).toBeUndefined();
    expect(result.collisions ?? []).toHaveLength(0);
    expect(await listPlannedExpenses()).toHaveLength(1);
  });
});

describe("markPlannedExpensePaidAction", () => {
  it("stamps paid_at and stops the cost accruing", async () => {
    const id = await createOne();

    const result = await markPlannedExpensePaidAction(id);

    expect(result.error).toBeUndefined();
    expect((await listPlannedExpenses())[0]?.status).toBe("paid");
  });

  it("keeps the row rather than deleting it", async () => {
    const id = await createOne({ label: "New roof" });
    await markPlannedExpensePaidAction(id);

    // CLAUDE.md §Database — the record of what the household expected to pay is
    // the product. It stays visible with its status.
    const rows = await listPlannedExpenses();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.label).toBe("New roof");
  });

  it("is a no-op on a second click and says so", async () => {
    const id = await createOne();
    await markPlannedExpensePaidAction(id);

    const again = await markPlannedExpensePaidAction(id);

    expect(again.error).toBeTruthy();
    expect((await listPlannedExpenses())[0]?.status).toBe("paid");
  });

  it("refuses a row that was already cancelled", async () => {
    const id = await createOne();
    await cancelPlannedExpenseAction(id);

    const result = await markPlannedExpensePaidAction(id);

    expect(result.error).toBeTruthy();
    // Still cancelled: the ladder does not run backwards.
    expect((await listPlannedExpenses())[0]?.status).toBe("cancelled");
  });

  it("rejects an id that is not a uuid without touching the table", async () => {
    await createOne();

    const result = await markPlannedExpensePaidAction("not-a-uuid");

    expect(result.error).toBeTruthy();
    expect((await listPlannedExpenses())[0]?.status).toBe("planned");
  });
});

describe("cancelPlannedExpenseAction", () => {
  it("cancels a planned cost and keeps the row", async () => {
    const id = await createOne({ label: "Wedding" });

    const result = await cancelPlannedExpenseAction(id);

    expect(result.error).toBeUndefined();
    const rows = await listPlannedExpenses();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("cancelled");
  });

  it("is a no-op on a double-cancel", async () => {
    const id = await createOne();
    await cancelPlannedExpenseAction(id);

    const again = await cancelPlannedExpenseAction(id);

    expect(again.error).toBeTruthy();
    expect((await listPlannedExpenses())[0]?.status).toBe("cancelled");
  });

  it("refuses a row that was already paid", async () => {
    const id = await createOne();
    await markPlannedExpensePaidAction(id);

    const result = await cancelPlannedExpenseAction(id);

    expect(result.error).toBeTruthy();
    expect((await listPlannedExpenses())[0]?.status).toBe("paid");
  });

  it("revalidates the three surfaces", async () => {
    const id = await createOne();
    vi.mocked(revalidatePath).mockClear();

    await cancelPlannedExpenseAction(id);

    const paths = vi.mocked(revalidatePath).mock.calls.map(([path]) => path);
    expect(paths).toEqual(expect.arrayContaining(["/plan/sinking", "/plan", "/plan/cashflow"]));
  });

  it("has no delete counterpart to call", async () => {
    const actions = await import("./actions.ts");

    // The absence is the design, so it is asserted rather than left to a reader
    // noticing it is missing (CLAUDE.md §Database).
    expect(Object.keys(actions).filter((name) => /delete|destroy|remove/i.test(name))).toEqual([]);
  });
});
