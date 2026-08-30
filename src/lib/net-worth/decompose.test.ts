// @vitest-environment node
import { Money } from "@/lib/money/money.ts";
import { describe, expect, it } from "vitest";
import type { AmortizingLiability } from "./debt-principal.ts";
import { type DecomposeInput, decomposeNetWorth } from "./decompose.ts";
import type { DiagnosticAccount, DiagnosticInvestmentTxn } from "./diagnostics.ts";
import { type EndpointBreakdown, type EndpointItem, endpointsFor } from "./endpoints.ts";
import type { FlowTxn } from "./flow-types.ts";
import type { AttributionRungId } from "./types.ts";

/**
 * P17-13 — rung-level regressions (ADR-041 §2).
 *
 * **A correct total with two wrong rungs still reconciles.** The identity in
 * [decompose.invariant.test.ts](./decompose.invariant.test.ts) cannot see that,
 * because `unexplained` is a residual and absorbs anything — so every case here
 * asserts the rungs *individually*, by name, and the sum is the least
 * interesting assertion in the file.
 *
 * The four cases the plan names are the four ways money can move between rungs
 * while the page still looks right: a mortgage payment (`saved` vs.
 * `debt_principal`), a payroll contribution (`retirement` vs.
 * `investment_return`), an internal transfer (which must move *nothing*), and a
 * revaluation with no transaction behind it at all.
 */

const CURRENCY = "USD";
const WINDOW = { from: "2026-01-01", to: "2026-03-31" } as const;

function item(
  accountId: string,
  accountType: string,
  balance: string,
  accountName = accountId,
): EndpointItem {
  return { accountId, accountName, accountType, currency: CURRENCY, balance };
}

function breakdown(asOf: string, items: readonly EndpointItem[]): EndpointBreakdown {
  return {
    asOf,
    total: Money.sum(
      items.map((i) => Money.fromString(i.balance, CURRENCY)),
      CURRENCY,
    ).toString(),
    items,
  };
}

function book(
  opening: readonly EndpointItem[],
  closing: readonly EndpointItem[],
  parts: Partial<Omit<DecomposeInput, "endpoints">> = {},
): DecomposeInput {
  const endpoints = endpointsFor(
    breakdown(WINDOW.from, opening),
    breakdown(WINDOW.to, closing),
    CURRENCY,
  );
  const accounts: DiagnosticAccount[] = [...endpoints.byAccount.values()].map((e) => ({
    accountId: e.accountId,
    accountName: e.accountName,
    accountType: e.accountType,
    hasLiabilityRow: true,
    openingSnapshotDate: WINDOW.from,
    closingSnapshotDate: WINDOW.to,
  }));

  return {
    endpoints,
    accounts,
    txns: [],
    liabilities: [],
    investmentTxns: [],
    holdings: [],
    firstSnapshotDate: "2020-01-01",
    ...parts,
  };
}

/** The rungs as a lookup, which is how every assertion below reads them. */
function rungs(input: DecomposeInput): Record<AttributionRungId, string> {
  const result = decomposeNetWorth(input);
  return Object.fromEntries(result.rungs.map((r) => [r.id, r.amount])) as Record<
    AttributionRungId,
    string
  >;
}

const MORTGAGE: AmortizingLiability = {
  accountId: "mtg",
  name: "Sunwest 30yr",
  principalAtOrigination: "300000.00",
  annualRate: "0.055",
  termMonths: 360,
  startDate: "2020-06-01",
};

/** The schedule's own figures for {@link WINDOW}, so the fixture cannot drift. */
const MORTGAGE_OPENING = "-274315.67";
const MORTGAGE_CLOSING = "-273421.45";
const MORTGAGE_PRINCIPAL = "894.22";

