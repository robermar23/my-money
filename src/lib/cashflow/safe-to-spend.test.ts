// @vitest-environment node
import { describe, expect, it } from "vitest";
import { safeToSpend } from "./safe-to-spend.ts";

/**
 * P16-18 — safe-to-spend (ADR-038 §5).
 *
 * The clamp is the whole point. A negative result is not an allowance of minus
 * two hundred dollars; it is a SHORTFALL, and it has to be reported as one —
 * with its date and its size — rather than rendered as a nonsense figure the UI
 * would have to special-case anyway.
 */

const low = (date: string, balance: string) => ({ lowWaterMark: { date, balance } });

describe("safeToSpend", () => {
  it("is the low-water balance less the household's own floor", () => {
    const result = safeToSpend(low("2026-03-14", "3000.00"), "500.00");

    expect(result).toEqual({
      amount: "2500.00",
      bindingDate: "2026-03-14",
      floor: "500.00",
      clampedAtZero: false,
      shortfall: null,
    });
  });

  it("echoes the floor so the figure is never mistaken for a balance", () => {
    // $2,500 safe-to-spend against a $3,000 balance is only comprehensible
    // alongside the $500 that was held back.
    expect(safeToSpend(low("2026-03-14", "3000.00"), "500.00").floor).toBe("500.00");
  });

  it("clamps at zero and reports the shortfall when the projection dips below the floor", () => {
    const result = safeToSpend(low("2026-03-14", "300.00"), "500.00");

    expect(result.amount).toBe("0.00");
    expect(result.clampedAtZero).toBe(true);
    // The clamp must not destroy the SIZE of the problem: "you are short" and
    // "you are short by $200" are different sentences and the family acts on
    // the second.
    expect(result.shortfall).toBe("200.00");
    expect(result.bindingDate).toBe("2026-03-14");
  });

  it("never returns a negative allowance, even on a projected overdraft", () => {
    const result = safeToSpend(low("2026-03-14", "-1400.00"), "0.00");

    expect(result.amount).toBe("0.00");
    expect(result.clampedAtZero).toBe(true);
    expect(result.shortfall).toBe("1400.00");
  });

  it("distinguishes landing exactly on the floor from falling below it", () => {
    // Exactly at the floor is zero to spend, but it is NOT a shortfall — the
    // household's plan works, with nothing to spare.
    const result = safeToSpend(low("2026-03-14", "500.00"), "500.00");

    expect(result.amount).toBe("0.00");
    expect(result.clampedAtZero).toBe(false);
    expect(result.shortfall).toBeNull();
  });

  it("returns zero with no binding date when the horizon has no days", () => {
    const result = safeToSpend({ lowWaterMark: null }, "500.00");

    expect(result).toEqual({
      amount: "0.00",
      bindingDate: null,
      floor: "500.00",
      clampedAtZero: false,
      shortfall: null,
    });
  });

  it("is penny-exact where a float would drift", () => {
    expect(safeToSpend(low("2026-03-14", "0.30"), "0.10").amount).toBe("0.20");
  });

  it("normalizes the floor it echoes to cents", () => {
    expect(safeToSpend(low("2026-03-14", "3000.00"), "500").floor).toBe("500.00");
  });

  it("refuses a negative floor rather than inventing headroom", () => {
    // A negative floor would ADD to safe-to-spend — an overdraft treated as
    // budget. That is a data error, not a preference.
    expect(() => safeToSpend(low("2026-03-14", "3000.00"), "-500.00")).toThrow(/floor/i);
  });
});
