// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  type CreditLineRow,
  type DebtSources,
  type LiabilityRow,
  totalMinimumDebtService,
  unifyDebtTermsFrom,
} from "./debt-terms.ts";

/*
 * P15-11 — unified debt terms (ADR-033 §3). Pure: no DB.
 *
 * The case that matters most is the LAST one: a debt with no terms recorded.
 * Terms are manual-first and the columns ship empty, so "no APR" is the normal
 * day-one state. It must surface as `unknown_input` with the balance intact —
 * never dropped, and never defaulted to 0% (which would make the payoff
 * simulator confidently recommend paying a 25% card last).
 */

const TODAY = "2026-08-15";
const UPDATED = new Date("2026-08-01T00:00:00Z");

const MORTGAGE = { id: "acct-loan", name: "Home Loan", institution: "Sunwest", type: "loan" };
const CARD = { id: "acct-card", name: "Everyday Card", institution: "Citi", type: "credit_card" };

function sources(partial: Partial<DebtSources> = {}): DebtSources {
  return { accounts: [], liabilities: [], creditLines: [], latestBalances: [], ...partial };
}

const liability = (partial: Partial<LiabilityRow> = {}): LiabilityRow => ({
  accountId: MORTGAGE.id,
  principalAtOrigination: "200000.00",
  annualRate: "0.060000",
  termMonths: 360,
  startDate: "2020-08-15",
  updatedAt: UPDATED,
  ...partial,
});

const creditLine = (partial: Partial<CreditLineRow> = {}): CreditLineRow => ({
  accountId: CARD.id,
  apr: "0.249900",
  creditLimit: "15000.00",
  minimumPayment: "35.00",
  minimumPaymentPercent: null,
  updatedAt: UPDATED,
  ...partial,
});

describe("unifyDebtTermsFrom — the amortizing branch", () => {
  it("derives APR and the scheduled payment from the origination parameters", () => {
    const [term] = unifyDebtTermsFrom(
      sources({
        accounts: [MORTGAGE],
        liabilities: [liability()],
        latestBalances: [{ accountId: MORTGAGE.id, date: "2026-08-01", balance: "-180500.00" }],
      }),
      TODAY,
    );

    expect(term).toMatchObject({
      kind: "amortizing",
      apr: "0.060000",
      // $200,000 @ 6% / 360 months — the shipped mortgage math, reused not redone.
      minimumPayment: "1199.10",
      // Snapshots store a loan as a NEGATIVE balance; this is the sign flip.
      balance: "180500.00",
      balanceAsOf: "2026-08-01",
      status: "complete",
      creditLimit: null,
    });
    expect(term?.missing).toEqual([]);
  });

  it("falls back to the amortization schedule when the loan has no snapshot", () => {
    const [term] = unifyDebtTermsFrom(
      sources({ accounts: [MORTGAGE], liabilities: [liability()] }),
      TODAY,
    );

    // Exactly 72 months elapsed (2020-08-15 → 2026-08-15). The origination
    // parameters fully determine the scheduled balance, so reporting
    // `unknown_input` for a loan whose terms we know exactly would be silly.
    expect(term?.balance).toBe("182795.91");
    expect(term?.balanceAsOf).toBeNull();
    expect(term?.status).toBe("complete");
  });

  it("does not count the current month until its anniversary day has passed", () => {
    const before = unifyDebtTermsFrom(
      sources({ accounts: [MORTGAGE], liabilities: [liability()] }),
      "2026-08-14",
    );
    const onDay = unifyDebtTermsFrom(
      sources({ accounts: [MORTGAGE], liabilities: [liability()] }),
      "2026-08-15",
    );

    // 71 months vs. 72 — the 71-month balance is strictly higher.
    expect(Number(before[0]?.balance)).toBeGreaterThan(Number(onDay[0]?.balance));
  });

  it("emits a loan with NO liabilities row as unknown_input, keeping its balance", () => {
    const [term] = unifyDebtTermsFrom(
      sources({
        accounts: [MORTGAGE],
        latestBalances: [{ accountId: MORTGAGE.id, date: "2026-08-01", balance: "-180500.00" }],
      }),
      TODAY,
    );

    expect(term).toMatchObject({ balance: "180500.00", apr: null, minimumPayment: null });
    expect(term?.status).toBe("unknown_input");
    expect(term?.missing).toEqual(["apr", "minimum_payment"]);
  });
});