describe("a mortgage payment", () => {
  const input = book(
    [item("chk", "depository", "10000.00"), item("mtg", "loan", MORTGAGE_OPENING)],
    [item("chk", "depository", "8296.63"), item("mtg", "loan", MORTGAGE_CLOSING)],
    {
      txns: [
        {
          id: "t-mortgage",
          accountId: "chk",
          postedAt: "2026-02-01",
          amount: "-1703.37",
          name: "Mortgage payment",
          categoryId: "cat-expense",
          categoryKind: "expense",
        },
      ],
      liabilities: [MORTGAGE],
    },
  );

  it("reduces `saved` by the FULL payment, not the interest portion", () => {
    // ADR-041 §2. The app has no principal/interest split on a transaction, and
    // inventing one here would move $894 between two rungs while the total
    // still reconciled — the exact defect this file exists to catch.
    expect(rungs(input).saved).toBe("-1703.37");
  });

  it("adds the principal back as its own rung, from the schedule", () => {
    expect(rungs(input).debt_principal).toBe(MORTGAGE_PRINCIPAL);
  });

  it("nets to the interest — what paying a mortgage actually costs", () => {
    const r = rungs(input);
    const net = Money.fromString(r.saved, CURRENCY).add(
      Money.fromString(r.debt_principal, CURRENCY),
    );
    expect(net.toString()).toBe("-809.15");
    expect(r.unexplained).toBe("0.00");
  });

  it("counts no principal for a loan with no recorded terms", () => {
    // `computeNetWorth` skips such a loan at BOTH endpoints, so it moves
    // neither the delta nor this rung — consistent, and named by a diagnostic
    // rather than papered over.
    const r = rungs(
      book([item("chk", "depository", "10000.00")], [item("chk", "depository", "10000.00")], {}),
    );
    expect(r.debt_principal).toBe("0.00");
  });
});

describe("a payroll-direct 401k contribution", () => {
  const contribution: DiagnosticInvestmentTxn = {
    accountId: "401k",
    type: "buy",
    subtype: "contribution",
    amount: "-1000.00",
    date: "2026-02-15",
    source: "income",
  };

  const input = book(
    [item("401k", "investment", "50000.00")],
    [item("401k", "investment", "56000.00")],
    { investmentTxns: [contribution] },
  );

  it("moves the retirement rung by the contribution", () => {
    expect(rungs(input).retirement).toBe("1000.00");
  });

  it("keeps the contribution OUT of investment return", () => {
    // The account gained $6,000; $1,000 of it the household put there.
    expect(rungs(input).investment_return).toBe("5000.00");
  });

  it("leaves nothing unexplained — the two cancel by construction (ADR-041 §3)", () => {
    expect(rungs(input).unexplained).toBe("0.00");
  });

  it("does NOT re-add a brokerage deposit funded from tracked cash", () => {
    // Same shape, `source='manual'`: the money came from a checking account the
    // app can already see, so re-adding it would count it twice.
    const funded = book(
      [item("brk", "investment", "50000.00")],
      [item("brk", "investment", "56000.00")],
      { investmentTxns: [{ ...contribution, accountId: "brk", source: "manual" }] },
    );
    expect(rungs(funded).retirement).toBe("0.00");
    expect(rungs(funded).investment_return).toBe("5000.00");
  });

  it("surfaces the one shape where the cancellation does not hold", () => {
    // A `source='income'` row whose TYPE is not an external flow — a fee, say.
    // The retirement rung counts it by source; `externalFlow` returns null, so
    // `attribution()` never subtracted it and there is nothing to cancel. The
    // shipped contribution job writes only `buy`/`cash-deposit` rows, so this
    // cannot arise today; it is pinned here because the cancellation is a
    // coupling between two modules, and a coupling nobody tested is a coupling
    // that breaks silently. It lands in the residual, visibly, which is the
    // correct failure mode.
    const odd = book(
      [item("401k", "investment", "10000.00")],
      [item("401k", "investment", "10000.00")],
      { investmentTxns: [{ ...contribution, type: "fee", subtype: null, amount: "-50.00" }] },
    );
    expect(rungs(odd).retirement).toBe("50.00");
    expect(rungs(odd).investment_return).toBe("0.00");
    expect(rungs(odd).unexplained).toBe("-50.00");
  });
});

