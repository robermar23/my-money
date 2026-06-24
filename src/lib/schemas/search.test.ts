import { describe, expect, it } from "vitest";
import { UNCATEGORIZED, transactionFilterSchema } from "./search.ts";

const UUID = "11111111-1111-4111-8111-111111111111";

describe("transactionFilterSchema", () => {
  it("accepts an empty object — all-accounts, page 1, no filters", () => {
    const r = transactionFilterSchema.parse({});
    expect(r).toMatchObject({ page: 1 });
    expect(r.q).toBeUndefined();
    expect(r.accountId).toBeUndefined();
  });

  it("normalizes blank strings to undefined", () => {
    const r = transactionFilterSchema.parse({
      q: "  ",
      from: "",
      minAmount: "",
      categoryId: "",
      accountId: "",
    });
    expect(r.q).toBeUndefined();
    expect(r.from).toBeUndefined();
    expect(r.minAmount).toBeUndefined();
    expect(r.categoryId).toBeUndefined();
    expect(r.accountId).toBeUndefined();
  });

  it("trims the free-text term", () => {
    expect(transactionFilterSchema.parse({ q: "  amazon  " }).q).toBe("amazon");
  });

  it("coerces page and falls back to 1 on garbage", () => {
    expect(transactionFilterSchema.parse({ page: "3" }).page).toBe(3);
    expect(transactionFilterSchema.parse({ page: "nope" }).page).toBe(1);
    expect(transactionFilterSchema.parse({ page: "-2" }).page).toBe(1);
  });

  it("accepts the 'uncategorized' sentinel or a uuid for categoryId", () => {
    expect(transactionFilterSchema.parse({ categoryId: UNCATEGORIZED }).categoryId).toBe(
      UNCATEGORIZED,
    );
    expect(transactionFilterSchema.parse({ categoryId: UUID }).categoryId).toBe(UUID);
  });

  it("rejects a non-uuid, non-sentinel categoryId", () => {
    expect(transactionFilterSchema.safeParse({ categoryId: "food" }).success).toBe(false);
  });

  it("rejects a non-uuid accountId", () => {
    expect(transactionFilterSchema.safeParse({ accountId: "abc" }).success).toBe(false);
  });

  describe("date-range refinement (from ≤ to)", () => {
    it("accepts from ≤ to and equal dates", () => {
      expect(
        transactionFilterSchema.safeParse({ from: "2026-01-01", to: "2026-03-01" }).success,
      ).toBe(true);
      expect(
        transactionFilterSchema.safeParse({ from: "2026-01-01", to: "2026-01-01" }).success,
      ).toBe(true);
    });

    it("rejects from > to", () => {
      const r = transactionFilterSchema.safeParse({ from: "2026-03-01", to: "2026-01-01" });
      expect(r.success).toBe(false);
    });

    it("accepts a single open-ended bound", () => {
      expect(transactionFilterSchema.safeParse({ from: "2026-01-01" }).success).toBe(true);
      expect(transactionFilterSchema.safeParse({ to: "2026-01-01" }).success).toBe(true);
    });
  });

  describe("amount-range refinement (min ≤ max)", () => {
    it("accepts min ≤ max and equal amounts", () => {
      expect(
        transactionFilterSchema.safeParse({ minAmount: "10.00", maxAmount: "100.00" }).success,
      ).toBe(true);
      expect(
        transactionFilterSchema.safeParse({ minAmount: "10.00", maxAmount: "10.00" }).success,
      ).toBe(true);
    });

    it("rejects min > max", () => {
      expect(
        transactionFilterSchema.safeParse({ minAmount: "100.00", maxAmount: "10.00" }).success,
      ).toBe(false);
    });

    it("handles negative amounts (signed range) correctly", () => {
      // -100 ≤ -10 is valid; -10 ≤ -100 is not.
      expect(
        transactionFilterSchema.safeParse({ minAmount: "-100.00", maxAmount: "-10.00" }).success,
      ).toBe(true);
      expect(
        transactionFilterSchema.safeParse({ minAmount: "-10.00", maxAmount: "-100.00" }).success,
      ).toBe(false);
    });

    it("rejects a malformed money string", () => {
      expect(transactionFilterSchema.safeParse({ minAmount: "1.234" }).success).toBe(false);
    });
  });
});
