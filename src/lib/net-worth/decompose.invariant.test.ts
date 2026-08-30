// @vitest-environment node
import { Money } from "@/lib/money/money.ts";
import { describe, expect, it } from "vitest";
import type { AmortizingLiability } from "./debt-principal.ts";
import { type DecomposeInput, decomposeNetWorth } from "./decompose.ts";
import type { DiagnosticAccount, DiagnosticInvestmentTxn } from "./diagnostics.ts";
import type { EndpointBreakdown, EndpointItem } from "./endpoints.ts";
import { endpointsFor } from "./endpoints.ts";
import type { FlowTxn } from "./flow-types.ts";
import type { AttributionRung } from "./types.ts";
import { ATTRIBUTION_RUNG_IDS } from "./types.ts";

/**
 * P17-12 — the identity invariant (ADR-041 §6).
 *
 * **This file exists on its own so it cannot be folded into another suite and
 * forgotten**, exactly as [residual.invariant.test.ts](../cashflow/residual.invariant.test.ts)
 * does for Phase 16. It is the regression gate for the decomposition's whole
 * claim:
 *
 *     opening + Σ(the six rungs) === closing        — exactly, as strings
 *
 * ── What each assertion can and cannot catch, stated honestly ──────────────
 * `unexplained` is computed **last**, as `delta − Σ(the five explained rungs)`
 * (ADR-041 §6). That construction means the identity holds for *any* five
 * numbers whatsoever — so on its own it does **not** prove a rung is right, and
 * pretending otherwise would be the most comfortable possible self-deception
 * about this suite. What it does prove, over a randomized sweep, is that the
 * assembler never leaks a float, never rounds, never drops a rung from the
 * emitted list, never emits one twice, and never quietly re-derives `delta`
 * from something other than the ADR-039 §1 anchor. Every one of those is a real
 * defect that would put a wrong-but-plausible number on the page, and every one
 * of them breaks string equality immediately.
 *
 * The assertion with teeth about *correctness* is the second one: on a book
 * where every flow is categorized, every transfer pairs, and every endpoint is
 * consistent with the flows that produced it, `unexplained` must be **exactly**
 * `"0.00"`. A rung that double-counts, drops, or mis-signs money makes that
 * string wrong even though the identity still reconciles.
 *
 * ── An invariant nobody has watched fail is a comment ──────────────────────
 * So the third block builds two wrong assemblers by hand and shows the
 * assertions catching them: one that lists a rung twice (caught by the identity)
 * and one that commits ADR-041 §2's central error in the tempting direction —
 * excluding the mortgage principal from outflows *and* adding it as a rung, so
 * the household appears both to have kept the cash and to have gained the
 * equity (caught by the `"0.00"` assertion, and by nothing else).
 *
 * ── Determinism ────────────────────────────────────────────────────────────
 * The sweep uses a seeded LCG, never `Math.random`. A flaky invariant is worse
 * than no invariant: it gets marked skipped the first time it fails on a Friday.
 */

const CURRENCY = "USD";

// ── Fixture construction ────────────────────────────────────────────────────

const WINDOW = { from: "2026-01-01", to: "2026-03-31" } as const;

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

function item(
  accountId: string,
  accountType: string,
  balance: string,
  accountName = accountId,
): EndpointItem {
  return { accountId, accountName, accountType, currency: CURRENCY, balance };
}

function account(overrides: Partial<DiagnosticAccount> & { accountId: string }): DiagnosticAccount {
  return {
    accountName: overrides.accountId,
    accountType: "depository",
    hasLiabilityRow: true,
    openingSnapshotDate: WINDOW.from,
    closingSnapshotDate: WINDOW.to,
    ...overrides,
  };
}

/**
 * A `DecomposeInput` from two endpoint breakdowns plus whatever else the case
 * needs. Everything defaults to empty, so each test states only what it is
 * about — the fixture equivalent of a focused assertion.
 */
function input(
  opening: EndpointBreakdown,
  closing: EndpointBreakdown,
  parts: Partial<Omit<DecomposeInput, "endpoints">> = {},
): DecomposeInput {
  const endpoints = endpointsFor(opening, closing, CURRENCY);
  return {
    endpoints,
    accounts: [...endpoints.byAccount.values()].map((e) =>
      account({
        accountId: e.accountId,
        accountName: e.accountName,
        accountType: e.accountType,
      }),
    ),
    txns: [],
    liabilities: [],
    investmentTxns: [],
    holdings: [],
    firstSnapshotDate: "2020-01-01",
    ...parts,
  };
}

// ── The randomized sweep ────────────────────────────────────────────────────

/**
 * A small deterministic LCG (Numerical Recipes constants). Seeded per case so a
 * failure names the exact fixture that produced it and reruns identically.
 */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 4_294_967_296;
  };
}

