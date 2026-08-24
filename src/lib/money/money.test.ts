import { describe, expect, it } from "vitest";
import { Money } from "./money.ts";

describe("Money", () => {
  describe("construction + roundtrip", () => {
    it("preserves a value through string roundtrip", () => {
      const m = Money.fromString("1234.56", "USD");
      expect(m.toString()).toBe("1234.56");
      expect(m.currency).toBe("USD");
    });

    it("normalizes whole-number strings to cents precision", () => {
      const m = Money.fromString("100", "USD");
      expect(m.toString()).toBe("100.00");
    });

    it("accepts negative values", () => {
      const m = Money.fromString("-50.25", "USD");
      expect(m.toString()).toBe("-50.25");
      expect(m.isNegative()).toBe(true);
    });

    it("rejects invalid strings", () => {
      expect(() => Money.fromString("not-a-number", "USD")).toThrow();
      expect(() => Money.fromString("", "USD")).toThrow();
    });

    it("requires a non-empty currency code", () => {
      expect(() => Money.fromString("10", "")).toThrow();
    });
  });

  describe("arithmetic — the float-precision pitfalls", () => {
    it("0.1 + 0.2 equals exactly 0.3 (the canonical IEEE-754 trap)", () => {
      const a = Money.fromString("0.10", "USD");
      const b = Money.fromString("0.20", "USD");
      const sum = a.add(b);
      expect(sum.toString()).toBe("0.30");
    });

    it("subtracts without introducing float noise", () => {
      const a = Money.fromString("1.00", "USD");
      const b = Money.fromString("0.90", "USD");
      expect(a.sub(b).toString()).toBe("0.10");
    });

    it("multiplies by a scalar exactly", () => {
      const m = Money.fromString("0.10", "USD");
      // 0.1 * 3 in IEEE-754 = 0.30000000000000004
      expect(m.mul("3").toString()).toBe("0.30");
    });

    it("divides with banker's rounding to scale 2 by default", () => {
      const m = Money.fromString("10.00", "USD");
      // 10 / 3 = 3.3333...; truncate/round to 2 decimal places for money.
      expect(m.div("3").toString()).toBe("3.33");
    });
  });

  describe("currency safety", () => {
    it("refuses to add Money with mismatched currencies", () => {
      const usd = Money.fromString("10", "USD");
      const eur = Money.fromString("10", "EUR");
      expect(() => usd.add(eur)).toThrow(/currency/i);
    });

    it("refuses to subtract mismatched currencies", () => {
      const usd = Money.fromString("10", "USD");
      const eur = Money.fromString("10", "EUR");
      expect(() => usd.sub(eur)).toThrow(/currency/i);
    });
  });

  describe("comparison", () => {
    it("equals: exact value + currency", () => {
      expect(Money.fromString("1.00", "USD").equals(Money.fromString("1.00", "USD"))).toBe(true);
      expect(Money.fromString("1.00", "USD").equals(Money.fromString("1.0", "USD"))).toBe(true);
      expect(Money.fromString("1.00", "USD").equals(Money.fromString("1.00", "EUR"))).toBe(false);
    });

    it("isZero / isNegative", () => {
      expect(Money.fromString("0", "USD").isZero()).toBe(true);
      expect(Money.fromString("0.00", "USD").isZero()).toBe(true);
      expect(Money.fromString("-1", "USD").isNegative()).toBe(true);
      expect(Money.fromString("1", "USD").isNegative()).toBe(false);
      expect(Money.zero("USD").toString()).toBe("0.00");
    });

    it("compare: orders values exactly, without going through a float", () => {
      const a = Money.fromString("0.10", "USD");
      const b = Money.fromString("0.20", "USD");
      expect(a.compare(b)).toBe(-1);
      expect(b.compare(a)).toBe(1);
      expect(a.compare(Money.fromString("0.1", "USD"))).toBe(0);
    });

    it("compare: decides a difference no float could represent", () => {
      // 0.1 + 0.2 !== 0.3 in IEEE 754; through Decimal these are equal, and a
      // sort that used subtraction-to-number would order them wrongly.
      const sum = Money.fromString("0.10", "USD").add(Money.fromString("0.20", "USD"));
      expect(sum.compare(Money.fromString("0.30", "USD"))).toBe(0);
    });

    it("compare: refuses to order across currencies", () => {
      expect(() => Money.fromString("1", "USD").compare(Money.fromString("1", "EUR"))).toThrow(
        /currency/i,
      );
    });

    it("abs: returns the magnitude, leaving a positive value alone", () => {
      expect(Money.fromString("-1234.56", "USD").abs().toString()).toBe("1234.56");
      expect(Money.fromString("1234.56", "USD").abs().toString()).toBe("1234.56");
      expect(Money.fromString("-0.00", "USD").abs().toString()).toBe("0.00");
    });

    it("abs: keeps the currency", () => {
      expect(Money.fromString("-5", "EUR").abs().currency).toBe("EUR");
    });
  });

  describe("Money.sum", () => {
    it("sums an empty list to zero", () => {
      expect(Money.sum([], "USD").toString()).toBe("0.00");
    });

    it("sums a list of same-currency Money", () => {
      const items = [
        Money.fromString("1.10", "USD"),
        Money.fromString("2.20", "USD"),
        Money.fromString("3.30", "USD"),
      ];
      expect(Money.sum(items, "USD").toString()).toBe("6.60");
    });

    it("throws if any item's currency differs", () => {
      const items = [Money.fromString("1", "USD"), Money.fromString("1", "EUR")];
      expect(() => Money.sum(items, "USD")).toThrow(/currency/i);
    });
  });

  describe("formatting", () => {
    it("formats USD with en-US locale", () => {
      const m = Money.fromString("1234.56", "USD");
      expect(m.format("en-US")).toBe("$1,234.56");
    });

    it("formats negative values with the locale's sign convention", () => {
      const m = Money.fromString("-1234.56", "USD");
      const formatted = m.format("en-US");
      expect(formatted).toContain("1,234.56");
      // en-US uses leading minus or parens; both acceptable
      expect(formatted.match(/-|\(/)).not.toBeNull();
    });
  });
});
