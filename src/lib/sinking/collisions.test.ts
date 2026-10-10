// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  COLLISION_TOLERANCE,
  type CollidableOccurrence,
  type CollisionCandidate,
  detectCollisions,
} from "./collisions.ts";

/**
 * P18-13 — the duplicate-entry warning (ADR-045 §4). Written before the
 * implementation.
 *
 * The same cost entered twice — once as a planned expense, once as an annual
 * obligation — doubles the requirement, and the household cannot tell from the
 * total. ADR-045 §4 handles it by **disclosure, never by merging**: no test here
 * asserts a total changed, because this function changes no total. It produces a
 * sentence the entry form shows beside a "record it anyway" button.
 */

const candidate = (overrides: Partial<CollisionCandidate> = {}): CollisionCandidate => ({
  label: "Car insurance",
  amount: "1340.00",
  currency: "USD",
  dueDate: "2027-03-01",
  ...overrides,
});

const occurrence = (overrides: Partial<CollidableOccurrence> = {}): CollidableOccurrence => ({
  obligationId: "o0000000-0000-4000-8000-000000000001",
  obligationLabel: "Auto insurance",
  cadence: "annual",
  direction: "outflow",
  active: true,
  dueDate: "2027-03-01",
  expectedAmount: "1340.00",
  currency: "USD",
  ...overrides,
});

describe("detectCollisions — the warning it produces", () => {
  it("flags an exact collision, naming the obligation it collides with", () => {
    expect(detectCollisions(candidate(), [occurrence()])).toEqual([
      {
        plannedLabel: "Car insurance",
        obligationId: "o0000000-0000-4000-8000-000000000001",
        // The OBLIGATION's label, not the typed one: the form says "this looks
        // like your Auto insurance", which is the sentence that lets a user
        // recognize their own row. Label similarity is never computed — the
        // brittle string guess ADR-040 §2 rejected.
        obligationLabel: "Auto insurance",
        dueDate: "2027-03-01",
        amount: "1340.00",
      },
    ]);
  });

  it("reports nothing when there is nothing to collide with", () => {
    expect(detectCollisions(candidate(), [])).toEqual([]);
  });
});

describe("detectCollisions — the date tolerance", () => {
  it("flags a collision at the edge of the tolerance, either side", () => {
    expect(COLLISION_TOLERANCE.days).toBe(10);
    for (const dueDate of ["2027-02-19", "2027-03-11"]) {
      expect(detectCollisions(candidate(), [occurrence({ dueDate })]), dueDate).toHaveLength(1);
    }
  });

  it("does NOT flag one day outside it, either side", () => {
    for (const dueDate of ["2027-02-18", "2027-03-12"]) {
      expect(detectCollisions(candidate(), [occurrence({ dueDate })]), dueDate).toEqual([]);
    }
  });

  it("does not flag the same cost a year away", () => {
    // The previous and next occurrences of an annual obligation are both real
    // rows; only the one the user's date actually lands near is a duplicate.
    expect(detectCollisions(candidate(), [occurrence({ dueDate: "2026-03-01" })])).toEqual([]);
  });
});

describe("detectCollisions — the amount tolerance", () => {
  it("flags an amount at the edge of the percentage tolerance", () => {
    expect(COLLISION_TOLERANCE.amountPct).toBe("0.10");
    // 10% of $1,340 is $134.00.
    expect(detectCollisions(candidate({ amount: "1206.00" }), [occurrence()])).toHaveLength(1);
    expect(detectCollisions(candidate({ amount: "1474.00" }), [occurrence()])).toHaveLength(1);
  });

  it("does NOT flag a cent outside it, either side", () => {
    expect(detectCollisions(candidate({ amount: "1205.99" }), [occurrence()])).toEqual([]);
    expect(detectCollisions(candidate({ amount: "1474.01" }), [occurrence()])).toEqual([]);
  });

  it("uses the absolute floor on a small cost, where a percentage is meaningless", () => {
    // 10% of a $40 domain renewal is $4.00, so without the floor a $45 renewal
    // would read as a different cost entirely. The floor is $5.00 — the same
    // argument, and the same figure, as the matcher's `amountAbs`.
    expect(COLLISION_TOLERANCE.amountAbs).toBe("5.00");
    const small = occurrence({ obligationLabel: "Domain renewal", expectedAmount: "40.00" });
    expect(detectCollisions(candidate({ amount: "45.00" }), [small])).toHaveLength(1);
    expect(detectCollisions(candidate({ amount: "45.01" }), [small])).toEqual([]);
  });

  it("compares against the OCCURRENCE's amount, so the tolerance does not drift", () => {
    // A percentage of the typed figure would make the verdict depend on which
    // way the user rounded: $1,340 vs $1,200 would collide read one way and not
    // the other. The schedule's figure is the fixed reference.
    const scheduled = occurrence({ expectedAmount: "1000.00" });
    // 10% of $1,000 is $100: $1,100 is in, and $1,101 is out, whichever side
    // the larger number is on.
    expect(detectCollisions(candidate({ amount: "1100.00" }), [scheduled])).toHaveLength(1);
    expect(detectCollisions(candidate({ amount: "1101.00" }), [scheduled])).toEqual([]);
  });

  it("never compares across currencies", () => {
    // CLAUDE.md §Money: cross-currency arithmetic goes through `fx_rates` at the
    // relevant date. A warning is not worth inventing a rate for, and comparing
    // the raw magnitudes would read €1,340 as the same cost as $1,340.
    expect(detectCollisions(candidate(), [occurrence({ currency: "EUR" })])).toEqual([]);
  });
});

