import { Money } from "@/lib/money/money.ts";
import { describe, expect, it } from "vitest";
import { balanceAtMonth, monthlyPayment } from "./amortization.ts";

describe("monthlyPayment", () => {
  it("matches reference values for a $200,000 / 6% / 360-month loan", () => {
    // Reference: standard amortization. $200,000 @ 6% APR / 30 years → $1,199.10/mo
    const p = monthlyPayment(Money.fromString("200000", "USD"), "0.06", 360);
    expect(p.toString()).toBe("1199.10");
  });

  it("matches reference values for a $100,000 / 4.5% / 180-month loan", () => {
    // $100,000 @ 4.5% APR / 15 years → ~$764.99/mo
    const p = monthlyPayment(Money.fromString("100000", "USD"), "0.045", 180);
    expect(p.toString()).toBe("764.99");
  });

  it("handles a zero-interest loan as principal / term", () => {
    const p = monthlyPayment(Money.fromString("12000", "USD"), "0", 12);
    expect(p.toString()).toBe("1000.00");
  });

  it("preserves the loan's currency", () => {
    const p = monthlyPayment(Money.fromString("100000", "EUR"), "0.045", 180);
    expect(p.currency).toBe("EUR");
  });

  it("rejects nonsense inputs", () => {
    expect(() => monthlyPayment(Money.fromString("100000", "USD"), "0.045", 0)).toThrow();
    expect(() => monthlyPayment(Money.fromString("100000", "USD"), "0.045", -1)).toThrow();
    expect(() => monthlyPayment(Money.fromString("-100", "USD"), "0.045", 12)).toThrow();
    expect(() => monthlyPayment(Money.fromString("100000", "USD"), "-0.05", 12)).toThrow();
  });
});

describe("balanceAtMonth", () => {
  it("returns the original principal at month 0", () => {
    const balance = balanceAtMonth(Money.fromString("200000", "USD"), "0.06", 360, 0);
    expect(balance.toString()).toBe("200000.00");
  });

  it("returns approximately zero at the final scheduled month", () => {
    const balance = balanceAtMonth(Money.fromString("200000", "USD"), "0.06", 360, 360);
    // Should be within a few cents of zero (rounding accumulates across 360 months).
    expect(Number(balance.toString())).toBeCloseTo(0, 1);
  });

  it("matches the reference balance at month 60 for the $200k / 6% / 360 loan", () => {
    // Standard reference: balance at month 60 ≈ $186,108.71
    const balance = balanceAtMonth(Money.fromString("200000", "USD"), "0.06", 360, 60);
    // Allow 1 cent tolerance for rounding-direction differences.
    expect(Number(balance.toString())).toBeCloseTo(186108.71, 1);
  });

  it("handles a zero-interest loan linearly", () => {
    // $12,000 / 12 months @ 0% → $1,000/mo, balance at month 3 = $9,000
    const balance = balanceAtMonth(Money.fromString("12000", "USD"), "0", 12, 3);
    expect(balance.toString()).toBe("9000.00");
  });

  it("never returns a negative balance even past the term", () => {
    const balance = balanceAtMonth(Money.fromString("200000", "USD"), "0.06", 360, 400);
    expect(balance.isNegative()).toBe(false);
    expect(balance.isZero()).toBe(true);
  });

  it("preserves the loan's currency", () => {
    const balance = balanceAtMonth(Money.fromString("100000", "EUR"), "0.045", 180, 60);
    expect(balance.currency).toBe("EUR");
  });
});