describe("unifyDebtTermsFrom — the revolving branch", () => {
  it("carries APR, limit and the flat minimum through", () => {
    const [term] = unifyDebtTermsFrom(
      sources({
        accounts: [CARD],
        creditLines: [creditLine()],
        latestBalances: [{ accountId: CARD.id, date: "2026-08-10", balance: "-2400.00" }],
      }),
      TODAY,
    );

    expect(term).toMatchObject({
      kind: "revolving",
      apr: "0.249900",
      creditLimit: "15000.00",
      minimumPayment: "35.00",
      balance: "2400.00",
      status: "complete",
      termsUpdatedAt: UPDATED,
    });
  });

  it("takes the GREATER of the flat minimum and the percent-of-balance minimum", () => {
    const [big] = unifyDebtTermsFrom(
      sources({
        accounts: [CARD],
        creditLines: [creditLine({ minimumPaymentPercent: "2.0000" })],
        latestBalances: [{ accountId: CARD.id, date: "2026-08-10", balance: "-4000.00" }],
      }),
      TODAY,
    );
    // 2% of $4,000 = $80 > the $35 floor. Issuers bill exactly this way.
    expect(big?.minimumPayment).toBe("80.00");

    const [small] = unifyDebtTermsFrom(
      sources({
        accounts: [CARD],
        creditLines: [creditLine({ minimumPaymentPercent: "2.0000" })],
        latestBalances: [{ accountId: CARD.id, date: "2026-08-10", balance: "-500.00" }],
      }),
      TODAY,
    );
    // 2% of $500 = $10 < the $35 floor.
    expect(small?.minimumPayment).toBe("35.00");
  });

  it("clamps an overpaid card (a positive snapshot) to zero owed", () => {
    const [term] = unifyDebtTermsFrom(
      sources({
        accounts: [CARD],
        creditLines: [creditLine()],
        latestBalances: [{ accountId: CARD.id, date: "2026-08-10", balance: "120.00" }],
      }),
      TODAY,
    );
    // A credit balance is not a negative debt.
    expect(term?.balance).toBe("0.00");
  });

  it("reports a missing credit limit WITHOUT flipping status to unknown_input", () => {
    const [term] = unifyDebtTermsFrom(
      sources({
        accounts: [CARD],
        creditLines: [creditLine({ creditLimit: null })],
        latestBalances: [{ accountId: CARD.id, date: "2026-08-10", balance: "-2400.00" }],
      }),
      TODAY,
    );

    // The utilization rule needs the limit; the payoff simulator does not. A
    // card can be simulated to zero without knowing what it could have held.
    expect(term?.missing).toEqual(["credit_limit"]);
    expect(term?.status).toBe("complete");
  });

  it("emits a card with NO credit_lines row as unknown_input, never a 0% APR", () => {
    const [term] = unifyDebtTermsFrom(
      sources({
        accounts: [CARD],
        latestBalances: [{ accountId: CARD.id, date: "2026-08-10", balance: "-2400.00" }],
      }),
      TODAY,
    );

    // The snapshot proves the debt exists; hiding it would understate the
    // household's obligations, and defaulting the APR to 0 would sort a 25%
    // card to the back of the avalanche.
    expect(term).toMatchObject({ balance: "2400.00", apr: null, minimumPayment: null });
    expect(term?.status).toBe("unknown_input");
    expect(term?.missing).toEqual(["apr", "minimum_payment", "credit_limit"]);
  });

  it("emits a debt with neither terms nor a snapshot rather than dropping it", () => {
    const [term] = unifyDebtTermsFrom(sources({ accounts: [CARD] }), TODAY);

    expect(term?.balance).toBe("0.00");
    expect(term?.missing).toEqual(["balance", "apr", "minimum_payment", "credit_limit"]);
    expect(term?.status).toBe("unknown_input");
  });
});

