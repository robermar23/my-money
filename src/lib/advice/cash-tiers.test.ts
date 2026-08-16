import { ACCOUNT_SUBTYPES } from "@/db/schema/accounts.ts";
// @vitest-environment node
import { describe, expect, it } from "vitest";
import { type CashAccountInput, classifyCashTiers, tierForSubtype } from "./cash-tiers.ts";

/*
 * P15-10 — cash tiering (ADR-033 §1). Pure: no DB, no fixtures.
 *
 * This answers Round 9's "how much on hand vs. how much in medium-term savings
 * like CD's", which was structurally unanswerable before `accounts.subtype`.
 */

function account(partial: Partial<CashAccountInput> & { balance: string }): CashAccountInput {
  return {
    accountId: `acct-${partial.subtype ?? "none"}-${partial.balance}`,
    name: "Account",
    institution: "M&T",
    subtype: null,
    apy: null,
    maturityDate: null,
    balanceAsOf: "2026-08-01",
    ...partial,
  };
}

describe("tierForSubtype", () => {
  it("maps every subtype in the vocabulary to a tier", () => {
    expect(tierForSubtype("checking")).toBe("operating");
    expect(tierForSubtype("cash_management")).toBe("operating");
    expect(tierForSubtype("savings")).toBe("reserve");
    expect(tierForSubtype("money_market")).toBe("reserve");
    expect(tierForSubtype("cd")).toBe("medium_term");
  });

  it("covers the whole ACCOUNT_SUBTYPES tuple — a new subtype must be mapped here", () => {
    // Guards the failure mode where Batch 5 adds a subtype to the CHECK and the
    // tiering silently starts reporting real money as unclassified.
    for (const subtype of ACCOUNT_SUBTYPES) {
      expect(tierForSubtype(subtype)).not.toBe("unclassified");
    }
  });

  it("never guesses for a null subtype", () => {
    expect(tierForSubtype(null)).toBe("unclassified");
  });
});

describe("classifyCashTiers", () => {
  const accounts: CashAccountInput[] = [
    account({ subtype: "checking", balance: "4200.00", name: "Everyday" }),
    account({ subtype: "cash_management", balance: "800.00", name: "Brokerage cash" }),
    account({ subtype: "savings", balance: "12000.00", name: "Emergency", apy: "4.2000" }),
    account({ subtype: "money_market", balance: "6000.00", name: "MMF" }),
    account({ subtype: "cd", balance: "10000.00", name: "12-mo CD", maturityDate: "2027-03-01" }),
  ];

  it("totals each tier and keeps its member accounts", () => {
    const result = classifyCashTiers({ accounts, essentialMonthly: "3000.00" });

    expect(result.operating.total).toBe("5000.00");
    expect(result.reserve.total).toBe("18000.00");
    expect(result.mediumTerm.total).toBe("10000.00");
    expect(result.unclassified.total).toBe("0.00");
    expect(result.total).toBe("33000.00");

    expect(result.reserve.accounts.map((a) => a.name).sort()).toEqual(["Emergency", "MMF"]);
    expect(result.mediumTerm.accounts[0]?.maturityDate).toBe("2027-03-01");
  });

  it("excludes CDs and unclassified money from the liquid figure", () => {
    const result = classifyCashTiers({
      accounts: [...accounts, account({ subtype: null, balance: "5000.00", name: "Unknown" })],
      essentialMonthly: "3000.00",
    });

    // Liquid = operating + reserve only. Breaking a CD costs a penalty, and we
    // do not know what the unclassified account even is — counting either would
    // overstate same-day availability.
    expect(result.liquid).toBe("23000.00");
    expect(result.total).toBe("38000.00");
  });

  it("expresses each tier in months of essential expenses", () => {
    const result = classifyCashTiers({ accounts, essentialMonthly: "3000.00" });

    expect(result.reserve.monthsCovered).toBe("6");
    expect(result.operating.monthsCovered).toBe("1.67");
    expect(result.liquidMonthsCovered).toBe("7.67");
  });

  it("reports null coverage — not zero — when the essential baseline is unknown", () => {
    const result = classifyCashTiers({ accounts, essentialMonthly: null });

    // "0 months of runway" would read as an emergency on a household holding
    // $33,000. The honest answer is that we cannot say yet.
    expect(result.reserve.monthsCovered).toBeNull();
    expect(result.liquidMonthsCovered).toBeNull();
    // The dollar totals are still correct and still shown.
    expect(result.reserve.total).toBe("18000.00");
  });

  it("degrades to unclassified when no subtype is set — never guesses checking", () => {
    const untriaged = [
      account({ subtype: null, balance: "4200.00", name: "M&T 1" }),
      account({ subtype: null, balance: "12000.00", name: "M&T 2" }),
    ];
    const result = classifyCashTiers({ accounts: untriaged, essentialMonthly: "3000.00" });

    expect(result.unclassified.total).toBe("16200.00");
    expect(result.operating.total).toBe("0.00");
    expect(result.reserve.total).toBe("0.00");
    // Liquid is zero even though $16,200 is sitting in a bank: we genuinely do
    // not know whether it is a checking account or a CD, and the emergency-fund
    // rule must see `unclassifiedShare` and say so rather than pass or fail.
    expect(result.liquid).toBe("0.00");
    expect(result.unclassifiedShare).toBe(1);
  });

  it("mixes classified and unclassified and reports the share", () => {
    const result = classifyCashTiers({
      accounts: [
        account({ subtype: "checking", balance: "7500.00" }),
        account({ subtype: null, balance: "2500.00" }),
      ],
      essentialMonthly: "2500.00",
    });

    expect(result.unclassifiedShare).toBe(0.25);
    expect(result.operating.monthsCovered).toBe("3");
  });

  it("handles an empty account list without dividing by zero", () => {
    const result = classifyCashTiers({ accounts: [], essentialMonthly: "3000.00" });

    expect(result.total).toBe("0.00");
    expect(result.liquid).toBe("0.00");
    expect(result.unclassifiedShare).toBe(0); // not NaN
    expect(result.liquidMonthsCovered).toBe("0");
  });
});
