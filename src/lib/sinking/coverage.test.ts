// @vitest-environment node
import { OBLIGATION_CADENCES } from "@/lib/schedule/cadence.ts";
import { describe, expect, it } from "vitest";
import { SINKING_HORIZON_MONTHS, SINKING_MATERIALIZATION_DAYS_AHEAD } from "./constants.ts";
import { materializationDaysAhead } from "./coverage.ts";

/**
 * P18-11 — occurrence coverage.
 *
 * The number this guards is the one a household never sees go wrong: an annual
 * premium eleven months out that has no occurrence row contributes nothing to
 * the requirement, and the page reports a confident, too-small figure. These
 * cases pin the widened lead at the unit level; the proof that the widened lead
 * actually produces the row lives in [costs.test.ts](./costs.test.ts), which
 * asserts an annual cost eleven months out reaches the stream.
 */

/** The shipped cash-flow default: 60-day horizon + 30-day lead. */
const CASH_FLOW_DAYS_AHEAD = 90;

describe("materializationDaysAhead", () => {
  it("leaves monthly-and-shorter cadences on the cash-flow lead exactly", () => {
    // The whole point of deciding this per cadence: a weekly bill materialized
    // 13 months out is 56 rows nobody reads.
    for (const cadence of ["weekly", "biweekly", "semimonthly", "monthly"] as const) {
      expect(materializationDaysAhead(cadence, CASH_FLOW_DAYS_AHEAD)).toBe(CASH_FLOW_DAYS_AHEAD);
    }
  });

  it("extends the eligible cadences past the twelve-month sinking horizon", () => {
    for (const cadence of ["quarterly", "semiannual", "annual"] as const) {
      expect(materializationDaysAhead(cadence, CASH_FLOW_DAYS_AHEAD)).toBe(
        SINKING_MATERIALIZATION_DAYS_AHEAD,
      );
    }
  });

  it("covers the whole twelve-month horizon with slack for a missed nightly run", () => {
    // 366 days is the longest a 12-month horizon can be. The slack is what keeps
    // the far edge covered between runs rather than exactly on the day.
    expect(SINKING_MATERIALIZATION_DAYS_AHEAD).toBeGreaterThan(366);
    expect(SINKING_HORIZON_MONTHS).toBe(12);
  });

  it("never shortens a horizon the household explicitly widened", () => {
    // A user who set `projection_horizon_days = 365` materializes 395 days
    // ahead for everything, and one who maxed the CHECK at 365 + a widened lead
    // can exceed the sinking constant outright. Returning the constant there
    // would SHRINK the cash-flow calendar and quietly drop bills off the end of
    // the projection — a cash-flow regression caused by a sinking-fund feature.
    // So this is a max, not an assignment: below the constant it extends, above
    // it the caller's figure wins.
    expect(materializationDaysAhead("annual", 395)).toBe(SINKING_MATERIALIZATION_DAYS_AHEAD);
    expect(materializationDaysAhead("annual", 500)).toBe(500);
    expect(materializationDaysAhead("monthly", 500)).toBe(500);
    // And an ineligible cadence is never pulled UP, whatever the caller asked
    // for — the whole reason the decision is per cadence.
    expect(materializationDaysAhead("monthly", 395)).toBe(395);
  });

  it("is total over the cadence vocabulary", () => {
    // No cadence falls through to NaN or undefined — the exhaustive record in
    // cadence.ts is what makes that a compile-time property, and this is the
    // runtime restatement of it.
    for (const cadence of OBLIGATION_CADENCES) {
      const days = materializationDaysAhead(cadence, CASH_FLOW_DAYS_AHEAD);
      expect(Number.isInteger(days)).toBe(true);
      expect(days).toBeGreaterThanOrEqual(CASH_FLOW_DAYS_AHEAD);
    }
  });
});
