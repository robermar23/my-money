// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  HORIZON_DAYS_MAX,
  HORIZON_DAYS_MIN,
  cashFlowSettingsSchema,
  confirmCandidateSchema,
  deactivateObligationSchema,
  dismissCandidateSchema,
  obligationSchema,
} from "./cashflow.ts";

/**
 * P16-23 — every refinement, and the message a person reads when it fires.
 *
 * These schemas are the second line of defence: the CHECK constraints in
 * ADR-037 §1 are the authority, and each refinement here exists so a mistyped
 * form returns a sentence instead of a Postgres error. Testing the *message* is
 * therefore the point, not an extra — a refinement that rejects correctly with
 * an unreadable message has not done its job.
 */

const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const CATEGORY = "22222222-2222-4222-8222-222222222222";

function obligationForm(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    accountId: ACCOUNT,
    categoryId: "",
    label: "Mortgage",
    expectedAmount: "2150.00",
    direction: "outflow",
    currency: "usd",
    cadence: "monthly",
    anchorDate: "2026-03-01",
    startDate: "2026-01-01",
    endDate: "",
    amountMode: "fixed",
    notes: "",
    active: "on",
    ...over,
  };
}

describe("obligationSchema", () => {
  it("accepts a well-formed obligation and normalizes it for Drizzle", () => {
    const parsed = obligationSchema.safeParse(obligationForm());

    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data).toMatchObject({
      label: "Mortgage",
      expectedAmount: "2150.00",
      // Blank optional fields become NULL, not "" — the columns are nullable
      // and an empty string is not the same statement as "not set".
      categoryId: null,
      endDate: null,
      notes: null,
      currency: "USD",
      active: true,
    });
  });

  it("reads an absent checkbox as inactive rather than as invalid", () => {
    // An HTML checkbox is ABSENT when unchecked. Treating that as a validation
    // error would make it impossible to deactivate an obligation from the form.
    const parsed = obligationSchema.safeParse(obligationForm({ active: undefined }));

    expect(parsed.success && parsed.data.active).toBe(false);
  });

  it("rejects a blank label", () => {
    const parsed = obligationSchema.safeParse(obligationForm({ label: "   " }));

    expect(parsed.success).toBe(false);
    expect(!parsed.success && parsed.error.issues[0]?.message).toBe("A name is required");
  });

  it("caps the label length", () => {
    const parsed = obligationSchema.safeParse(obligationForm({ label: "x".repeat(121) }));

    expect(parsed.success).toBe(false);
  });

  it("rejects a negative expected amount", () => {
    // Mirrors scheduled_obligations_amount_non_negative_check. The magnitude is
    // unsigned by design; the sign lives in `direction`, and a negative here
    // would flip an outflow into an inflow inside the projection walk.
    const parsed = obligationSchema.safeParse(obligationForm({ expectedAmount: "-2150.00" }));

    expect(parsed.success).toBe(false);
    expect(!parsed.success && parsed.error.issues[0]?.message).toBe("Must be zero or more");
  });

  it("rejects an amount with more than two decimal places", () => {
    // NUMERIC(18,2) cannot hold it; accepting it would silently round.
    const parsed = obligationSchema.safeParse(obligationForm({ expectedAmount: "2150.005" }));

    expect(parsed.success).toBe(false);
  });

  it("rejects an end date before the start date", () => {
    // Mirrors scheduled_obligations_date_order_check.
    const parsed = obligationSchema.safeParse(
      obligationForm({ startDate: "2026-06-01", endDate: "2026-05-31" }),
    );

    expect(parsed.success).toBe(false);
    expect(!parsed.success && parsed.error.issues[0]?.message).toBe(
      "End date must be on or after the start date",
    );
  });

  it("accepts an end date equal to the start date", () => {
    // `>=`, not `>`: a one-off obligation that starts and ends the same day is
    // legal, and the CHECK admits it.
    const parsed = obligationSchema.safeParse(
      obligationForm({ startDate: "2026-06-01", endDate: "2026-06-01" }),
    );

    expect(parsed.success).toBe(true);
  });

  it("accepts an anchor date outside the start/end window", () => {
    // The anchor PHASES the schedule; it is not a bound. Constraining it would
    // reject a legitimate backfill of a bill whose known-real date is later.
    const parsed = obligationSchema.safeParse(
      obligationForm({ anchorDate: "2020-03-01", startDate: "2026-01-01" }),
    );

    expect(parsed.success).toBe(true);
  });

  it("rejects a date that is not YYYY-MM-DD", () => {
    const parsed = obligationSchema.safeParse(obligationForm({ startDate: "03/01/2026" }));

    expect(parsed.success).toBe(false);
    expect(!parsed.success && parsed.error.issues[0]?.message).toBe("Use a YYYY-MM-DD date");
  });

  it("rejects a cadence outside the obligation vocabulary", () => {
    // `daily` is not one of OBLIGATION_CADENCES; the CHECK would reject it too.
    const parsed = obligationSchema.safeParse(obligationForm({ cadence: "daily" }));

    expect(parsed.success).toBe(false);
  });

  it("accepts the cadences obligations added beyond income's four", () => {
    for (const cadence of ["quarterly", "semiannual", "annual"]) {
      expect(obligationSchema.safeParse(obligationForm({ cadence })).success).toBe(true);
    }
  });

  it("rejects an unknown direction or amount mode", () => {
    expect(obligationSchema.safeParse(obligationForm({ direction: "sideways" })).success).toBe(
      false,
    );
    expect(obligationSchema.safeParse(obligationForm({ amountMode: "guess" })).success).toBe(false);
  });

  it("rejects a currency that is not three letters", () => {
    expect(obligationSchema.safeParse(obligationForm({ currency: "dollars" })).success).toBe(false);
  });

  it("keeps a supplied category id", () => {
    const parsed = obligationSchema.safeParse(obligationForm({ categoryId: CATEGORY }));

    expect(parsed.success && parsed.data.categoryId).toBe(CATEGORY);
  });
});