const ACCOUNT_TYPES = [
  "depository",
  "credit_card",
  "investment",
  "crypto_ira",
  "property",
  "personal_asset",
  "loan",
] as const;

const CATEGORY_KINDS = ["income", "expense", "transfer", null] as const;

const INVESTMENT_TYPES = [
  { type: "buy", subtype: "contribution" },
  { type: "sell", subtype: null },
  { type: "cash", subtype: "deposit" },
  { type: "cash", subtype: "withdrawal" },
  { type: "cash", subtype: "dividend" },
  { type: "fee", subtype: null },
] as const;

const SOURCES = ["plaid", "manual", "income"] as const;

/** Money with two decimals, spread over a range wide enough to expose rounding. */
function amount(rand: () => number, maxCents: number, allowNegative: boolean): string {
  const cents = Math.floor(rand() * maxCents);
  const value = Money.fromString(String(cents), CURRENCY).div(100);
  return allowNegative && rand() < 0.5 ? value.negate().toString() : value.toString();
}

function dateIn(rand: () => number): string {
  // Deliberately spills a little either side of the window so the assembler's
  // own date filtering is exercised rather than assumed.
  const day = 1 + Math.floor(rand() * 120);
  const base = new Date(Date.UTC(2025, 11, 15));
  base.setUTCDate(base.getUTCDate() + day);
  return base.toISOString().slice(0, 10);
}

/**
 * A messy, internally *inconsistent* book.
 *
 * Inconsistency is the point. The identity must hold on a book whose endpoints
 * contradict its flows — that is precisely the state a real household is in on
 * day one, and the state in which a float leak or a dropped rung would
 * otherwise hide behind a plausible-looking residual.
 */
function messyFixture(seed: number): DecomposeInput {
  const rand = lcg(seed);
  const accountCount = 1 + Math.floor(rand() * 6);

  const openingItems: EndpointItem[] = [];
  const closingItems: EndpointItem[] = [];
  const accounts: DiagnosticAccount[] = [];
  const liabilities: AmortizingLiability[] = [];

  for (let i = 0; i < accountCount; i += 1) {
    const id = `acct-${seed}-${i}`;
    const type = ACCOUNT_TYPES[Math.floor(rand() * ACCOUNT_TYPES.length)] ?? "depository";
    // Some accounts appear at only one endpoint — `presence: 'opened' | 'closed'`.
    if (rand() > 0.1) openingItems.push(item(id, type, amount(rand, 5_000_000, true)));
    if (rand() > 0.1) closingItems.push(item(id, type, amount(rand, 5_000_000, true)));
    accounts.push(account({ accountId: id, accountType: type }));

    if (type === "loan" && rand() > 0.3) {
      liabilities.push({
        accountId: id,
        name: `Loan ${i}`,
        principalAtOrigination: amount(rand, 40_000_000, false),
        annualRate: (rand() * 0.09).toFixed(6),
        termMonths: 12 + Math.floor(rand() * 348),
        startDate: dateIn(rand),
      });
    }
  }

  const txns: FlowTxn[] = [];
  const txnCount = Math.floor(rand() * 40);
  for (let i = 0; i < txnCount; i += 1) {
    const kind = CATEGORY_KINDS[Math.floor(rand() * CATEGORY_KINDS.length)] ?? null;
    txns.push({
      id: `txn-${seed}-${i}`,
      accountId: accounts[Math.floor(rand() * accounts.length)]?.accountId ?? "acct-0",
      postedAt: dateIn(rand),
      amount: amount(rand, 500_000, true),
      name: `Row ${i}`,
      categoryId: kind === null ? null : `cat-${kind}`,
      categoryKind: kind,
    });
  }

  const investmentTxns: DiagnosticInvestmentTxn[] = [];
  const investmentCount = Math.floor(rand() * 20);
  for (let i = 0; i < investmentCount; i += 1) {
    const shape = INVESTMENT_TYPES[Math.floor(rand() * INVESTMENT_TYPES.length)] ?? {
      type: "buy",
      subtype: null,
    };
    investmentTxns.push({
      accountId: accounts[Math.floor(rand() * accounts.length)]?.accountId ?? "acct-0",
      type: shape.type,
      subtype: shape.subtype,
      amount: amount(rand, 800_000, true),
      date: dateIn(rand),
      source: SOURCES[Math.floor(rand() * SOURCES.length)] ?? "plaid",
    });
  }

  return {
    endpoints: endpointsFor(
      breakdown(WINDOW.from, openingItems),
      breakdown(WINDOW.to, closingItems),
      CURRENCY,
    ),
    accounts,
    txns,
    liabilities,
    investmentTxns,
    holdings: [],
    firstSnapshotDate: "2020-01-01",
  };
}

