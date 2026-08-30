// @vitest-environment node
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ClassifiedFlow } from "./boundary.ts";
import {
  type DiagnosticAccount,
  type DiagnosticInvestmentTxn,
  type DiagnosticsInput,
  type HoldingQuantity,
  STALE_SNAPSHOT_DAYS,
  residualDiagnostics,
} from "./diagnostics.ts";
import type { AccountEndpoint } from "./endpoints.ts";
import type { SavedResult } from "./saved.ts";
import { RESIDUAL_DIAGNOSTIC_CODES, type ResidualDiagnosticCode } from "./types.ts";

/**
 * P17-16/17 — making `unexplained` name its own causes.
 *
 * Every suite here is built the same way: start from {@link cleanInput}, which
 * is a book with nothing wrong, and break exactly one thing. That shape is the
 * assertion — a diagnostic that fires on a clean book is a false alarm the
 * household cannot act on, and a diagnostic that stays quiet when its own cause
 * is present is the residual going unexplained, which is the failure this whole
 * batch exists to prevent.
 *
 * The all-clean case is therefore not a formality: `[]` on a healthy book is
 * what makes a non-empty list mean something.
 */

const FROM = "2026-01-01";
const TO = "2026-03-31";

function endpoint(over: Partial<AccountEndpoint> = {}): AccountEndpoint {
  return {
    accountId: "checking",
    accountName: "M&T Checking",
    accountType: "depository",
    opening: "5000.00",
    closing: "6000.00",
    delta: "1000.00",
    presence: "both",
    ...over,
  };
}

function account(over: Partial<DiagnosticAccount> = {}): DiagnosticAccount {
  return {
    accountId: "checking",
    accountName: "M&T Checking",
    accountType: "depository",
    hasLiabilityRow: false,
    openingSnapshotDate: FROM,
    closingSnapshotDate: TO,
    ...over,
  };
}

function flow(over: Partial<ClassifiedFlow["txn"]> = {}): ClassifiedFlow {
  return {
    txn: {
      id: "t1",
      accountId: "checking",
      postedAt: "2026-02-01",
      amount: "-100.00",
      name: "Groceries",
      categoryId: "cat-1",
      categoryKind: "expense",
      ...over,
    },
    verdict: "outflow",
  };
}

function saved(over: Partial<SavedResult> = {}): SavedResult {
  return {
    saved: "1000.00",
    inflow: "4000.00",
    outflow: "3000.00",
    unpairedTransferVolume: "0.00",
    uncategorizedVolume: "0.00",
    uncategorizedCount: 0,
    ...over,
  };
}

function investmentTxn(over: Partial<DiagnosticInvestmentTxn> = {}): DiagnosticInvestmentTxn {
  return {
    accountId: "brokerage",
    type: "cash",
    subtype: "deposit",
    amount: "5000.00",
    date: "2026-02-10",
    source: "manual",
    ...over,
  };
}

function holding(over: Partial<HoldingQuantity> = {}): HoldingQuantity {
  return {
    holdingId: "h1",
    symbol: "VTI",
    accountId: "brokerage",
    openingQuantity: "100.00000000",
    openingValue: "20000.00",
    currentQuantity: "100.00000000",
    ...over,
  };
}

/** A book with nothing wrong: every diagnostic's cause absent. */
function cleanInput(over: Partial<DiagnosticsInput> = {}): DiagnosticsInput {
  return {
    from: FROM,
    to: TO,
    accounts: [account()],
    endpoints: new Map([["checking", endpoint()]]),
    saved: saved(),
    unpairedTransferCount: 0,
    classified: [flow()],
    investmentTxns: [],
    holdings: [],
    ...over,
  };
}

function codes(input: DiagnosticsInput): ResidualDiagnosticCode[] {
  return residualDiagnostics(input).map((d) => d.code);
}

function only(input: DiagnosticsInput, code: ResidualDiagnosticCode) {
  const found = residualDiagnostics(input);
  expect(found.map((d) => d.code)).toEqual([code]);
  const [diagnostic] = found;
  if (diagnostic === undefined) throw new Error(`expected a ${code} diagnostic`);
  return diagnostic;
}

