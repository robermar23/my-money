// @vitest-environment node
import { normalizePayee } from "@/lib/importers/normalize.ts";
import { describe, expect, it } from "vitest";
import { payeeKey } from "./payee-key.ts";

/**
 * Real-shaped payee strings: the shapes a real bank register emits (truncated
 * descriptors, trailing account numbers, processor separators, embedded dates),
 * which is the only thing worth testing a normalizer against. The values are
 * synthetic; never paste a line from a real statement here (CONTRIBUTING.md).
 */
const REAL_PAYEES = [
  "DEPOSIT - DETAIL NOT YET AVAILABLE",
  "APPLE CASH SENT MONE",
  "APPLE CASH SENT MONEY 1INFINITELOOP",
  "WEB XFER TO CHK 00005556667778",
  "WEB XFER TO SAV 90001234567890",
  "WEB XFER FROM SAV 90001234567890",
  "CITI CARD ONLINE PAYMENT",
  "CASH APP*JAMIE RIVERS PORTLAND",
  "Venmo",
  "Northgate Lending",
  "State Pension Board",
  "ZELLE P2P PAYMENT SENT ON 06/09 \\",
  "Verizon",
  "PAYPAL PURCHASE",
  "77ACMECOPAYROLL PAYROLL",
  "Pinecrest Mortgag Mortgage",
  "Installment Loan",
  "Riverside Gas An",
  "CHECK 1047",
] as const;

describe("payeeKey — grouping real bank descriptions", () => {
  it("ignores the account number in a transfer description", () => {
    // Same series, different trailing reference id.
    expect(payeeKey("WEB XFER TO SAV 90001234567890")).toBe(
      payeeKey("WEB XFER TO SAV 99999999999999"),
    );
    expect(payeeKey("WEB XFER TO SAV 90001234567890")).toBe("web xfer to sav");
  });

  it("distinguishes direction in a transfer description", () => {
    // "TO SAV" and "FROM SAV" are opposite money movements, not one series.
    expect(payeeKey("WEB XFER TO SAV 90001234567890")).not.toBe(
      payeeKey("WEB XFER FROM SAV 90001234567890"),
    );
  });

  it("ignores the embedded date in a Zelle description", () => {
    expect(payeeKey("ZELLE P2P PAYMENT SENT ON 06/09 \\")).toBe(
      payeeKey("ZELLE P2P PAYMENT SENT ON 07/12 \\"),
    );
  });

  it("keeps an alphanumeric token that is part of the merchant name", () => {
    // "P2P" is not a store number; dropping it would merge unrelated series.
    expect(payeeKey("ZELLE P2P PAYMENT SENT ON 06/09 \\")).toContain("p2p");
  });

  it("is case-insensitive", () => {
    expect(payeeKey("Verizon")).toBe(payeeKey("VERIZON"));
    expect(payeeKey("Verizon")).toBe("verizon");
  });

  it("turns processor punctuation into a word boundary", () => {
    expect(payeeKey("CASH APP*JAMIE RIVERS PORTLAND")).toBe("cash app jamie rivers portland");
  });

  it("collapses runs of whitespace", () => {
    expect(payeeKey("  Pinecrest   Mortgag  Mortgage ")).toBe("pinecrest mortgag mortgage");
  });

  it("returns a stable key for every real payee, never an empty string", () => {
    for (const name of REAL_PAYEES) {
      expect(payeeKey(name).length).toBeGreaterThan(0);
    }
  });

  it("falls back to the input when normalization would empty the string", () => {
    // An all-digits description has no merchant to extract; an empty key would
    // silently merge every such row into one bogus series.
    expect(payeeKey("00005556667778")).toBe("00005556667778");
    expect(payeeKey("   ")).toBe("");
  });

  it("is idempotent — a key re-keys to itself", () => {
    for (const name of REAL_PAYEES) {
      expect(payeeKey(payeeKey(name))).toBe(payeeKey(name));
    }
  });
});

describe("payeeKey — one notion of 'the same merchant' (P16-08)", () => {
  it("induces exactly the partition normalizePayee does", () => {
    // The contract that keeps detection and the categorization rule engine from
    // disagreeing about merchant identity. `toLowerCase` on an already
    // uppercased string is a bijection, so the equivalence classes are
    // IDENTICAL, not merely similar — assert that over every pair.
    for (const a of REAL_PAYEES) {
      for (const b of REAL_PAYEES) {
        expect(payeeKey(a) === payeeKey(b)).toBe(normalizePayee(a) === normalizePayee(b));
      }
    }
  });

  it("is the lowercased normalizePayee for every real payee", () => {
    for (const name of REAL_PAYEES) {
      expect(payeeKey(name)).toBe(normalizePayee(name).toLowerCase());
    }
  });
});

describe("payeeKey — documented over-merges (P16-08)", () => {
  it("merges all check numbers into one key", () => {
    // Known and accepted: a check number is a reference, not a merchant, so
    // `normalizePayee` strips it and every check collapses together. Detection
    // survives this because a check series has no stable amount or cadence —
    // amountStability and detectPeriodicity reject it downstream.
    expect(payeeKey("CHECK 1047")).toBe(payeeKey("CHECK 0103"));
  });

  it("does not merge a truncated description with its full form", () => {
    // The bank truncates inconsistently; nothing can recover the missing tail
    // without guessing. Under-merging costs a candidate the user can add by
    // hand — over-merging would put a wrong cadence on a confirmed obligation.
    expect(payeeKey("APPLE CASH SENT MONE")).not.toBe(
      payeeKey("APPLE CASH SENT MONEY 1INFINITELOOP"),
    );
  });
});