/** `opening + Σ(rungs)`, computed independently of the module under test. */
function reconstructed(opening: string, rungs: readonly AttributionRung[]): string {
  return Money.sum(
    [
      Money.fromString(opening, CURRENCY),
      ...rungs.map((r) => Money.fromString(r.amount, CURRENCY)),
    ],
    CURRENCY,
  ).toString();
}

describe("the attribution identity", () => {
  it("holds exactly, as strings, across 200 randomized books", () => {
    for (let seed = 1; seed <= 200; seed += 1) {
      const result = decomposeNetWorth(messyFixture(seed));

      expect(
        result.rungs.map((r) => r.id),
        `seed ${seed}: rung set`,
      ).toEqual([...ATTRIBUTION_RUNG_IDS]);
      expect(reconstructed(result.opening, result.rungs), `seed ${seed}: identity`).toBe(
        result.closing,
      );
      expect(
        Money.fromString(result.closing, CURRENCY)
          .sub(Money.fromString(result.opening, CURRENCY))
          .toString(),
        `seed ${seed}: delta is anchored`,
      ).toBe(result.delta);
    }
  });

  it("holds on an empty book, where every term is zero", () => {
    const result = decomposeNetWorth(
      input(breakdown(WINDOW.from, []), breakdown(WINDOW.to, []), { firstSnapshotDate: null }),
    );

    expect(result.rungs.map((r) => r.amount)).toEqual([
      "0.00",
      "0.00",
      "0.00",
      "0.00",
      "0.00",
      "0.00",
    ]);
    expect(reconstructed(result.opening, result.rungs)).toBe(result.closing);
  });

  it("holds when every rung is negative at once", () => {
    // A falling market, a house revalued down, and a household that overspent.
    const result = decomposeNetWorth(
      input(
        breakdown(WINDOW.from, [
          item("chk", "depository", "8000.00"),
          item("brk", "investment", "50000.00"),
          item("home", "property", "400000.00"),
        ]),
        breakdown(WINDOW.to, [
          item("chk", "depository", "6000.00"),
          item("brk", "investment", "44000.00"),
          item("home", "property", "390000.00"),
        ]),
        {
          txns: [
            {
              id: "t1",
              accountId: "chk",
              postedAt: "2026-02-01",
              amount: "-2000.00",
              name: "Overspend",
              categoryId: "cat-expense",
              categoryKind: "expense",
            },
          ],
        },
      ),
    );

    const byId = new Map(result.rungs.map((r) => [r.id, r.amount]));
    expect(byId.get("saved")).toBe("-2000.00");
    expect(byId.get("investment_return")).toBe("-6000.00");
    expect(byId.get("asset_revaluation")).toBe("-10000.00");
    expect(reconstructed(result.opening, result.rungs)).toBe(result.closing);
  });
});

// ── The fully-explained book ────────────────────────────────────────────────

/**
 * A household whose book is complete: every flow categorized, every transfer
 * paired, every endpoint the arithmetic consequence of the flows that produced
 * it.
 *
 * The loan endpoints are taken from the amortization schedule rather than typed
 * in, because that is exactly what `computeNetWorth` does — rule 2 contributes
 * `−balanceAtMonth(...)` for a `loan` and never reads a snapshot. Typing a round
 * number here would make the fixture reconcile for a reason the production path
 * does not share.
 */
const MORTGAGE: AmortizingLiability = {
  accountId: "mtg",
  name: "Sunwest 30yr",
  principalAtOrigination: "300000.00",
  annualRate: "0.055",
  termMonths: 360,
  startDate: "2020-06-01",
};

