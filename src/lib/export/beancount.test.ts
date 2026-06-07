import { describe, expect, it } from "vitest";
import {
  type BeancountAccountRow,
  accountToBeancountName,
  formatBalance,
  formatPrice,
  formatTransaction,
  renderBeancount,
} from "./beancount.ts";

/* ---------------------------------------------------------------------------
 * Fixtures
 * --------------------------------------------------------------------------- */

function acct(
  over: Partial<BeancountAccountRow> & Pick<BeancountAccountRow, "type" | "institution" | "name">,
): BeancountAccountRow {
  return {
    id: "a1",
    currency: "USD",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    ...over,
  };
}

const FIXED = new Date("2026-06-07T12:00:00.000Z");

/* ---------------------------------------------------------------------------
 * accountToBeancountName
 * --------------------------------------------------------------------------- */

describe("accountToBeancountName", () => {
  it("maps account type to the right beancount root and CamelCases the parts", () => {
    expect(
      accountToBeancountName(
        acct({ type: "depository", institution: "M&T Bank", name: "Checking" }),
      ),
    ).toBe("Assets:MTBank:Checking");
    expect(
      accountToBeancountName(acct({ type: "credit_card", institution: "Amex", name: "Gold Card" })),
    ).toBe("Liabilities:Amex:GoldCard");
    expect(
      accountToBeancountName(
        acct({ type: "loan", institution: "Sunwest Mortgage", name: "Home Loan" }),
      ),
    ).toBe("Liabilities:SunwestMortgage:HomeLoan");
    expect(
      accountToBeancountName(acct({ type: "property", institution: "Zillow", name: "Home" })),
    ).toBe("Assets:Zillow:Home");
    expect(
      accountToBeancountName(
        acct({ type: "investment", institution: "Fidelity", name: "Brokerage" }),
      ),
    ).toBe("Assets:Fidelity:Brokerage");
    expect(
      accountToBeancountName(acct({ type: "crypto_ira", institution: "iTrust", name: "Gold IRA" })),
    ).toBe("Assets:ITrust:GoldIRA");
  });

  it("falls back to a placeholder component when a name sanitizes to empty", () => {
    expect(
      accountToBeancountName(acct({ type: "depository", institution: "!!!", name: "###" })),
    ).toBe("Assets:X:X");
  });
});

/* ---------------------------------------------------------------------------
 * formatBalance / formatPrice — scale preserved, no float drift
 * --------------------------------------------------------------------------- */

describe("formatBalance", () => {
  it("renders a balance assertion in the account currency", () => {
    const a = acct({ type: "depository", institution: "M&T Bank", name: "Checking" });
    expect(formatBalance(a, { accountId: "a1", date: "2026-06-07", balance: "1234.56" })).toBe(
      "2026-06-07 balance Assets:MTBank:Checking 1234.56 USD",
    );
  });

  it("preserves cents exactly (no float rounding)", () => {
    const a = acct({ type: "depository", institution: "Big", name: "Bank" });
    expect(formatBalance(a, { accountId: "a1", date: "2026-06-07", balance: "1000000.01" })).toBe(
      "2026-06-07 balance Assets:Big:Bank 1000000.01 USD",
    );
  });
});

describe("formatPrice", () => {
  it("renders a price directive preserving 8-dp precision", () => {
    expect(formatPrice({ symbol: "XAU", date: "2026-06-07", close: "2350.45000000" })).toBe(
      "2026-06-07 price XAU 2350.45000000 USD",
    );
  });

  it("sanitizes a synthetic symbol into a valid commodity", () => {
    // SEC:<uuid> isn't a valid beancount commodity (colon); it must be coerced.
    expect(formatPrice({ symbol: "SEC:abc", date: "2026-06-07", close: "10.00000000" })).toMatch(
      /^2026-06-07 price [A-Z][A-Z0-9-]* 10\.00000000 USD$/,
    );
  });
});

/* ---------------------------------------------------------------------------
 * formatTransaction — best-effort two-posting, balanced
 * --------------------------------------------------------------------------- */

