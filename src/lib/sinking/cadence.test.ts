import { OBLIGATION_CADENCES, type ObligationCadence } from "@/lib/schedule/cadence.ts";
import { describe, expect, it } from "vitest";
import {
  SINKING_ELIGIBLE_CADENCES,
  type SinkingEligibleCadence,
  isSinkingEligible,
} from "./cadence.ts";

/**
 * P18-01 — the cadence gate (ADR-045 §2).
 *
 * These are not "tests that the object literal says what it says". The thing
 * under test is the PROPERTY that makes the requirement correct: every cadence
 * in the shipped vocabulary has an explicit verdict, and the four
 * monthly-or-shorter ones are excluded. A future contributor who widens the set
 * to "include everything, it's more complete" asks a solvent household to hold
 * a second copy of its monthly bills, and that regression fails here.
 */
describe("isSinkingEligible", () => {
  it("gives every cadence in the shipped vocabulary an explicit verdict", () => {
    for (const cadence of OBLIGATION_CADENCES) {
      expect(typeof isSinkingEligible(cadence)).toBe("boolean");
    }
    // The record is exhaustive by construction (`satisfies`), so this count is
    // the runtime half of the same claim: nothing was skipped.
    expect(OBLIGATION_CADENCES).toHaveLength(7);
  });

  it("excludes every cadence of monthly or shorter period", () => {
    // Each of these is already inside `essentials.monthly` AND the residual
    // rate. Accruing for them is the ~$16k double-count of ADR-045 §2.
    expect(isSinkingEligible("weekly")).toBe(false);
    expect(isSinkingEligible("biweekly")).toBe(false);
    expect(isSinkingEligible("semimonthly")).toBe(false);
    expect(isSinkingEligible("monthly")).toBe(false);
  });

  it("includes the three cadences a monthly budget cannot represent", () => {
    expect(isSinkingEligible("quarterly")).toBe(true);
    expect(isSinkingEligible("semiannual")).toBe(true);
    expect(isSinkingEligible("annual")).toBe(true);
  });

  it("excludes the liability-sourced obligations ADR-047 adds", () => {
    // A loan schedule derived from stated terms is `monthly` by construction
    // (ADR-047 §7), so it needs no special case here — but if the cadence gate
    // ever widened, the mortgage would be the largest double-count in the file.
    expect(isSinkingEligible("monthly")).toBe(false);
  });
});

describe("SINKING_ELIGIBLE_CADENCES", () => {
  it("is exactly the eligible members, in vocabulary order", () => {
    expect(SINKING_ELIGIBLE_CADENCES).toEqual(["quarterly", "semiannual", "annual"]);
  });

  it("agrees with the predicate on every member of the vocabulary", () => {
    // The constant is derived from the same record the predicate reads, and
    // this is the assertion that keeps it that way if either is rewritten.
    const fromPredicate = OBLIGATION_CADENCES.filter((cadence) => isSinkingEligible(cadence));
    expect([...SINKING_ELIGIBLE_CADENCES]).toEqual(fromPredicate);
  });
});

describe("the eligibility record cannot be partial", () => {
  it("fails to type-check when a cadence has no verdict", () => {
    // The compile-time half of ADR-045 §2: adding a member to
    // `OBLIGATION_CADENCES` without deciding its eligibility must be a `tsc`
    // error, not a silent default. If this `@ts-expect-error` ever becomes
    // "unused", the Record has stopped being exhaustive and the gate is gone.
    // @ts-expect-error - a partial eligibility map is not a Record<ObligationCadence, boolean>
    const partial: Record<ObligationCadence, boolean> = {
      weekly: false,
      biweekly: false,
      semimonthly: false,
      monthly: false,
      quarterly: true,
      semiannual: true,
    };
    expect(Object.keys(partial)).toHaveLength(6);
  });

  it("narrows the cadence type for a downstream filter", () => {
    const eligible: SinkingEligibleCadence[] = OBLIGATION_CADENCES.filter(
      (cadence): cadence is SinkingEligibleCadence => isSinkingEligible(cadence),
    );
    expect(eligible).toEqual(["quarterly", "semiannual", "annual"]);
  });
});