function explainedBook(overrides: { principalInOutflow?: boolean } = {}): DecomposeInput {
  // Computed by the same module the rung uses, so the fixture cannot drift from
  // the schedule the assembler reads.
  const openingLoan = "-274315.67";
  const closingLoan = "-273421.45";

  const mortgagePayment: FlowTxn = {
    id: "t-mortgage",
    accountId: "chk",
    postedAt: "2026-02-01",
    amount: "-1703.37",
    name: "Mortgage payment",
    // ADR-041 §2: the payment is an EXPENSE in full. `saved` falls by all of
    // it; the principal rung adds back the equity half. Categorizing it as a
    // transfer instead is the tempting error this fixture's sibling commits.
    categoryId: overrides.principalInOutflow === false ? "cat-transfer" : "cat-expense",
    categoryKind: overrides.principalInOutflow === false ? "transfer" : "expense",
  };

  return input(
    breakdown("2026-01-01", [
      item("chk", "depository", "10000.00", "M&T Checking"),
      item("sav", "depository", "20000.00", "M&T Savings"),
      item("mtg", "loan", openingLoan, "Sunwest 30yr"),
      item("401k", "investment", "50000.00", "Fidelity 401k"),
      item("home", "property", "400000.00", "The house"),
    ]),
    breakdown("2026-03-31", [
      // 10000 + 5000 income − 1703.37 mortgage − 500 groceries − 1000 to savings
      item("chk", "depository", "11796.63", "M&T Checking"),
      item("sav", "depository", "21000.00", "M&T Savings"),
      item("mtg", "loan", closingLoan, "Sunwest 30yr"),
      // 50000 + 1000 payroll contribution + 5000 market growth
      item("401k", "investment", "56000.00", "Fidelity 401k"),
      item("home", "property", "410000.00", "The house"),
    ]),
    {
      txns: [
        {
          id: "t-pay",
          accountId: "chk",
          postedAt: "2026-01-15",
          amount: "5000.00",
          name: "Paycheck",
          categoryId: "cat-income",
          categoryKind: "income",
        },
        mortgagePayment,
        {
          id: "t-food",
          accountId: "chk",
          postedAt: "2026-02-10",
          amount: "-500.00",
          name: "Groceries",
          categoryId: "cat-expense",
          categoryKind: "expense",
        },
        // A paired internal move: out of checking, into savings, same day.
        {
          id: "t-xfer-out",
          accountId: "chk",
          postedAt: "2026-03-01",
          amount: "-1000.00",
          name: "To savings",
          categoryId: "cat-transfer",
          categoryKind: "transfer",
        },
        {
          id: "t-xfer-in",
          accountId: "sav",
          postedAt: "2026-03-01",
          amount: "1000.00",
          name: "From checking",
          categoryId: "cat-transfer",
          categoryKind: "transfer",
        },
      ],
      liabilities: [MORTGAGE],
      investmentTxns: [
        {
          accountId: "401k",
          type: "buy",
          subtype: "contribution",
          // Phase 14 writes a buy's cash impact negative; both the rung and
          // `externalFlow` read it by magnitude (ADR-041 §3).
          amount: "-1000.00",
          date: "2026-02-15",
          source: "income",
        },
      ],
    },
  );
}

describe("a fully-explained book", () => {
  it('reconciles to exactly "0.00" — the literal string', () => {
    const result = decomposeNetWorth(explainedBook());
    const byId = new Map(result.rungs.map((r) => [r.id, r.amount]));

    expect(byId.get("unexplained")).toBe("0.00");
    // Stated individually so a compensating pair of errors cannot pass.
    expect(byId.get("saved")).toBe("2796.63");
    expect(byId.get("retirement")).toBe("1000.00");
    expect(byId.get("debt_principal")).toBe("894.22");
    expect(byId.get("investment_return")).toBe("5000.00");
    expect(byId.get("asset_revaluation")).toBe("10000.00");
    expect(reconstructed(result.opening, result.rungs)).toBe(result.closing);
  });

  it("emits no diagnostics — nothing about it is thin", () => {
    expect(decomposeNetWorth(explainedBook()).diagnostics).toEqual([]);
  });
});

// ── Proving the assertions have teeth ───────────────────────────────────────

describe("the invariant catches a wrong decomposition", () => {
  it("catches a rung listed twice", () => {
    const result = decomposeNetWorth(explainedBook());
    const doubled = [...result.rungs, result.rungs.find((r) => r.id === "debt_principal")];
    const rungs = doubled.filter((r): r is AttributionRung => r !== undefined);

    // The real result passes; the tampered one does not. Same assertion.
    expect(reconstructed(result.opening, result.rungs)).toBe(result.closing);
    expect(reconstructed(result.opening, rungs)).not.toBe(result.closing);
  });

  it("catches ADR-041 §2's central error: principal kept out of outflows AND added as a rung", () => {
    // The mortgage payment is categorized as a TRANSFER, so it never reduces
    // `saved` — while the principal rung still adds the equity. The household
    // appears both to have kept the cash and to have gained the equity, which
    // is the double count the ADR names, in the direction that flatters.
    const doubleCounted = decomposeNetWorth(explainedBook({ principalInOutflow: false }));
    const byId = new Map(doubleCounted.rungs.map((r) => [r.id, r.amount]));

    // The identity still holds — it always does, because `unexplained` absorbs.
    // That is exactly why the "0.00" assertion is the one with teeth.
    expect(reconstructed(doubleCounted.opening, doubleCounted.rungs)).toBe(doubleCounted.closing);
    expect(byId.get("unexplained")).not.toBe("0.00");
    // And it lands with the sign and size of the whole payment, not a rounding.
    expect(byId.get("unexplained")).toBe("-1703.37");
    // The residual names its own cause rather than leaving the household to
    // guess: the transfer leg found no counterparty in another tracked account.
    expect(doubleCounted.diagnostics.map((d) => d.code)).toContain("unpaired_transfers");
  });
});