describe("confirmCandidateSchema", () => {
  function confirmForm(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      accountId: ACCOUNT,
      detectionKey: "acme mortgage",
      categoryId: "",
      label: "Mortgage",
      expectedAmount: "2150.00",
      direction: "outflow",
      cadence: "monthly",
      anchorDate: "2026-03-01",
      startDate: "2026-01-01",
      amountMode: "fixed",
      ...over,
    };
  }

  it("accepts a confirmation carrying the user's edits", () => {
    const parsed = confirmCandidateSchema.safeParse(
      confirmForm({ label: "Mortgage (Wells)", expectedAmount: "2175.00" }),
    );

    expect(parsed.success && parsed.data).toMatchObject({
      label: "Mortgage (Wells)",
      expectedAmount: "2175.00",
      detectionKey: "acme mortgage",
    });
  });

  it("has no confidence field at all", () => {
    // Provenance, not preference. A form that could assert it would let a
    // hand-crafted POST create a `source='detected'` obligation the detector
    // never proposed — the action reads it from its own candidate list.
    const parsed = confirmCandidateSchema.safeParse(confirmForm({ confidence: "high" }));

    expect(parsed.success).toBe(true);
    expect(parsed.success && "confidence" in parsed.data).toBe(false);
  });

  it("rejects a missing detection key", () => {
    const parsed = confirmCandidateSchema.safeParse(confirmForm({ detectionKey: "  " }));

    expect(parsed.success).toBe(false);
    expect(!parsed.success && parsed.error.issues[0]?.message).toBe("Missing the detected payee");
  });

  it("applies the same amount and date rules as a manual obligation", () => {
    expect(confirmCandidateSchema.safeParse(confirmForm({ expectedAmount: "-1" })).success).toBe(
      false,
    );
    expect(confirmCandidateSchema.safeParse(confirmForm({ anchorDate: "nope" })).success).toBe(
      false,
    );
  });
});