describe("unifyDebtTermsFrom — the union", () => {
  it("ignores non-debt accounts and orders by descending balance", () => {
    const terms = unifyDebtTermsFrom(
      sources({
        accounts: [
          CARD,
          MORTGAGE,
          { id: "acct-cash", name: "Checking", institution: "M&T", type: "depository" },
          { id: "acct-inv", name: "401k", institution: "Fidelity", type: "investment" },
        ],
        liabilities: [liability()],
        creditLines: [creditLine()],
        latestBalances: [
          { accountId: MORTGAGE.id, date: "2026-08-01", balance: "-180500.00" },
          { accountId: CARD.id, date: "2026-08-10", balance: "-2400.00" },
          { accountId: "acct-cash", date: "2026-08-10", balance: "5000.00" },
        ],
      }),
      TODAY,
    );

    expect(terms).toHaveLength(2);
    expect(terms.map((t) => t.accountId)).toEqual([MORTGAGE.id, CARD.id]);
  });

  it("breaks balance ties on account name so the order is stable across runs", () => {
    const terms = unifyDebtTermsFrom(
      sources({
        accounts: [
          { id: "b", name: "Zeta Card", institution: "X", type: "credit_card" },
          { id: "a", name: "Alpha Card", institution: "X", type: "credit_card" },
        ],
        latestBalances: [
          { accountId: "a", date: "2026-08-10", balance: "-1000.00" },
          { accountId: "b", date: "2026-08-10", balance: "-1000.00" },
        ],
      }),
      TODAY,
    );

    // A list that reshuffles between page loads reads as broken even when every
    // figure on it is right.
    expect(terms.map((t) => t.accountName)).toEqual(["Alpha Card", "Zeta Card"]);
  });
});

describe("totalMinimumDebtService", () => {
  const terms = unifyDebtTermsFrom(
    sources({
      accounts: [MORTGAGE, CARD],
      liabilities: [liability()],
      creditLines: [creditLine()],
      latestBalances: [
        { accountId: MORTGAGE.id, date: "2026-08-01", balance: "-180500.00" },
        { accountId: CARD.id, date: "2026-08-10", balance: "-2400.00" },
      ],
    }),
    TODAY,
  );

  it("sums the known minimums", () => {
    expect(totalMinimumDebtService(terms)).toEqual({ total: "1234.10", unknownCount: 0 });
  });

  it("counts unpriced debts separately instead of treating them as zero", () => {
    const withUnpriced = unifyDebtTermsFrom(
      sources({
        accounts: [MORTGAGE, CARD],
        liabilities: [liability()],
        latestBalances: [
          { accountId: MORTGAGE.id, date: "2026-08-01", balance: "-180500.00" },
          { accountId: CARD.id, date: "2026-08-10", balance: "-2400.00" },
        ],
      }),
      TODAY,
    );

    // The total is honest about what it knows; `unknownCount` tells the UI the
    // essential baseline built on it is LOW.
    expect(totalMinimumDebtService(withUnpriced)).toEqual({
      total: "1199.10",
      unknownCount: 1,
    });
  });

  it("skips zero-balance debts — a paid-off card bills no minimum", () => {
    const paidOff = unifyDebtTermsFrom(
      sources({
        accounts: [CARD],
        creditLines: [creditLine()],
        latestBalances: [{ accountId: CARD.id, date: "2026-08-10", balance: "0.00" }],
      }),
      TODAY,
    );

    // Counting the stale $35 would inflate the essential baseline and, at six
    // months of reserve, the emergency-fund target by $210.
    expect(totalMinimumDebtService(paidOff)).toEqual({ total: "0.00", unknownCount: 0 });
  });
});
