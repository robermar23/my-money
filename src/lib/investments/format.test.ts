import { describe, expect, it } from "vitest";
import { formatQuantity } from "./format.ts";

describe("formatQuantity", () => {
  it("drops trailing zeros from whole quantities", () => {
    expect(formatQuantity("55.00000000")).toBe("55");
  });

  it("keeps significant fraction digits and groups thousands", () => {
    expect(formatQuantity("1631.34300000")).toBe("1,631.343");
    expect(formatQuantity("6129.96300000")).toBe("6,129.963");
  });

  it("preserves sub-unit crypto precision up to 8dp", () => {
    expect(formatQuantity("0.18894857")).toBe("0.18894857");
  });

  it("handles small cash-fund residue", () => {
    expect(formatQuantity("4.39000000")).toBe("4.39");
  });

  it("returns '0' for unparseable input", () => {
    expect(formatQuantity("not-a-number")).toBe("0");
  });
});