describe("detectCollisions — what is not duplicable (ADR-045 §2/§6)", () => {
  it("never flags a monthly obligation", () => {
    // It is not in the cost stream, so it cannot be double-counted — and a
    // warning that a planned roof "looks like your Rent" would be noise that
    // teaches the user to dismiss the warning that matters. Same gate as the
    // stream's, so the warning and the total agree about what is duplicable.
    const rent = occurrence({ obligationLabel: "Rent", cadence: "monthly" });
    expect(detectCollisions(candidate(), [rent])).toEqual([]);
  });

  it("never flags an inflow or an inactive obligation", () => {
    expect(detectCollisions(candidate(), [occurrence({ direction: "inflow" })])).toEqual([]);
    expect(detectCollisions(candidate(), [occurrence({ active: false })])).toEqual([]);
  });
});

describe("detectCollisions — two costs on one day", () => {
  const sameDay = [
    occurrence({
      obligationId: "o-tax",
      obligationLabel: "Property tax",
      cadence: "semiannual",
      expectedAmount: "1340.00",
    }),
    occurrence({
      obligationId: "o-water",
      obligationLabel: "Water",
      cadence: "quarterly",
      expectedAmount: "210.00",
    }),
  ];

  it("flags only the one the amount actually matches", () => {
    // Two genuinely different costs can fall on one day. Flagging both would
    // tell the user their roof looks like their water bill.
    const found = detectCollisions(candidate(), sameDay);
    expect(found.map((collision) => collision.obligationLabel)).toEqual(["Property tax"]);
  });

  it("reports each colliding obligation exactly once", () => {
    const twins = [
      occurrence({ obligationId: "o-a", obligationLabel: "Premium A" }),
      occurrence({ obligationId: "o-b", obligationLabel: "Premium B" }),
    ];
    const found = detectCollisions(candidate(), twins);
    expect(found.map((collision) => collision.obligationId)).toEqual(["o-a", "o-b"]);
  });

  it("orders collisions by (dueDate, obligationLabel, obligationId)", () => {
    const many = [
      occurrence({ obligationId: "o-z", obligationLabel: "Zebra", dueDate: "2027-03-05" }),
      occurrence({ obligationId: "o-a", obligationLabel: "Alpha", dueDate: "2027-03-05" }),
      occurrence({ obligationId: "o-m", obligationLabel: "Middle", dueDate: "2027-02-25" }),
    ];
    expect(
      detectCollisions(candidate(), many).map((collision) => collision.obligationLabel),
    ).toEqual(["Middle", "Alpha", "Zebra"]);
  });
});

describe("detectCollisions — purity", () => {
  it("does not mutate its input", () => {
    const occurrences = [occurrence({ obligationId: "o-2" }), occurrence({ obligationId: "o-1" })];
    detectCollisions(candidate(), occurrences);
    expect(occurrences.map((row) => row.obligationId)).toEqual(["o-2", "o-1"]);
  });

  it("rejects a date that is not a real calendar date", () => {
    // Inherited from the one shipped `parseIsoDate`; this module writes no date
    // validation of its own.
    expect(() => detectCollisions(candidate({ dueDate: "2027-02-30" }), [occurrence()])).toThrow();
  });

  it("honours an explicitly passed tolerance", () => {
    // Stated numbers, and a parameter precisely so they can be moved when there
    // is a real series to move them against (the matcher's own posture).
    const tight = { days: 0, amountPct: "0", amountAbs: "0" };
    expect(detectCollisions(candidate(), [occurrence()], { tolerance: tight })).toHaveLength(1);
    expect(
      detectCollisions(candidate({ amount: "1340.01" }), [occurrence()], { tolerance: tight }),
    ).toEqual([]);
  });
});
