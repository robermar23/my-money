import { describe, expect, it } from "vitest";
import { formatTypedAmount } from "./typed-amount.ts";

describe("formatTypedAmount", () => {
  it("should group thousands and pad cents", () => {
    expect(formatTypedAmount("1234.5", "USD")).toBe("$1,234.50");
    expect(formatTypedAmount("1234567", "USD")).toBe("$1,234,567.00");
  });

  it("should stay exact beyond float precision", () => {
    expect(formatTypedAmount("12345678901234567.89", "USD")).toBe("$12,345,678,901,234,567.89");
  });

  it("should show a true minus for negatives but not for zero", () => {
    expect(formatTypedAmount("-80", "USD")).toBe("−$80.00");
    expect(formatTypedAmount("-0.00", "USD")).toBe("$0.00");
  });

  it("should drop leading zeros", () => {
    expect(formatTypedAmount("007.1", "USD")).toBe("$7.10");
    expect(formatTypedAmount("0.05", "USD")).toBe("$0.05");
  });

  it("should put other currency codes after the number", () => {
    expect(formatTypedAmount("1500", "EUR")).toBe("1,500.00 EUR");
  });

  it("should return null for anything the server schema would refuse", () => {
    for (const raw of ["", "-", "12.", "1.234", "$12", "1,234", "abc", "1e5"]) {
      expect(formatTypedAmount(raw, "USD")).toBeNull();
    }
  });

  it("should ignore surrounding whitespace, as the schema's trim does", () => {
    expect(formatTypedAmount("  42 ", "USD")).toBe("$42.00");
  });
});
