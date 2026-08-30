// @vitest-environment node
import { accountTypeEnum } from "@/db/schema/enums.ts";
import { describe, expect, it } from "vitest";
import { type AccountType, enteredBalance, isLiabilityAccount, snapshotBalance } from "./sign.ts";

/**
 * P17-31 — the sign helper's regression suite (ADR-042).
 *
 * The interesting cases are not "does it negate a card" — that is one line. They
 * are the ones that would let the convention drift back:
 *
 *   - **every** enum member is asserted, so a type whose sign nobody decided
 *     cannot slip through by defaulting to verbatim;
 *   - the overpaid card round-trips, because an invertible mapping is what
 *     ADR-042 §2 traded the odd-reading negative entry *for*;
 *   - zero must not come back `"-0.00"`, which is a `NUMERIC(18,2)` value that
 *     compares equal to zero but does not string-compare equal to `"0.00"` —
 *     and this codebase asserts money as strings.
 */

const LIABILITIES: readonly AccountType[] = ["credit_card", "loan"];
const ASSETS: readonly AccountType[] = [
  "depository",
  "investment",
  "crypto_ira",
  "property",
  "personal_asset",
];

describe("snapshotBalance", () => {
  it("covers every member of accountTypeEnum, so nothing defaults silently", () => {
    // If this fails, the enum gained a member and the two lists above were not
    // updated — which means nobody has stated whether the new type's balance
    // subtracts from net worth. `sign.ts` already fails the build in that case
    // via its `satisfies`; this asserts the *test* stays exhaustive too.
    const covered = [...LIABILITIES, ...ASSETS].sort();
    expect(covered).toEqual([...accountTypeEnum.enumValues].sort());
  });

  it.each(LIABILITIES)("negates a positive entry for %s — it is an amount owed", (type) => {
    expect(snapshotBalance(type, "1200.00", "USD")).toBe("-1200.00");
  });

  it.each(ASSETS)("stores %s verbatim — the entry already is a net-worth contribution", (type) => {
    expect(snapshotBalance(type, "1200.00", "USD")).toBe("1200.00");
  });

  it("stores an overpaid card positive, so the state stays expressible", () => {
    // The issuer owes the household $75. Odd to type, but ADR-042 rejected every
    // design that made it *inexpressible* — a validation error refusing positive
    // amounts, or a CHECK constraint forcing card balances non-positive.
    expect(snapshotBalance("credit_card", "-75.00", "USD")).toBe("75.00");
  });

  it("normalizes to cents precision, matching NUMERIC(18,2)", () => {
    expect(snapshotBalance("credit_card", "1200", "USD")).toBe("-1200.00");
    expect(snapshotBalance("depository", "1200.5", "USD")).toBe("1200.50");
  });

  it("never produces -0.00 for a zero-balance liability", () => {
    // A paid-off card is the common case for this one. `"-0.00"` is a perfectly
    // valid NUMERIC that would compare equal to zero in SQL and *not* equal to
    // `"0.00"` in every string assertion this codebase makes about money.
    expect(snapshotBalance("credit_card", "0.00", "USD")).toBe("0.00");
    expect(snapshotBalance("loan", "0", "USD")).toBe("0.00");
    expect(snapshotBalance("depository", "0.00", "USD")).toBe("0.00");
  });

  it("carries the currency through without touching the digits", () => {
    expect(snapshotBalance("credit_card", "1200.00", "EUR")).toBe("-1200.00");
  });
});

describe("enteredBalance", () => {
  it.each(LIABILITIES)("shows a stored negative for %s as a positive amount owed", (type) => {
    expect(enteredBalance(type, "-1200.00", "USD")).toBe("1200.00");
  });

  it.each(ASSETS)("shows a stored %s balance unchanged", (type) => {
    expect(enteredBalance(type, "1200.00", "USD")).toBe("1200.00");
  });

  it("round-trips every account type, including the overpaid card", () => {
    for (const type of accountTypeEnum.enumValues) {
      for (const entered of ["1200.00", "-75.00", "0.00", "0.01"]) {
        expect(enteredBalance(type, snapshotBalance(type, entered, "USD"), "USD")).toBe(entered);
      }
    }
  });
});

describe("isLiabilityAccount", () => {
  it("agrees with what snapshotBalance actually does, for every type", () => {
    // The UI picks its label from this predicate (ADR-042 §3). If the two could
    // disagree, the form could say "Balance" while storage negated — which is
    // exactly the silent 2x error this batch exists to remove.
    for (const type of accountTypeEnum.enumValues) {
      const negated = snapshotBalance(type, "100.00", "USD") === "-100.00";
      expect(isLiabilityAccount(type)).toBe(negated);
    }
  });
});
