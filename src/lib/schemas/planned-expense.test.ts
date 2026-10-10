import { describe, expect, it } from "vitest";
import {
  plannedExpenseCreateSchema,
  plannedExpenseEditSchema,
  plannedExpenseIdSchema,
} from "./planned-expense.ts";

/**
 * P18-04 — the planned-expense boundary (ADR-043 §6, ADR-044 §4).
 *
 * Each case here pairs with a CHECK on `planned_expenses` or with a rule the
 * table deliberately does NOT carry (the entry-only future-date rule). The
 * point of a refinement is the sentence a person reads, so the assertions are
 * on rejection and on the resolved value, not on Zod internals.
 */

/** A date far enough ahead that the suite does not expire. */
const FUTURE_DUE = "2099-03-01";

const today = (): string => new Date().toISOString().slice(0, 10);

const validCreate = (overrides: Record<string, string> = {}) => ({
  label: "New roof",
  amount: "9400.00",
  currency: "usd",
  dueDate: FUTURE_DUE,
  accrualStartDate: "",
  categoryId: "",
  notes: "",
  ...overrides,
});

describe("plannedExpenseCreateSchema", () => {
  it("parses a valid payload and normalizes the optional columns", () => {
    const parsed = plannedExpenseCreateSchema.parse(
      validCreate({ accrualStartDate: "2026-03-01", notes: "  north side  " }),
    );
    expect(parsed).toMatchObject({
      label: "New roof",
      amount: "9400.00",
      // Upper-cased by the schema, the same way the obligation form does it.
      currency: "USD",
      dueDate: FUTURE_DUE,
      accrualStartDate: "2026-03-01",
      // Blank optional columns become NULL, never "".
      categoryId: null,
      notes: "north side",
    });
  });

  it("defaults the accrual start to today when it is omitted", () => {
    // ADR-044 §4: stored and explicit, defaulted at entry — never inferred from
    // `created_at` or from `due_date − 12 months`.
    const fromBlank = plannedExpenseCreateSchema.parse(validCreate());
    expect(fromBlank.accrualStartDate).toBe(today());

    const { accrualStartDate: _omitted, ...withoutField } = validCreate();
    const fromAbsent = plannedExpenseCreateSchema.parse(withoutField);
    expect(fromAbsent.accrualStartDate).toBe(today());
  });

  it("rejects a money amount with more than two decimal places", () => {
    const result = plannedExpenseCreateSchema.safeParse(validCreate({ amount: "12.345" }));
    expect(result.success).toBe(false);
  });

  it("rejects scientific notation", () => {
    // "1e3" is a number JavaScript would happily accept and Postgres would
    // not. The regex is the only thing standing between the two.
    const result = plannedExpenseCreateSchema.safeParse(validCreate({ amount: "1e3" }));
    expect(result.success).toBe(false);
  });

  it("rejects a negative amount", () => {
    const result = plannedExpenseCreateSchema.safeParse(validCreate({ amount: "-100.00" }));
    expect(result.success).toBe(false);
  });

  it("rejects a zero amount, in every spelling", () => {
    // The CHECK allows 0; entry does not. The test is a string test — nothing
    // round-trips through a float to decide whether a cost is free.
    for (const amount of ["0", "0.0", "0.00", "000.00"]) {
      expect(plannedExpenseCreateSchema.safeParse(validCreate({ amount })).success).toBe(false);
    }
  });

  it("rejects an empty label and one over the cap", () => {
    expect(plannedExpenseCreateSchema.safeParse(validCreate({ label: "   " })).success).toBe(false);
    expect(
      plannedExpenseCreateSchema.safeParse(validCreate({ label: "x".repeat(121) })).success,
    ).toBe(false);
  });

  it("rejects notes over the cap", () => {
    const result = plannedExpenseCreateSchema.safeParse(validCreate({ notes: "x".repeat(2001) }));
    expect(result.success).toBe(false);
  });

  it("rejects a date that is not YYYY-MM-DD", () => {
    expect(
      plannedExpenseCreateSchema.safeParse(validCreate({ dueDate: "03/01/2099" })).success,
    ).toBe(false);
    expect(plannedExpenseCreateSchema.safeParse(validCreate({ dueDate: "2099-3-1" })).success).toBe(
      false,
    );
  });

  it("rejects an accrual start after the due date", () => {
    // Mirrors planned_expenses_date_order_check.
    const result = plannedExpenseCreateSchema.safeParse(
      validCreate({ dueDate: "2099-03-01", accrualStartDate: "2099-04-01" }),
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(["accrualStartDate"]);
    }
  });

  it("accepts an accrual start equal to the due date", () => {
    // ADR-044 §3: `totalMonths` floors at 1, so "you need all of it now" is a
    // legal state, not an error.
    const parsed = plannedExpenseCreateSchema.parse(
      validCreate({ dueDate: "2099-03-01", accrualStartDate: "2099-03-01" }),
    );
    expect(parsed.accrualStartDate).toBe("2099-03-01");
  });

  it("rejects a due date in the past on create", () => {
    const result = plannedExpenseCreateSchema.safeParse(
      validCreate({ dueDate: "2000-01-01", accrualStartDate: "1999-01-01" }),
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path[0] === "dueDate")).toBe(true);
    }
  });

  it("accepts a due date of today on create", () => {
    // Future-OR-TODAY. A cost landing this afternoon is a real entry.
    const parsed = plannedExpenseCreateSchema.parse(validCreate({ dueDate: today() }));
    expect(parsed.dueDate).toBe(today());
  });

  it("rejects a category id that is not a uuid", () => {
    const result = plannedExpenseCreateSchema.safeParse(validCreate({ categoryId: "groceries" }));
    expect(result.success).toBe(false);
  });
});