describe("residualDiagnostics — the clean book", () => {
  it("returns nothing when every cause is absent", () => {
    // The load-bearing case. If this ever starts returning a diagnostic, every
    // other assertion in this file is measuring noise.
    expect(residualDiagnostics(cleanInput())).toEqual([]);
  });

  it("rejects a window that runs backwards", () => {
    expect(() => residualDiagnostics(cleanInput({ from: TO, to: FROM }))).toThrow();
  });
});

describe("uncategorized", () => {
  it("reports the volume and the count, and links to the review queue", () => {
    const diagnostic = only(
      cleanInput({ saved: saved({ uncategorizedVolume: "4200.00", uncategorizedCount: 3 }) }),
      "uncategorized",
    );

    expect(diagnostic.magnitude).toBe("4200.00");
    expect(diagnostic.detail).toContain("3 transactions");
    expect(diagnostic.href).toBe("/analysis/review");
  });

  it("says 'transaction' rather than 'transactions' for a single row", () => {
    // A diagnostic is a sentence a family member reads, not a log line.
    const diagnostic = only(
      cleanInput({ saved: saved({ uncategorizedVolume: "40.00", uncategorizedCount: 1 }) }),
      "uncategorized",
    );

    expect(diagnostic.detail).toContain("1 transaction ");
  });
});

describe("unpaired transfers", () => {
  it("names the untracked account rather than calling the money unexplained", () => {
    // ADR-040 consequence 2: the label is the finding. "Unexplained" would be
    // the residual explaining itself.
    const diagnostic = only(
      cleanInput({
        unpairedTransferCount: 2,
        saved: saved({ unpairedTransferVolume: "900.00" }),
      }),
      "unpaired_transfers",
    );

    expect(diagnostic.label).toBe("Transfers to accounts this app doesn't track");
    expect(diagnostic.magnitude).toBe("900.00");
  });

  it("stays quiet when every transfer paired", () => {
    // Volume without a count is not a finding: `savedFromFlows` reports the
    // volume of legs it skipped, and zero legs is zero problems.
    expect(codes(cleanInput({ saved: saved({ unpairedTransferVolume: "0.00" }) }))).toEqual([]);
  });
});

describe("manual-balance accounts", () => {
  it("fires when a cash account moved with no transactions in the window", () => {
    const diagnostic = only(
      cleanInput({
        accounts: [account({ accountId: "savings", accountName: "M&T Savings" })],
        endpoints: new Map([["savings", endpoint({ accountId: "savings" })]]),
        classified: [],
      }),
      "manual_balance_accounts",
    );

    expect(diagnostic.magnitude).toBe("1000.00");
    expect(diagnostic.detail).toContain("M&T Savings");
    expect(diagnostic.href).toBe("/accounts/savings");
  });

  it("does not fire when the account has transactions", () => {
    expect(codes(cleanInput())).toEqual([]);
  });

  it("does not fire when the balance did not move", () => {
    // "No transactions and no movement" is a dormant account, not a data gap.
    const flat = endpoint({ opening: "5000.00", closing: "5000.00", delta: "0.00" });
    expect(codes(cleanInput({ endpoints: new Map([["checking", flat]]), classified: [] }))).toEqual(
      [],
    );
  });

  it("ignores a property whose value moved without transactions", () => {
    // The `asset_revaluation` rung already explains this exactly. Flagging it
    // would tell a household its appraisal is a data problem.
    const property = account({
      accountId: "home",
      accountName: "Home",
      accountType: "property",
    });
    expect(
      codes(
        cleanInput({
          accounts: [property],
          endpoints: new Map([["home", endpoint({ accountId: "home", accountType: "property" })]]),
          classified: [],
        }),
      ),
    ).toEqual([]);
  });

  it("links to the account list when several accounts are implicated", () => {
    const diagnostic = only(
      cleanInput({
        accounts: [
          account({ accountId: "savings", accountName: "Savings" }),
          account({ accountId: "card", accountName: "Visa", accountType: "credit_card" }),
        ],
        endpoints: new Map([
          ["savings", endpoint({ accountId: "savings" })],
          ["card", endpoint({ accountId: "card", accountType: "credit_card", delta: "-250.00" })],
        ]),
        classified: [],
      }),
      "manual_balance_accounts",
    );

    // 1000 + |−250|: a magnitude, so the card's opposite direction still counts
    // as money the decomposition could not explain.
    expect(diagnostic.magnitude).toBe("1250.00");
    expect(diagnostic.href).toBe("/accounts");
  });
});

