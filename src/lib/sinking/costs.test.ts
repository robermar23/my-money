// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  type CostStreamInput,
  type CostStreamObligation,
  type OccurrenceRow,
  type PlannedExpenseRow,
  buildCostStream,
} from "./costs.ts";

/**
 * P18-12 — `buildCostStream` (ADR-045). Written before the implementation.
 *
 * **The first test in this file is the one that matters.** A monthly obligation
 * must be ABSENT from the stream: it is already inside `essentials.monthly` and
 * inside the trailing spend behind the residual rate, so accruing for it asks
 * the household to hold a second copy of money it budgets every month. On
 * ~$2,700/month of monthly bills a naive stream demands roughly $16,000 and the
 * rule tells a solvent family it is catastrophically behind. That is this
 * phase's ADR-038 §2, and it is asserted here by name as well as by count.
 */

const HORIZON_FROM = "2026-10-04";
const HORIZON_TO = "2027-10-04";

const planned = (overrides: Partial<PlannedExpenseRow> = {}): PlannedExpenseRow => ({
  id: "p0000000-0000-4000-8000-000000000001",
  label: "New roof",
  amount: "6000.00",
  currency: "USD",
  dueDate: "2027-06-01",
  accrualStartDate: "2026-10-04",
  status: "planned",
  categoryId: null,
  ...overrides,
});

const obligation = (overrides: Partial<CostStreamObligation> = {}): CostStreamObligation => ({
  id: "o0000000-0000-4000-8000-000000000001",
  label: "Car insurance",
  currency: "USD",
  cadence: "annual",
  direction: "outflow",
  active: true,
  categoryId: null,
  ...overrides,
});

const occurrence = (overrides: Partial<OccurrenceRow> = {}): OccurrenceRow => ({
  id: "c0000000-0000-4000-8000-000000000001",
  obligationId: "o0000000-0000-4000-8000-000000000001",
  dueDate: "2027-03-01",
  expectedAmount: "1340.00",
  status: "scheduled",
  ...overrides,
});

const input = (overrides: Partial<CostStreamInput> = {}): CostStreamInput => ({
  horizonFrom: HORIZON_FROM,
  horizonTo: HORIZON_TO,
  plannedExpenses: [],
  obligations: [],
  occurrences: [],
  ...overrides,
});

describe("buildCostStream — the double-count gate (ADR-045 §2)", () => {
  it("EXCLUDES a monthly obligation, by name", () => {
    const rent = obligation({ id: "o-rent", label: "Rent", cadence: "monthly" });
    const stream = buildCostStream(
      input({
        obligations: [rent],
        occurrences: [
          occurrence({ id: "c-rent-1", obligationId: "o-rent", dueDate: "2026-11-01" }),
          occurrence({ id: "c-rent-2", obligationId: "o-rent", dueDate: "2026-12-01" }),
        ],
      }),
    );
    // Asserted by name, not only by length: a future widening of the eligible
    // set would keep a length assertion looking honest while this one fails.
    expect(stream.map((cost) => cost.label)).not.toContain("Rent");
    expect(stream).toEqual([]);
  });

  it("EXCLUDES every cadence of monthly or shorter period", () => {
    const cadences = ["weekly", "biweekly", "semimonthly", "monthly"] as const;
    const stream = buildCostStream(
      input({
        obligations: cadences.map((cadence) =>
          obligation({ id: `o-${cadence}`, label: cadence, cadence }),
        ),
        occurrences: cadences.map((cadence) =>
          occurrence({ id: `c-${cadence}`, obligationId: `o-${cadence}` }),
        ),
      }),
    );
    expect(stream).toEqual([]);
  });

  it("INCLUDES quarterly, semiannual and annual", () => {
    const cadences = ["quarterly", "semiannual", "annual"] as const;
    const stream = buildCostStream(
      input({
        obligations: cadences.map((cadence) =>
          obligation({ id: `o-${cadence}`, label: cadence, cadence }),
        ),
        occurrences: cadences.map((cadence, index) =>
          occurrence({
            id: `c-${cadence}`,
            obligationId: `o-${cadence}`,
            dueDate: `2027-0${index + 1}-01`,
          }),
        ),
      }),
    );
    expect(stream.map((cost) => cost.label)).toEqual(["quarterly", "semiannual", "annual"]);
  });
});

