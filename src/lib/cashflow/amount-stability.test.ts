// @vitest-environment node
import { describe, expect, it } from "vitest";
import { FIXED_SPREAD_RATIO, amountStability } from "./amount-stability.ts";

describe("amountStability — a fixed obligation", () => {
  it("reports a zero spread for an exactly-fixed series", () => {
    const result = amountStability(["2150.00", "2150.00", "2150.00", "2150.00", "2150.00"]);
    expect(result).toEqual({
      median: "2150.00",
      spread: "0.00",
      mode: "fixed",
    });
  });

  it("reads a series that wobbles within tolerance as fixed", () => {
    // A subscription whose tax rounds a cent or two either way is a fixed bill.
    const result = amountStability(["102.00", "98.00", "100.00", "101.00", "99.00", "100.00"]);
    expect(result.median).toBe("100.00");
    expect(result.spread).toBe("1.00");
    expect(result.mode).toBe("fixed");
  });

  it("takes the median exactly on an even-length series", () => {
    // (100.01 + 100.02) / 2 = 100.015 — a value no float halves correctly, and
    // the storage column is NUMERIC(18,2), so it must land on a cent.
    const result = amountStability(["100.01", "100.02"]);
    expect(result.median).toBe("100.02");
  });

  it("handles a single observation", () => {
    const result = amountStability(["2150.00"]);
    expect(result).toEqual({ median: "2150.00", spread: "0.00", mode: "fixed" });
  });
});

describe("amountStability — MAD, not standard deviation (P16-10)", () => {
  it("keeps an annual true-up from labelling a fixed rent variable", () => {
    // Eleven identical rents and one catch-up charge. The standard deviation of
    // this series is over $100 and would flip the mode to `trailing_median`,
    // which would then re-price every future month off a number that included
    // the one-off. The median absolute deviation is zero, because a median does
    // not care about one extreme value — that is the entire reason for the
    // choice, and this test is the reason to keep it.
    const amounts = [
      "2000.00",
      "2000.00",
      "2000.00",
      "2000.00",
      "2000.00",
      "2000.00",
      "2000.00",
      "2000.00",
      "2000.00",
      "2000.00",
      "2000.00",
      "2400.00",
    ];
    const result = amountStability(amounts);
    expect(result.median).toBe("2000.00");
    expect(result.spread).toBe("0.00");
    expect(result.mode).toBe("fixed");
  });

  it("still reports a genuinely variable series as variable", () => {
    // A seasonal utility bill: the dispersion is not one outlier, it is the
    // shape of the data.
    const result = amountStability(["180.00", "240.00", "95.00", "310.00", "120.00", "260.00"]);
    expect(result.median).toBe("210.00");
    expect(result.spread).toBe("70.00");
    expect(result.mode).toBe("trailing_median");
  });
});

describe("amountStability — the fixed/variable boundary", () => {
  it("states its threshold as a share of the median", () => {
    expect(FIXED_SPREAD_RATIO).toBe("0.02");
  });

  it("treats a spread exactly at the threshold as fixed", () => {
    // Median 100.00, MAD exactly 2.00 — the boundary is inclusive.
    const result = amountStability(["98.00", "98.00", "98.00", "102.00", "102.00", "102.00"]);
    expect(result.median).toBe("100.00");
    expect(result.spread).toBe("2.00");
    expect(result.mode).toBe("fixed");
  });

  it("treats a spread just past the threshold as variable", () => {
    const result = amountStability(["97.00", "97.00", "97.00", "103.00", "103.00", "103.00"]);
    expect(result.median).toBe("100.00");
    expect(result.spread).toBe("3.00");
    expect(result.mode).toBe("trailing_median");
  });

  it("does not divide by a zero median", () => {
    const result = amountStability(["0.00", "0.00", "0.00"]);
    expect(result.median).toBe("0.00");
    expect(result.mode).toBe("fixed");
  });
});

describe("amountStability — sign and input handling", () => {
  it("reports magnitudes, so an outflow series is not negative", () => {
    // `transactions.amount` is signed; `scheduled_obligations.expected_amount`
    // is a positive magnitude with a non-negativity CHECK, and `direction`
    // carries the sign. This is the boundary where that conversion happens.
    const result = amountStability(["-2150.00", "-2150.00", "-2150.00"]);
    expect(result.median).toBe("2150.00");
    expect(result.spread).toBe("0.00");
  });

  it("refuses a series that mixes charges and refunds", () => {
    // Averaging a -$100 charge with a +$100 refund would report a $100 bill
    // that nets to nothing. The caller groups by direction first.
    expect(() => amountStability(["-100.00", "100.00", "-100.00"])).toThrow(/sign/i);
  });

  it("refuses an empty series", () => {
    expect(() => amountStability([])).toThrow();
  });

  it("does not require sorted input", () => {
    const ascending = amountStability(["95.00", "120.00", "180.00", "240.00"]);
    const shuffled = amountStability(["240.00", "95.00", "180.00", "120.00"]);
    expect(shuffled).toEqual(ascending);
  });

  it("carries a non-USD currency through without converting", () => {
    const result = amountStability(["10.00", "10.00", "10.00"], "EUR");
    expect(result.median).toBe("10.00");
  });
});