describe("snapshot gaps", () => {
  it("fires when an endpoint has no snapshot at all", () => {
    const diagnostic = only(
      cleanInput({ accounts: [account({ openingSnapshotDate: null })] }),
      "snapshot_gap",
    );

    // The larger endpoint balance, not the delta: when both ends read the same
    // stale row the delta is zero, which would sort the worst case last.
    expect(diagnostic.magnitude).toBe("6000.00");
  });

  it("fires when only the CLOSING endpoint has the gap", () => {
    // Both ends are checked, not just the first. A book that was well-recorded
    // in January and abandoned in March has a closing figure just as stale as
    // the other case has an opening one.
    expect(
      codes(cleanInput({ accounts: [account({ closingSnapshotDate: "2026-01-05" })] })),
    ).toEqual(["snapshot_gap"]);
  });

  it("fires when the newest snapshot predates the endpoint by more than the threshold", () => {
    const stale = account({ openingSnapshotDate: "2025-10-01" });
    expect(codes(cleanInput({ accounts: [stale] }))).toContain("snapshot_gap");
  });

  it("does not fire just inside the threshold", () => {
    // 2026-01-01 minus 45 days is 2025-11-17 — the last date that is not a gap.
    const borderline = account({ openingSnapshotDate: "2025-11-17" });
    expect(codes(cleanInput({ accounts: [borderline] }))).toEqual([]);
    expect(STALE_SNAPSHOT_DAYS).toBe(45);
  });

  it("ignores a loan, which never reads a snapshot", () => {
    const loan = account({
      accountId: "mortgage",
      accountName: "Sunwest 30yr",
      accountType: "loan",
      hasLiabilityRow: true,
      openingSnapshotDate: null,
      closingSnapshotDate: null,
    });
    expect(codes(cleanInput({ accounts: [account(), loan] }))).toEqual([]);
  });

  it("ignores an investment account, which is valued from holdings and prices", () => {
    const brokerage = account({
      accountId: "brokerage",
      accountName: "Fidelity",
      accountType: "investment",
      openingSnapshotDate: null,
      closingSnapshotDate: null,
    });
    expect(codes(cleanInput({ accounts: [account(), brokerage] }))).toEqual([]);
  });
});