describe("buildCostStream — which obligation occurrences are real costs", () => {
  it("EXCLUDES an inflow obligation — money arriving needs no set-aside", () => {
    const stream = buildCostStream(
      input({
        obligations: [obligation({ label: "Annual dividend", direction: "inflow" })],
        occurrences: [occurrence()],
      }),
    );
    expect(stream).toEqual([]);
  });

  it("EXCLUDES an inactive obligation's occurrences", () => {
    const stream = buildCostStream(
      input({ obligations: [obligation({ active: false })], occurrences: [occurrence()] }),
    );
    expect(stream).toEqual([]);
  });

  it("EXCLUDES a matched, missed or skipped occurrence — only `scheduled` accrues", () => {
    for (const status of ["matched", "missed", "skipped"] as const) {
      const stream = buildCostStream(
        input({ obligations: [obligation()], occurrences: [occurrence({ status })] }),
      );
      expect(stream, `status ${status}`).toEqual([]);
    }
  });

  it("EXCLUDES an occurrence whose obligation is not in the input", () => {
    // A join that silently lost its parent row must not become a cost with no
    // label, no currency and no eligibility verdict.
    const stream = buildCostStream(input({ obligations: [], occurrences: [occurrence()] }));
    expect(stream).toEqual([]);
  });

  it("maps an eligible occurrence into the one shape, carrying its own currency", () => {
    const stream = buildCostStream(
      input({
        obligations: [obligation({ currency: "EUR", categoryId: "cat-insurance" })],
        occurrences: [occurrence({ expectedAmount: "1340" })],
      }),
    );
    expect(stream).toHaveLength(1);
    expect(stream[0]).toMatchObject({
      source: "obligation",
      sourceId: "c0000000-0000-4000-8000-000000000001",
      label: "Car insurance",
      // Normalized through Money, so a hand-written "1340" and a Postgres
      // "1340.00" produce the same cost.
      amount: "1340.00",
      currency: "EUR",
      dueDate: "2027-03-01",
      status: "planned",
      categoryId: "cat-insurance",
    });
  });
});

describe("buildCostStream — fundingStart for an obligation (ADR-045 §3)", () => {
  it("is the previous occurrence's due date", () => {
    // You accrue for next March's premium across the twelve months since last
    // March's. This is the whole reason annual costs are fundable at all, and it
    // falls out of the calendar with no stored column.
    const stream = buildCostStream(
      input({
        obligations: [obligation()],
        occurrences: [
          occurrence({ id: "c-last", dueDate: "2026-03-01", status: "matched" }),
          occurrence({ id: "c-next", dueDate: "2027-03-01" }),
        ],
      }),
    );
    expect(stream).toHaveLength(1);
    expect(stream[0]?.fundingStart).toBe("2026-03-01");
  });

  it("uses the previous occurrence whatever its status, including a skipped one", () => {
    // The previous occurrence dates the accrual window; it does not have to have
    // been paid for the household to have had the time.
    for (const status of ["matched", "missed", "skipped", "scheduled"] as const) {
      const stream = buildCostStream(
        input({
          obligations: [obligation()],
          occurrences: [
            occurrence({ id: "c-last", dueDate: "2026-09-01", status }),
            occurrence({ id: "c-next", dueDate: "2027-03-01" }),
          ],
        }),
      );
      const next = stream.find((cost) => cost.sourceId === "c-next");
      expect(next?.fundingStart, `status ${status}`).toBe("2026-09-01");
    }
  });

  it("takes the MOST RECENT previous occurrence, not the earliest", () => {
    const stream = buildCostStream(
      input({
        obligations: [obligation({ cadence: "quarterly" })],
        occurrences: [
          occurrence({ id: "c-1", dueDate: "2026-01-01", status: "matched" }),
          occurrence({ id: "c-2", dueDate: "2026-04-01", status: "matched" }),
          occurrence({ id: "c-3", dueDate: "2026-07-01", status: "matched" }),
          occurrence({ id: "c-4", dueDate: "2027-01-01" }),
        ],
      }),
    );
    const next = stream.find((cost) => cost.sourceId === "c-4");
    expect(next?.fundingStart).toBe("2026-07-01");
  });

  it("falls back to the horizon start when there is no previous occurrence", () => {
    // A brand-new annual obligation. The honest answer is "you have had since
    // today", not "you have been behind for a year" — the inference ADR-044 §4
    // deliberately rejects.
    const stream = buildCostStream(
      input({ obligations: [obligation()], occurrences: [occurrence()] }),
    );
    expect(stream[0]?.fundingStart).toBe(HORIZON_FROM);
  });
});

describe("buildCostStream — planned expenses", () => {
  it("maps a planned expense directly, using its stored accrual start", () => {
    const stream = buildCostStream(
      input({
        plannedExpenses: [
          planned({ amount: "6000", accrualStartDate: "2026-06-01", categoryId: "cat-home" }),
        ],
      }),
    );
    expect(stream).toEqual([
      {
        source: "planned_expense",
        sourceId: "p0000000-0000-4000-8000-000000000001",
        label: "New roof",
        amount: "6000.00",
        currency: "USD",
        dueDate: "2027-06-01",
        fundingStart: "2026-06-01",
        status: "planned",
        categoryId: "cat-home",
      },
    ]);
  });

  it("EXCLUDES a paid or cancelled planned expense", () => {
    for (const status of ["paid", "cancelled"] as const) {
      const stream = buildCostStream(input({ plannedExpenses: [planned({ status })] }));
      expect(stream, `status ${status}`).toEqual([]);
    }
  });
});