describe("formatTransaction", () => {
  const checking = acct({ type: "depository", institution: "M&T Bank", name: "Checking" });

  it("renders an expense (negative) with an Expenses contra leg that balances", () => {
    const out = formatTransaction(
      {
        accountId: "a1",
        postedAt: "2026-06-05",
        amount: "-12.50",
        name: "Starbucks",
        memo: null,
        category: "Restaurant",
      },
      checking,
    );
    expect(out).toBe(
      [
        '2026-06-05 * "Starbucks"',
        "  Assets:MTBank:Checking  -12.50 USD",
        "  Expenses:Restaurant  12.50 USD",
      ].join("\n"),
    );
  });

  it("renders income (positive) with an Income contra leg and a memo narration", () => {
    const out = formatTransaction(
      {
        accountId: "a1",
        postedAt: "2026-06-05",
        amount: "2000.00",
        name: "ACME Payroll",
        memo: "June",
        category: null,
      },
      checking,
    );
    expect(out).toBe(
      [
        '2026-06-05 * "ACME Payroll" "June"',
        "  Assets:MTBank:Checking  2000.00 USD",
        "  Income:Uncategorized  -2000.00 USD",
      ].join("\n"),
    );
  });

  it("escapes quotes and backslashes in the narration", () => {
    const out = formatTransaction(
      {
        accountId: "a1",
        postedAt: "2026-06-05",
        amount: "-1.00",
        name: 'Joe "The" Bar\\Grill',
        memo: null,
        category: "Food",
      },
      checking,
    );
    expect(out.split("\n")[0]).toBe('2026-06-05 * "Joe \\"The\\" Bar\\\\Grill"');
  });
});

/* ---------------------------------------------------------------------------
 * renderBeancount — header, ordering, determinism
 * --------------------------------------------------------------------------- */

describe("renderBeancount", () => {
  const checking = acct({
    id: "a1",
    type: "depository",
    institution: "M&T Bank",
    name: "Checking",
  });
  const card = acct({ id: "a2", type: "credit_card", institution: "Amex", name: "Gold" });

  const input = {
    accounts: [checking, card],
    snapshots: [
      { accountId: "a1", date: "2026-06-07", balance: "1234.56" },
      { accountId: "a2", date: "2026-06-07", balance: "-200.00" },
    ],
    prices: [{ symbol: "XAU", date: "2026-06-07", close: "2350.45000000" }],
    transactions: [
      {
        accountId: "a1",
        postedAt: "2026-06-05",
        amount: "-12.50",
        name: "Starbucks",
        memo: null,
        category: "Restaurant",
      },
    ],
    generatedAt: FIXED,
  };

  it("emits the GENERATED banner + options header", () => {
    const out = renderBeancount({
      accounts: [],
      snapshots: [],
      prices: [],
      transactions: [],
      generatedAt: FIXED,
    });
    expect(out).toContain("GENERATED");
    expect(out).toContain('option "operating_currency" "USD"');
    // No directive LINES for an empty DB (the header prose mentions "balance").
    expect(out).not.toMatch(/^\d{4}-\d\d-\d\d open /m);
    expect(out).not.toMatch(/^\d{4}-\d\d-\d\d balance /m);
    expect(out).not.toMatch(/^\d{4}-\d\d-\d\d price /m);
  });

  it("opens accounts, then prices, balances, and transactions", () => {
    const out = renderBeancount(input);
    expect(out).toContain("open Assets:MTBank:Checking USD");
    expect(out).toContain("open Liabilities:Amex:Gold USD");
    expect(out).toContain("2026-06-07 price XAU 2350.45000000 USD");
    expect(out).toContain("2026-06-07 balance Assets:MTBank:Checking 1234.56 USD");
    expect(out).toContain('2026-06-05 * "Starbucks"');
    // Open date is on/ before the earliest activity (2026-06-05 txn).
    expect(out).toContain("2026-06-05 open Assets:MTBank:Checking USD");
  });

  it("is deterministic: same input + generatedAt → byte-identical output", () => {
    expect(renderBeancount(input)).toBe(renderBeancount(input));
  });
});