describe("unmatched investment deposits", () => {
  const brokerageBook = {
    accounts: [
      account(),
      account({ accountId: "brokerage", accountName: "Fidelity", accountType: "investment" }),
    ],
    endpoints: new Map([
      ["checking", endpoint()],
      [
        "brokerage",
        endpoint({ accountId: "brokerage", accountName: "Fidelity", accountType: "investment" }),
      ],
    ]),
  };

  it("fires for a deposit with no matching cash outflow", () => {
    const diagnostic = only(
      cleanInput({ ...brokerageBook, investmentTxns: [investmentTxn()] }),
      "unmatched_investment_deposits",
    );

    expect(diagnostic.magnitude).toBe("5000.00");
    expect(diagnostic.detail).toContain("1 deposit");
  });

  it("stays quiet when the cash leg is tracked", () => {
    // Checking falls 5,000, the brokerage rises 5,000, and the two cancel in the
    // decomposition. Nothing is unexplained, so nothing is reported.
    const cashLeg = flow({ id: "t2", amount: "-5000.00", postedAt: "2026-02-11" });
    expect(
      codes(
        cleanInput({
          ...brokerageBook,
          classified: [flow(), cashLeg],
          investmentTxns: [investmentTxn()],
        }),
      ),
    ).toEqual([]);
  });

  it("does not accept a cash outflow that settled weeks later", () => {
    // The pairing tolerances are shared with `pairTransfers` deliberately: a
    // withdrawal a month after the deposit is not evidence of the same move,
    // and stretching the window to make a diagnostic quiet would be tuning the
    // measurement to the answer.
    const late = flow({ id: "t2", amount: "-5000.00", postedAt: "2026-03-20" });
    expect(
      codes(
        cleanInput({ ...brokerageBook, classified: [late], investmentTxns: [investmentTxn()] }),
      ),
    ).toContain("unmatched_investment_deposits");
  });

  it("ignores a deposit that landed before the window opened", () => {
    expect(
      codes(
        cleanInput({ ...brokerageBook, investmentTxns: [investmentTxn({ date: "2025-12-01" })] }),
      ),
    ).toEqual([]);
  });

  it("stays quiet for a payroll-direct contribution", () => {
    // ADR-041 §3: `source='income'` has its own rung precisely BECAUSE no cash
    // leg exists. Flagging it would report the healthiest case on the book.
    expect(
      codes(
        cleanInput({
          ...brokerageBook,
          investmentTxns: [investmentTxn({ source: "income" })],
        }),
      ),
    ).toEqual([]);
  });

  it("does not let one cash outflow excuse two deposits", () => {
    // One claim per row, the same rule `pairTransfers` enforces. Without it a
    // single $5,000 withdrawal would silently account for $10,000 of deposits.
    const diagnostic = only(
      cleanInput({
        ...brokerageBook,
        classified: [flow({ id: "t2", amount: "-5000.00", postedAt: "2026-02-11" })],
        investmentTxns: [investmentTxn(), investmentTxn({ date: "2026-02-12" })],
      }),
      "unmatched_investment_deposits",
    );

    expect(diagnostic.magnitude).toBe("5000.00");
  });

  it("does not match an outflow from the brokerage itself", () => {
    // Money leaving the same account it arrived in is not evidence the deposit
    // came from a tracked source.
    // Dated one day after the deposit, so ONLY the same-account rule can reject
    // it — a fixture five days out would pass for the wrong reason, which is
    // exactly what mutating this guard exposed.
    const selfLeg = flow({
      id: "t2",
      accountId: "brokerage",
      amount: "-5000.00",
      postedAt: "2026-02-11",
    });
    expect(
      codes(
        cleanInput({
          ...brokerageBook,
          classified: [selfLeg],
          investmentTxns: [investmentTxn()],
        }),
      ),
    ).toContain("unmatched_investment_deposits");
  });

  it("ignores a dividend, which never crossed the boundary", () => {
    const dividend = investmentTxn({ subtype: "dividend" });
    expect(codes(cleanInput({ ...brokerageBook, investmentTxns: [dividend] }))).toEqual([]);
  });

  it("ignores a sale, which is a withdrawal rather than a deposit", () => {
    expect(
      codes(cleanInput({ ...brokerageBook, investmentTxns: [investmentTxn({ type: "sell" })] })),
    ).toEqual([]);
  });
});

describe("quantity drift (P17-17, ADR-039 §2)", () => {
  it("fires for a position bought mid-window and prices the error", () => {
    // 100 shares at the open worth 20,000; 150 today. Historical net worth
    // prices 2026-01-01 at 150 shares, so the opening figure is overstated by
    // 50 shares' worth — half of 20,000 again.
    const diagnostic = only(
      cleanInput({ holdings: [holding({ currentQuantity: "150.00000000" })] }),
      "quantity_drift",
    );

    expect(diagnostic.magnitude).toBe("10000.00");
    expect(diagnostic.detail).toContain("VTI");
    expect(diagnostic.href).toBe("/investments");
  });

  it("fires for a position sold down as well as one bought into", () => {
    const diagnostic = only(
      cleanInput({ holdings: [holding({ currentQuantity: "75.00000000" })] }),
      "quantity_drift",
    );

    expect(diagnostic.magnitude).toBe("5000.00");
  });

  it("stays quiet when the share count did not move", () => {
    expect(codes(cleanInput({ holdings: [holding()] }))).toEqual([]);
  });

  it("survives a crypto quantity that would round to zero as money", () => {
    // 0.5 BTC → 0.75 BTC. A unit price derived at 2dp would be meaningless for
    // some coins, so the magnitude scales the recorded VALUE by the share-count
    // ratio instead. 50% more coins on a 30,000 opening value ⇒ 15,000.
    const btc = holding({
      symbol: "BTC",
      openingQuantity: "0.50000000",
      openingValue: "30000.00",
      currentQuantity: "0.75000000",
    });

    expect(only(cleanInput({ holdings: [btc] }), "quantity_drift").magnitude).toBe("15000.00");
  });

  it("does not divide by a zero opening share count", () => {
    // A recorded quantity of zero is not the same as no record, and the ratio
    // is undefined either way. The position is named; the magnitude is not
    // fabricated from an infinity.
    const zeroed = holding({
      openingQuantity: "0.00000000",
      openingValue: "0.00",
      currentQuantity: "10.00000000",
    });

    expect(only(cleanInput({ holdings: [zeroed] }), "quantity_drift").magnitude).toBe("0.00");
  });

  it("counts a position with no opening record without inventing a magnitude", () => {
    // `holding_snapshots` began in Phase 9 with a best-effort backfill, so a
    // missing row means the share count is UNKNOWN, not zero.
    const diagnostic = only(
      cleanInput({ holdings: [holding({ openingQuantity: null, openingValue: null })] }),
      "quantity_drift",
    );

    expect(diagnostic.magnitude).toBe("0.00");
    expect(diagnostic.detail).toContain("no share count recorded");
  });
});

