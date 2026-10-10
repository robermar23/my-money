// @vitest-environment node
import { db } from "@/db/client.ts";
import { plannedExpenses } from "@/db/schema/index.ts";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { loadSinkingFund } from "./loader.ts";
import { sinkingHorizonEnd } from "./requirement.ts";

/**
 * The loader's own claims (P18-22).
 *
 * The arithmetic is proved by the pure suites and the parity with the guidance
 * card is proved by [inputs.test.ts](./inputs.test.ts). What is left for this
 * file is the handful of facts that only exist because the loader assembles two
 * reads, and the one most easily lost to a well-meaning simplification:
 *
 * > **`plannedExpenses` is the FULL list and `requirement.costs` is not.** A
 * > `paid` or `cancelled` row has to stay visible in the manager (ADR-043 §3,
 * > deactivate never delete) while contributing nothing to the figure (ADR-044
 * > §7). Filtering the list to `planned` makes both surfaces agree and quietly
 * > erases the household's record of what it once expected to pay.
 */

const TODAY = "2026-10-04";

async function reset(): Promise<void> {
  await db.execute(
    sql`TRUNCATE planned_expenses, obligation_occurrences, scheduled_obligations, accounts CASCADE`,
  );
}

beforeEach(reset);

/** A cost with an explicit status, so the two lists can be compared. */
async function seed(label: string, status: "planned" | "paid" | "cancelled"): Promise<void> {
  await db.insert(plannedExpenses).values({
    label,
    amount: "1200.00",
    currency: "USD",
    dueDate: "2027-04-04",
    accrualStartDate: "2026-04-04",
    status,
  });
}

describe("loadSinkingFund", () => {
  it("keeps paid and cancelled costs in the list and out of the figure", async () => {
    await seed("New roof", "planned");
    await seed("Wedding", "paid");
    await seed("Loft conversion", "cancelled");

    const snapshot = await loadSinkingFund({ today: TODAY });

    // All three are still the household's record…
    expect(snapshot.plannedExpenses.map((row) => row.label).sort()).toEqual([
      "Loft conversion",
      "New roof",
      "Wedding",
    ]);
    // …and only the one still coming is in the requirement.
    expect(snapshot.requirement.costs.map((cost) => cost.cost.label)).toEqual(["New roof"]);
    expect(snapshot.requirement.costCount).toBe(1);
  });

  it("dates every figure from the reference date it was given", async () => {
    const snapshot = await loadSinkingFund({ today: TODAY });

    expect(snapshot.today).toBe(TODAY);
    expect(snapshot.horizon.from).toBe(TODAY);
    expect(snapshot.horizon.to).toBe(sinkingHorizonEnd(TODAY));
    expect(snapshot.requirement.horizonFrom).toBe(TODAY);
  });

  it("returns a complete snapshot on a blank install rather than throwing", async () => {
    const snapshot = await loadSinkingFund({ today: TODAY });

    expect(snapshot.plannedExpenses).toEqual([]);
    expect(snapshot.requirement.costCount).toBe(0);
    // With no classified spending there is no baseline, so no target — and the
    // status says which of the two degradations it is (ADR-046 §4/§5).
    expect(["no_baseline", "no_costs_recorded"]).toContain(snapshot.status);
    expect(snapshot.inputsUsed.length).toBeGreaterThan(0);
  });

  it("carries the audit trail and a confidence grade, never a bare figure", async () => {
    await seed("New roof", "planned");

    const snapshot = await loadSinkingFund({ today: TODAY });

    // ADR-032 §2: a figure a user cannot trace is a figure they can only
    // disbelieve.
    for (const input of snapshot.inputsUsed) {
      expect(input.label.length).toBeGreaterThan(0);
      expect(input.source.length).toBeGreaterThan(0);
    }
    expect(["low", "medium", "high"]).toContain(snapshot.confidence);
  });

  it("selects notes for the manager, the one place that PII is editable", async () => {
    await db.insert(plannedExpenses).values({
      label: "Dental work",
      amount: "600.00",
      currency: "USD",
      dueDate: "2027-02-04",
      accrualStartDate: TODAY,
      notes: "second opinion first",
    });

    const snapshot = await loadSinkingFund({ today: TODAY });

    expect(snapshot.plannedExpenses[0]?.notes).toBe("second opinion first");
  });
});