describe("dismissCandidateSchema", () => {
  it("accepts an indefinite dismissal (blank snooze)", () => {
    const parsed = dismissCandidateSchema.safeParse({
      accountId: ACCOUNT,
      detectionKey: "acme mortgage",
      snoozeDays: "",
    });

    expect(parsed.success).toBe(true);
  });

  it("accepts a snooze in whole days", () => {
    const parsed = dismissCandidateSchema.safeParse({
      accountId: ACCOUNT,
      detectionKey: "acme mortgage",
      snoozeDays: "30",
    });

    expect(parsed.success && parsed.data.snoozeDays).toBe("30");
  });

  it("rejects a zero-day snooze, which would be a no-op wearing a name", () => {
    const parsed = dismissCandidateSchema.safeParse({
      accountId: ACCOUNT,
      detectionKey: "acme mortgage",
      snoozeDays: "0",
    });

    expect(parsed.success).toBe(false);
    expect(!parsed.success && parsed.error.issues[0]?.message).toBe(
      "A snooze must be at least one day",
    );
  });

  it("rejects a fractional or negative snooze", () => {
    for (const snoozeDays of ["1.5", "-7"]) {
      const parsed = dismissCandidateSchema.safeParse({
        accountId: ACCOUNT,
        detectionKey: "acme mortgage",
        snoozeDays,
      });
      expect(parsed.success).toBe(false);
    }
  });
});

describe("deactivateObligationSchema", () => {
  it("requires a real uuid", () => {
    expect(deactivateObligationSchema.safeParse({ id: ACCOUNT }).success).toBe(true);
    expect(deactivateObligationSchema.safeParse({ id: "ob-1" }).success).toBe(false);
  });
});

describe("cashFlowSettingsSchema", () => {
  it("treats both fields as blank-means-default, not blank-means-zero", () => {
    // The distinction is load-bearing: a stored "0.00" floor says "I want no
    // cushion"; blank says "I have not thought about it".
    const parsed = cashFlowSettingsSchema.safeParse({ cashFloor: "", projectionHorizonDays: "" });

    expect(parsed.success && parsed.data).toEqual({ cashFloor: null, projectionHorizonDays: null });
  });

  it("accepts a stated floor and horizon", () => {
    const parsed = cashFlowSettingsSchema.safeParse({
      cashFloor: "500.00",
      projectionHorizonDays: "90",
    });

    expect(parsed.success && parsed.data).toEqual({
      cashFloor: "500.00",
      projectionHorizonDays: "90",
    });
  });

  it("accepts an explicit zero floor", () => {
    const parsed = cashFlowSettingsSchema.safeParse({
      cashFloor: "0.00",
      projectionHorizonDays: "",
    });

    expect(parsed.success && parsed.data.cashFloor).toBe("0.00");
  });

  it("rejects a negative floor", () => {
    // Mirrors household_profile_cash_floor_check. A negative buffer would ADD
    // to safe-to-spend — the one direction that gets a household into trouble.
    const parsed = cashFlowSettingsSchema.safeParse({
      cashFloor: "-100.00",
      projectionHorizonDays: "",
    });

    expect(parsed.success).toBe(false);
    expect(!parsed.success && parsed.error.issues[0]?.message).toBe("Must be zero or more");
  });

  it("rejects a horizon outside 14-365", () => {
    for (const projectionHorizonDays of [
      String(HORIZON_DAYS_MIN - 1),
      String(HORIZON_DAYS_MAX + 1),
    ]) {
      const parsed = cashFlowSettingsSchema.safeParse({ cashFloor: "", projectionHorizonDays });
      expect(parsed.success).toBe(false);
      expect(!parsed.success && parsed.error.issues[0]?.message).toBe(
        `The horizon must be between ${HORIZON_DAYS_MIN} and ${HORIZON_DAYS_MAX} days`,
      );
    }
  });

  it("accepts both ends of the horizon range", () => {
    for (const projectionHorizonDays of [String(HORIZON_DAYS_MIN), String(HORIZON_DAYS_MAX)]) {
      expect(
        cashFlowSettingsSchema.safeParse({ cashFloor: "", projectionHorizonDays }).success,
      ).toBe(true);
    }
  });

  it("rejects a non-integer horizon", () => {
    expect(
      cashFlowSettingsSchema.safeParse({ cashFloor: "", projectionHorizonDays: "60.5" }).success,
    ).toBe(false);
  });
});