describe("loans with no repayment terms", () => {
  it("fires, and says the loan is missing from net worth entirely", () => {
    const loan = account({
      accountId: "mortgage",
      accountName: "Sunwest 30yr",
      accountType: "loan",
      hasLiabilityRow: false,
      openingSnapshotDate: null,
      closingSnapshotDate: null,
    });

    const diagnostic = only(cleanInput({ accounts: [account(), loan] }), "untracked_loan");

    // Zero is the honest magnitude, not a placeholder: `computeNetWorth` skips
    // the loan at BOTH endpoints, so it moves neither the delta nor the residual.
    // What it breaks is net worth itself, which the detail has to say.
    expect(diagnostic.magnitude).toBe("0.00");
    expect(diagnostic.detail).toContain("Sunwest 30yr");
    expect(diagnostic.href).toBe("/accounts/mortgage");
  });

  it("does not fire for a loan that has its terms", () => {
    const loan = account({
      accountId: "mortgage",
      accountType: "loan",
      hasLiabilityRow: true,
      openingSnapshotDate: null,
      closingSnapshotDate: null,
    });
    expect(codes(cleanInput({ accounts: [account(), loan] }))).toEqual([]);
  });
});

describe("ordering (P17-18)", () => {
  it("sorts by magnitude descending", () => {
    const found = residualDiagnostics(
      cleanInput({
        saved: saved({
          uncategorizedVolume: "4200.00",
          uncategorizedCount: 3,
          unpairedTransferVolume: "900.00",
        }),
        unpairedTransferCount: 1,
        holdings: [holding({ currentQuantity: "150.00000000" })],
      }),
    );

    // 10,000 of drifted share count, then 4,200 uncategorized, then 900 of
    // unpaired transfers — largest problem first, regardless of which rung it
    // belongs to.
    expect(found.map((d) => d.code)).toEqual([
      "quantity_drift",
      "uncategorized",
      "unpaired_transfers",
    ]);
  });

  it("breaks ties by code rather than by the order the checks happen to run in", () => {
    // Both diagnostics land on 1,000.00: the account has no opening snapshot
    // (so the gap reports the larger endpoint) and moved with no transactions
    // (so the manual-balance rung reports the same delta). The checks run
    // snapshot-first; the output must still be alphabetical, or the list order
    // is an implementation detail the household can see.
    const input = cleanInput({
      accounts: [account({ openingSnapshotDate: null })],
      endpoints: new Map([
        ["checking", endpoint({ opening: "0.00", closing: "1000.00", delta: "1000.00" })],
      ]),
      classified: [],
    });

    expect(codes(input)).toEqual(["manual_balance_accounts", "snapshot_gap"]);
  });

  it("breaks ties by code so two runs cannot disagree", () => {
    // A household reloading the page must not see the list reshuffle.
    const input = cleanInput({
      saved: saved({
        uncategorizedVolume: "500.00",
        uncategorizedCount: 1,
        unpairedTransferVolume: "500.00",
      }),
      unpairedTransferCount: 1,
    });

    expect(codes(input)).toEqual(["uncategorized", "unpaired_transfers"]);
    expect(codes(input)).toEqual(codes(input));
  });
});