describe("a checking → brokerage transfer", () => {
  const legs: FlowTxn[] = [
    {
      id: "t-out",
      accountId: "chk",
      postedAt: "2026-02-01",
      amount: "-1000.00",
      name: "To brokerage",
      categoryId: "cat-transfer",
      categoryKind: "transfer",
    },
  ];

  it("moves no rung at all when the brokerage records the deposit", () => {
    const r = rungs(
      book(
        [item("chk", "depository", "5000.00"), item("brk", "investment", "10000.00")],
        [item("chk", "depository", "4000.00"), item("brk", "investment", "11000.00")],
        {
          txns: legs,
          investmentTxns: [
            {
              accountId: "brk",
              type: "cash",
              subtype: "deposit",
              amount: "1000.00",
              date: "2026-02-01",
              source: "manual",
            },
          ],
        },
      ),
    );

    // Money that never crossed the household boundary moved nothing.
    expect(r).toEqual({
      saved: "0.00",
      retirement: "0.00",
      debt_principal: "0.00",
      investment_return: "0.00",
      asset_revaluation: "0.00",
      unexplained: "0.00",
    });
  });

  it("lands in the residual — not in a rung — when the deposit was never recorded", () => {
    // Without the investment row, `attribution()` has no flow to subtract and
    // reads the arrival as market growth. The identity still holds; the
    // residual is what says the book is thin, and a diagnostic names the leg.
    const result = decomposeNetWorth(
      book(
        [item("chk", "depository", "5000.00"), item("brk", "investment", "10000.00")],
        [item("chk", "depository", "4000.00"), item("brk", "investment", "11000.00")],
        { txns: legs },
      ),
    );
    const byId = new Map(result.rungs.map((r) => [r.id, r.amount]));

    expect(byId.get("investment_return")).toBe("1000.00");
    expect(byId.get("unexplained")).toBe("-1000.00");
    expect(result.diagnostics.map((d) => d.code)).toContain("unpaired_transfers");
  });

  it("is internal, not spending, when both legs are tracked", () => {
    const r = rungs(
      book(
        [item("chk", "depository", "5000.00"), item("sav", "depository", "2000.00")],
        [item("chk", "depository", "4000.00"), item("sav", "depository", "3000.00")],
        {
          txns: [
            ...legs,
            {
              id: "t-in",
              accountId: "sav",
              postedAt: "2026-02-01",
              amount: "1000.00",
              name: "From checking",
              categoryId: "cat-transfer",
              categoryKind: "transfer",
            },
          ],
        },
      ),
    );
    expect(r.saved).toBe("0.00");
    expect(r.unexplained).toBe("0.00");
  });

  it("is reported as PAIRED, not merely as money that moved no rung", () => {
    // `saved` is "0.00" either way — an unpaired transfer is excluded from the
    // rung just as an internal one is — so the rung alone cannot tell the two
    // apart. The difference the household sees is whether the app says it is
    // guessing, and that is what this pins.
    const result = decomposeNetWorth(
      book(
        [item("chk", "depository", "5000.00"), item("sav", "depository", "2000.00")],
        [item("chk", "depository", "4000.00"), item("sav", "depository", "3000.00")],
        {
          txns: [
            ...legs,
            {
              id: "t-in",
              accountId: "sav",
              postedAt: "2026-02-01",
              amount: "1000.00",
              name: "From checking",
              categoryId: "cat-transfer",
              categoryKind: "transfer",
            },
          ],
        },
      ),
    );
    const saved = result.rungs.find((r) => r.id === "saved");
    const row = saved?.inputsUsed.find((i) => i.label === "Unpaired transfers");

    expect(row?.value).toBe("0.00");
    expect(row?.missing).toBeUndefined();
    expect(result.diagnostics.map((d) => d.code)).not.toContain("unpaired_transfers");
  });
});

describe("a property revaluation", () => {
  it("is the whole story when there are no transactions at all", () => {
    const r = rungs(
      book([item("home", "property", "400000.00")], [item("home", "property", "415000.00")]),
    );
    expect(r.asset_revaluation).toBe("15000.00");
    expect(r.saved).toBe("0.00");
    expect(r.unexplained).toBe("0.00");
  });

  it("reads a downward revaluation as a negative rung, never a floor at zero", () => {
    const r = rungs(
      book(
        [item("truck", "personal_asset", "30000.00")],
        [item("truck", "personal_asset", "24000.00")],
      ),
    );
    expect(r.asset_revaluation).toBe("-6000.00");
  });

  it("does not claim an investment account's movement as revaluation", () => {
    const r = rungs(
      book([item("brk", "investment", "10000.00")], [item("brk", "investment", "12000.00")]),
    );
    expect(r.asset_revaluation).toBe("0.00");
    expect(r.investment_return).toBe("2000.00");
  });
});