describe("buildCostStream — the horizon (ADR-045 §5)", () => {
  it("INCLUDES a cost on the last day of the horizon", () => {
    const stream = buildCostStream(input({ plannedExpenses: [planned({ dueDate: HORIZON_TO })] }));
    expect(stream).toHaveLength(1);
  });

  it("EXCLUDES a cost one day past the horizon end", () => {
    // The hard edge ADR-045 §5 accepted and disclosed: a cost thirteen months
    // out contributes nothing today.
    const stream = buildCostStream(
      input({ plannedExpenses: [planned({ dueDate: "2027-10-05" })] }),
    );
    expect(stream).toEqual([]);
  });

  it("applies the same edge to an obligation occurrence", () => {
    const stream = buildCostStream(
      input({
        obligations: [obligation()],
        occurrences: [
          occurrence({ id: "c-in", dueDate: HORIZON_TO }),
          occurrence({ id: "c-out", dueDate: "2027-10-05" }),
        ],
      }),
    );
    expect(stream.map((cost) => cost.sourceId)).toEqual(["c-in"]);
  });

  it("KEEPS a past-due cost, which is the whole point of the pastDue flag", () => {
    // There is no lower bound, and that is a decision rather than an oversight:
    // a still-`planned` cost whose date has passed is not outside the horizon,
    // it is OVERDUE, and ADR-044 §5 requires the full amount for it. Dropping it
    // would understate the requirement — the dangerous direction — and would
    // make `SinkingRequirement.pastDueCount` permanently zero.
    const stream = buildCostStream(
      input({ plannedExpenses: [planned({ dueDate: "2026-09-01" })] }),
    );
    expect(stream.map((cost) => cost.dueDate)).toEqual(["2026-09-01"]);
  });

  it("covers an annual obligation eleven months out (P18-11's acceptance test)", () => {
    // The requirement this phase is most likely to get quietly wrong: if the
    // materializer's lead is not widened for eligible cadences, this row does
    // not exist in the database and the number is too small with nothing red
    // anywhere. See [coverage.ts](./coverage.ts).
    const stream = buildCostStream(
      input({
        obligations: [obligation()],
        occurrences: [occurrence({ dueDate: "2027-09-01", expectedAmount: "1340.00" })],
      }),
    );
    expect(stream).toHaveLength(1);
    expect(stream[0]).toMatchObject({ dueDate: "2027-09-01", amount: "1340.00" });
  });
});

describe("buildCostStream — determinism", () => {
  const rows = {
    plannedExpenses: [
      planned({ id: "p-a", label: "Braces", dueDate: "2027-01-15", amount: "4000.00" }),
      planned({ id: "p-b", label: "Appliance", dueDate: "2027-01-15", amount: "900.00" }),
      planned({ id: "p-c", label: "Wedding gift", dueDate: "2026-12-01", amount: "500.00" }),
    ],
    obligations: [obligation({ id: "o-tax", label: "Property tax", cadence: "semiannual" })],
    occurrences: [
      occurrence({ id: "c-tax-2", obligationId: "o-tax", dueDate: "2027-01-15" }),
      occurrence({ id: "c-tax-1", obligationId: "o-tax", dueDate: "2026-11-15" }),
    ],
  };

  it("sorts by (dueDate, label, sourceId)", () => {
    const stream = buildCostStream(input(rows));
    expect(stream.map((cost) => [cost.dueDate, cost.label])).toEqual([
      ["2026-11-15", "Property tax"],
      ["2026-12-01", "Wedding gift"],
      // Same day: label breaks the tie, so the table never reshuffles between
      // two reads of unchanged data.
      ["2027-01-15", "Appliance"],
      ["2027-01-15", "Braces"],
      ["2027-01-15", "Property tax"],
    ]);
  });

  it("is byte-stable under a shuffled input", () => {
    const shuffled = buildCostStream(
      input({
        plannedExpenses: [
          rows.plannedExpenses[1],
          rows.plannedExpenses[2],
          rows.plannedExpenses[0],
        ].filter((row): row is PlannedExpenseRow => row !== undefined),
        obligations: rows.obligations,
        occurrences: [rows.occurrences[1], rows.occurrences[0]].filter(
          (row): row is OccurrenceRow => row !== undefined,
        ),
      }),
    );
    expect(JSON.stringify(shuffled)).toBe(JSON.stringify(buildCostStream(input(rows))));
  });

  it("does not mutate its input", () => {
    const occurrences = [...rows.occurrences];
    const plannedExpenses = [...rows.plannedExpenses];
    buildCostStream(input({ ...rows, occurrences, plannedExpenses }));
    expect(occurrences.map((row) => row.id)).toEqual(["c-tax-2", "c-tax-1"]);
    expect(plannedExpenses.map((row) => row.id)).toEqual(["p-a", "p-b", "p-c"]);
  });
});