describe("honesty and the Round-16 contract (P17-18)", () => {
  /**
   * One book with every cause present at once.
   *
   * Its first job is exhaustiveness: a code declared in
   * {@link RESIDUAL_DIAGNOSTIC_CODES} but never emitted is a cause the app
   * claims to detect and does not, which is worse than not claiming it.
   */
  function brokenInput(): DiagnosticsInput {
    return cleanInput({
      accounts: [
        account({ openingSnapshotDate: null }),
        account({
          accountId: "mortgage",
          accountName: "Sunwest 30yr",
          accountType: "loan",
          openingSnapshotDate: null,
          closingSnapshotDate: null,
        }),
        account({ accountId: "brokerage", accountName: "Fidelity", accountType: "investment" }),
      ],
      endpoints: new Map([
        ["checking", endpoint()],
        [
          "brokerage",
          endpoint({ accountId: "brokerage", accountName: "Fidelity", accountType: "investment" }),
        ],
      ]),
      classified: [],
      saved: saved({
        uncategorizedVolume: "4200.00",
        uncategorizedCount: 3,
        unpairedTransferVolume: "900.00",
      }),
      unpairedTransferCount: 2,
      investmentTxns: [investmentTxn()],
      holdings: [holding({ currentQuantity: "150.00000000" })],
    });
  }

  it("can emit every code in the closed set", () => {
    expect(new Set(codes(brokenInput()))).toEqual(new Set(RESIDUAL_DIAGNOSTIC_CODES));
  });

  it("never explains the residual with the word 'unexplained'", () => {
    // The one thing a residual diagnostic may not say is that the money is
    // unexplained. That is the question, not an answer to it.
    for (const d of residualDiagnostics(brokenInput())) {
      expect(`${d.label} ${d.detail}`.toLowerCase()).not.toContain("unexplained");
      expect(`${d.label} ${d.detail}`.toLowerCase()).not.toContain("residual");
    }
  });

  it("names something specific in every detail", () => {
    // A count, an account name, or a ticker — never a bare "some data is
    // missing", which sends the household nowhere. The account-scoped
    // diagnostics name the account instead of a count on purpose: "M&T Savings
    // changed" is more actionable than "1 account changed".
    const specifics = ["M&T Checking", "Sunwest 30yr", "Fidelity", "VTI"];
    for (const d of residualDiagnostics(brokenInput())) {
      const namesSomething = /\d/.test(d.detail) || specifics.some((s) => d.detail.includes(s));
      expect(namesSomething, `${d.code}: ${d.detail}`).toBe(true);
    }
  });

  it("carries an unsigned magnitude that parses as money", () => {
    for (const d of residualDiagnostics(brokenInput())) {
      expect(d.magnitude).toMatch(/^\d+\.\d{2}$/);
    }
  });

  it("links every diagnostic at a route that actually exists", () => {
    // This is the assertion that caught PLAN17's own illustrative
    // `/transactions?uncategorized=1`, which was never built — the shipped
    // surface for that job is `/analysis/review`. A fix link to a 404 is worse
    // than no link: it tells the household the app has somewhere for them to go
    // and then does not.
    for (const d of residualDiagnostics(brokenInput())) {
      expect(d.href, `${d.code} has no href`).toBeDefined();
      expect(routeExists(d.href ?? ""), `${d.code} → ${d.href}`).toBe(true);
    }
  });
});

/**
 * Resolve an in-app href to its App Router `page.tsx`, following one dynamic
 * segment where a literal directory does not exist.
 */
function routeExists(href: string): boolean {
  const segments = (href.split("?")[0] ?? "").split("/").filter(Boolean);
  let dir = join(process.cwd(), "src", "app");
  for (const segment of segments) {
    if (existsSync(join(dir, segment))) {
      dir = join(dir, segment);
      continue;
    }
    const dynamic = readdirSync(dir).find((entry) => entry.startsWith("[") && entry.endsWith("]"));
    if (dynamic === undefined) return false;
    dir = join(dir, dynamic);
  }
  return existsSync(join(dir, "page.tsx"));
}