describe("plannedExpenseEditSchema", () => {
  const validEdit = (overrides: Record<string, string> = {}) => ({
    ...validCreate(overrides),
    id: "11111111-1111-4111-8111-111111111111",
  });

  it("accepts a past due date, so a row does not become uneditable", () => {
    // ADR-043 §6 — the one rule that differs from create. Time passes; a row
    // that was legal yesterday must not become illegal today.
    const parsed = plannedExpenseEditSchema.parse(
      validEdit({ dueDate: "2000-01-01", accrualStartDate: "1999-01-01" }),
    );
    expect(parsed.dueDate).toBe("2000-01-01");
  });

  it("still enforces the date order", () => {
    const result = plannedExpenseEditSchema.safeParse(
      validEdit({ dueDate: "2000-01-01", accrualStartDate: "2000-06-01" }),
    );
    expect(result.success).toBe(false);
  });

  it("still enforces the amount rules", () => {
    expect(plannedExpenseEditSchema.safeParse(validEdit({ amount: "0.00" })).success).toBe(false);
    expect(plannedExpenseEditSchema.safeParse(validEdit({ amount: "-1.00" })).success).toBe(false);
  });

  it("requires a row id", () => {
    const { id: _dropped, ...withoutId } = validEdit();
    expect(plannedExpenseEditSchema.safeParse(withoutId).success).toBe(false);
  });

  it("carries no status field", () => {
    // A status the form could assert is a status `paid_at`/`cancelled_at` would
    // not follow. The transitions are their own actions.
    const parsed = plannedExpenseEditSchema.parse({ ...validEdit(), status: "paid" });
    expect("status" in parsed).toBe(false);
  });

  it("carries no funding field", () => {
    // §Domain Scope: there is no `funded_amount` column, so there is no input
    // for one. A field that cannot be stored is a feature someone later
    // "finishes".
    const parsed = plannedExpenseEditSchema.parse({ ...validEdit(), fundedAmount: "500.00" });
    expect("fundedAmount" in parsed).toBe(false);
  });
});

describe("plannedExpenseIdSchema", () => {
  it("takes an id and nothing else", () => {
    const parsed = plannedExpenseIdSchema.parse({
      id: "11111111-1111-4111-8111-111111111111",
      status: "cancelled",
    });
    expect(parsed).toEqual({ id: "11111111-1111-4111-8111-111111111111" });
  });

  it("rejects a non-uuid id", () => {
    expect(plannedExpenseIdSchema.safeParse({ id: "42" }).success).toBe(false);
  });
});