describe("the assembled result", () => {
  const input = book(
    [item("chk", "depository", "10000.00", "M&T Checking")],
    [item("chk", "depository", "12000.00", "M&T Checking")],
    {
      txns: [
        {
          id: "t-pay",
          accountId: "chk",
          postedAt: "2026-01-15",
          amount: "2000.00",
          name: "Paycheck",
          categoryId: "cat-income",
          categoryKind: "income",
        },
      ],
    },
  );

  it("carries the window and the anchored endpoints unchanged", () => {
    const result = decomposeNetWorth(input);
    expect(result.from).toBe(WINDOW.from);
    expect(result.to).toBe(WINDOW.to);
    expect(result.opening).toBe("10000.00");
    expect(result.closing).toBe("12000.00");
    expect(result.delta).toBe("2000.00");
  });

  it("gives every rung an audit trail, including `unexplained`", () => {
    for (const rung of decomposeNetWorth(input).rungs) {
      expect(rung.inputsUsed.length, `${rung.id} has inputs`).toBeGreaterThan(0);
      expect(rung.label.length, `${rung.id} has a label`).toBeGreaterThan(0);
    }
  });

  it('never uses the word "unexplained" as a user-facing label', () => {
    const labels = decomposeNetWorth(input).rungs.map((r) => r.label.toLowerCase());
    expect(labels.some((l) => l.includes("unexplained"))).toBe(false);
  });

  it("names the uncategorized volume beside `saved`, with somewhere to go", () => {
    const withGap = decomposeNetWorth(
      book([item("chk", "depository", "10000.00")], [item("chk", "depository", "9000.00")], {
        txns: [
          {
            id: "t-mystery",
            accountId: "chk",
            postedAt: "2026-02-01",
            amount: "-1000.00",
            name: "Unknown",
            categoryId: null,
            categoryKind: null,
          },
        ],
      }),
    );
    const saved = withGap.rungs.find((r) => r.id === "saved");
    const row = saved?.inputsUsed.find((i) => i.label === "Uncategorized transactions");

    expect(row?.value).toBe("1");
    expect(row?.missing).toBe(true);
    expect(row?.href).toBe("/analysis/review");
  });

  it("reports the window's own inputs, including the account and row counts", () => {
    const labels = decomposeNetWorth(input).inputsUsed.map((i) => i.label);
    expect(labels).toEqual([
      "Net worth at the start",
      "Net worth at the end",
      "Accounts counted",
      "Transactions read",
    ]);
  });

  it("appends the missing input when the status is degraded", () => {
    const degraded = decomposeNetWorth({ ...input, firstSnapshotDate: null });
    expect(degraded.status).toBe("no_snapshots");
    expect(degraded.inputsUsed.at(-1)?.label).toBe("Recorded account balances");
  });

  it("ignores transactions posted outside the window", () => {
    const spilled = rungs({
      ...input,
      txns: [
        ...input.txns,
        {
          id: "t-before",
          accountId: "chk",
          postedAt: "2025-12-31",
          amount: "9999.00",
          name: "Last year",
          categoryId: "cat-income",
          categoryKind: "income",
        },
      ],
    });
    expect(spilled.saved).toBe("2000.00");
  });

  it("ignores an investment transaction dated outside the window", () => {
    const spilled = rungs(
      book([item("401k", "investment", "50000.00")], [item("401k", "investment", "50000.00")], {
        investmentTxns: [
          {
            accountId: "401k",
            type: "buy",
            subtype: "contribution",
            amount: "-1000.00",
            date: "2025-12-20",
            source: "income",
          },
        ],
      }),
    );
    expect(spilled.retirement).toBe("0.00");
  });

  it("honours the caller's pairing tolerances rather than always defaulting", () => {
    // Nine days apart: paired under the shipped tolerance, unpaired under a
    // tighter one. The rungs do not move either way — both legs are tracked —
    // but the diagnostic does, which is how the household learns the app is
    // guessing less than it could.
    const legs: FlowTxn[] = [
      {
        id: "t-out",
        accountId: "chk",
        postedAt: "2026-02-01",
        amount: "-1000.00",
        name: "To savings",
        categoryId: "cat-transfer",
        categoryKind: "transfer",
      },
      {
        id: "t-in",
        accountId: "sav",
        postedAt: "2026-02-05",
        amount: "1000.00",
        name: "From checking",
        categoryId: "cat-transfer",
        categoryKind: "transfer",
      },
    ];
    const accounts = [item("chk", "depository", "5000.00"), item("sav", "depository", "2000.00")];
    const closed = [item("chk", "depository", "4000.00"), item("sav", "depository", "3000.00")];

    const loose = decomposeNetWorth(book(accounts, closed, { txns: legs }));
    const tight = decomposeNetWorth(
      book(accounts, closed, { txns: legs, pairing: { windowDays: 1, amountAbs: "0.00" } }),
    );

    expect(loose.diagnostics.map((d) => d.code)).not.toContain("unpaired_transfers");
    expect(tight.diagnostics.map((d) => d.code)).toContain("unpaired_transfers");
  });

  it("throws on a backwards window rather than inverting every sign", () => {
    const backwards = endpointsFor(
      breakdown("2026-01-01", []),
      breakdown("2026-03-31", []),
      CURRENCY,
    );
    expect(() =>
      decomposeNetWorth({
        ...book([], []),
        endpoints: { ...backwards, from: "2026-03-31", to: "2026-01-01" },
      }),
    ).toThrow(/backwards/);
  });
});
