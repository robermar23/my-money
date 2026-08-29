// @vitest-environment node
import { occurrenceDatesBetween } from "@/lib/schedule/occurrences.ts";
import { describe, expect, it } from "vitest";
import { type DetectionTransaction, detectObligations } from "./detect.ts";

const CHECKING = "11111111-1111-4111-8111-111111111111";
const CARD = "22222222-2222-4222-8222-222222222222";
const HOUSING = "33333333-3333-4333-8333-333333333333";
const SUBSCRIPTIONS = "44444444-4444-4444-8444-444444444444";
const INCOME = "55555555-5555-4555-8555-555555555555";
const TRANSFERS = "66666666-6666-4666-8666-666666666666";

const TODAY = "2026-06-30";

let nextId = 0;

/**
 * Build one transaction. Defaults describe an uncategorized checking outflow,
 * which is what a real bank feed mostly looks like before the user has
 * categorized anything.
 */
function txn(
  overrides: Partial<DetectionTransaction> & { postedAt: string },
): DetectionTransaction {
  nextId += 1;
  return {
    id: `txn-${nextId}`,
    accountId: CHECKING,
    amount: "-100.00",
    name: "SOMETHING",
    categoryId: null,
    categoryKind: null,
    ...overrides,
  };
}

/** Repeat one payee on a real schedule, the way a bank feed would show it. */
function series(
  overrides: Partial<DetectionTransaction>,
  cadence: Parameters<typeof occurrenceDatesBetween>[0],
  anchor: string,
  from: string,
  to: string,
): DetectionTransaction[] {
  return occurrenceDatesBetween(cadence, anchor, from, to).map((postedAt) =>
    txn({ ...overrides, postedAt }),
  );
}

/**
 * A six-month, two-account history: a mortgage, a subscription, a paycheck, a
 * savings transfer in both directions, a one-off purchase, and a gym membership
 * that was cancelled in March.
 */
function realisticHistory(): DetectionTransaction[] {
  return [
    // The mortgage — deliberately UNCATEGORIZED, exactly as it appears in the
    // real checking-account screenshot. Detection must not depend on the user
    // having categorized anything.
    ...series(
      { name: "Pinecrest Mortgag Mortgage", amount: "-2481.37" },
      "monthly",
      "2026-06-02",
      "2026-01-01",
      TODAY,
    ),
    ...series(
      {
        name: "NETFLIX.COM 866-579-7172",
        amount: "-15.99",
        accountId: CARD,
        categoryId: SUBSCRIPTIONS,
        categoryKind: "expense",
      },
      "monthly",
      "2026-06-18",
      "2026-01-01",
      TODAY,
    ),
    ...series(
      {
        name: "77ACMECOPAYROLL PAYROLL",
        amount: "3612.40",
        categoryId: INCOME,
        categoryKind: "income",
      },
      "biweekly",
      "2026-06-19",
      "2026-01-01",
      TODAY,
    ),
    // A transfer pair: the same money seen twice. Including either side would
    // double-count it against the projection.
    ...series(
      {
        name: "WEB XFER TO SAV 90001234567890",
        amount: "-3000.00",
        categoryId: TRANSFERS,
        categoryKind: "transfer",
      },
      "monthly",
      "2026-06-11",
      "2026-01-01",
      TODAY,
    ),
    ...series(
      {
        name: "WEB XFER FROM SAV 90001234567890",
        amount: "3000.00",
        categoryId: TRANSFERS,
        categoryKind: "transfer",
      },
      "monthly",
      "2026-06-12",
      "2026-01-01",
      TODAY,
    ),
    // A one-off large purchase.
    txn({ name: "BEST BUY 00012345", amount: "-1899.00", accountId: CARD, postedAt: "2026-04-03" }),
    // A membership cancelled in March: a real series that has stopped.
    ...series(
      { name: "OLD GYM MEMBERSHIP", amount: "-49.00" },
      "monthly",
      "2026-03-15",
      "2026-01-01",
      "2026-03-31",
    ),
  ];
}

describe("detectObligations — a realistic history", () => {
  it("finds the mortgage, the subscription, and the paycheck, and nothing else", () => {
    const candidates = detectObligations(realisticHistory(), { today: TODAY });
    expect(candidates.map((c) => c.payeeKey).sort()).toEqual([
      "77acmecopayroll payroll",
      "netflix com",
      "pinecrest mortgag mortgage",
    ]);
  });

  it("describes the mortgage the way the confirm form needs it", () => {
    const candidates = detectObligations(realisticHistory(), { today: TODAY });
    const mortgage = candidates.find((c) => c.payeeKey === "pinecrest mortgag mortgage");
    expect(mortgage).toMatchObject({
      accountId: CHECKING,
      direction: "outflow",
      cadence: "monthly",
      anchorDate: "2026-06-02",
      expectedAmount: "2481.37",
      amountSpread: "0.00",
      amountMode: "fixed",
      confidence: "high",
      categoryId: null,
      firstSeen: "2026-01-02",
      lastSeen: "2026-06-02",
    });
    expect(mortgage?.occurrences).toHaveLength(6);
  });

  it("reads a paycheck as an inflow, not a negative outflow", () => {
    const candidates = detectObligations(realisticHistory(), { today: TODAY });
    const paycheck = candidates.find((c) => c.payeeKey === "77acmecopayroll payroll");
    expect(paycheck?.direction).toBe("inflow");
    expect(paycheck?.cadence).toBe("biweekly");
    // A magnitude, never a signed amount — `direction` carries the sign.
    expect(paycheck?.expectedAmount).toBe("3612.40");
    expect(paycheck?.categoryId).toBe(INCOME);
  });

  it("carries the account through, so one payee on two cards stays two series", () => {
    const candidates = detectObligations(realisticHistory(), { today: TODAY });
    expect(candidates.find((c) => c.payeeKey === "netflix com")?.accountId).toBe(CARD);
  });

  it("suggests an editable label and keeps a raw name to show beside it", () => {
    const candidates = detectObligations(realisticHistory(), { today: TODAY });
    const netflix = candidates.find((c) => c.payeeKey === "netflix com");
    expect(netflix?.label).toBe("Netflix Com");
    expect(netflix?.sampleName).toBe("NETFLIX.COM 866-579-7172");
  });
});

describe("detectObligations — what it refuses to propose", () => {
  it("excludes transfer categories in both directions", () => {
    // A card payment or a savings sweep is the same money seen twice. Proposing
    // it would double-count it in the projection and drift toward the ledger
    // this app deliberately is not (CLAUDE.md §Domain Scope).
    const candidates = detectObligations(realisticHistory(), { today: TODAY });
    expect(candidates.some((c) => c.payeeKey.includes("xfer"))).toBe(false);
  });

  it("does not propose a one-off purchase", () => {
    const candidates = detectObligations(realisticHistory(), { today: TODAY });
    expect(candidates.some((c) => c.payeeKey.includes("best buy"))).toBe(false);
  });

  it("suppresses a series that stopped more than two periods ago", () => {
    // The gym was cancelled in March; projecting it forward would invent an
    // outflow the household will never see.
    const candidates = detectObligations(realisticHistory(), { today: TODAY });
    expect(candidates.some((c) => c.payeeKey.includes("gym"))).toBe(false);
  });

  it("keeps a series whose latest occurrence is merely late", () => {
    // One period overdue is exactly the case the miss alert exists for — it
    // must not be quietly dropped from the projection instead.
    const history = series(
      { name: "CITY WATER BILL", amount: "-64.00" },
      "monthly",
      "2026-05-20",
      "2026-01-01",
      "2026-05-31",
    );
    const candidates = detectObligations(history, { today: "2026-06-25" });
    expect(candidates).toHaveLength(1);
  });

  it("does not propose a payee seen only twice", () => {
    const history = [
      txn({ name: "ANNUAL DOMAIN RENEWAL", amount: "-22.00", postedAt: "2026-01-10" }),
      txn({ name: "ANNUAL DOMAIN RENEWAL", amount: "-22.00", postedAt: "2026-02-10" }),
    ];
    expect(detectObligations(history, { today: TODAY })).toEqual([]);
  });

  it("does not propose a payee with no rhythm", () => {
    const history = ["2026-01-03", "2026-01-19", "2026-03-02", "2026-03-05", "2026-06-11"].map(
      (postedAt) => txn({ name: "CORNER STORE", amount: "-12.00", postedAt }),
    );
    expect(detectObligations(history, { today: TODAY })).toEqual([]);
  });

  it("returns nothing for an empty history", () => {
    expect(detectObligations([], { today: TODAY })).toEqual([]);
  });
});

describe("detectObligations — grouping", () => {
  it("splits one payee into separate inflow and outflow series", () => {
    // Venmo runs both ways in a real feed. Averaging a -$225 payment with a
    // +$500 receipt would describe an obligation that does not exist.
    const history = [
      ...series({ name: "Venmo", amount: "-225.00" }, "monthly", "2026-06-01", "2026-01-01", TODAY),
      ...series({ name: "Venmo", amount: "500.00" }, "monthly", "2026-06-15", "2026-01-01", TODAY),
    ];
    const candidates = detectObligations(history, { today: TODAY });
    expect(candidates.map((c) => c.direction).sort()).toEqual(["inflow", "outflow"]);
    expect(candidates.every((c) => c.payeeKey === "venmo")).toBe(true);
  });

  it("groups by the same key the categorization engine uses", () => {
    // Store numbers vary per charge; the series is one obligation.
    const history = [
      txn({ name: "CITY WATER BILL 0001", postedAt: "2026-03-20", amount: "-64.00" }),
      txn({ name: "CITY WATER BILL 0002", postedAt: "2026-04-20", amount: "-64.00" }),
      txn({ name: "CITY WATER BILL 0003", postedAt: "2026-05-20", amount: "-64.00" }),
      txn({ name: "CITY WATER BILL 0004", postedAt: "2026-06-20", amount: "-64.00" }),
    ];
    const candidates = detectObligations(history, { today: TODAY });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.occurrences).toHaveLength(4);
  });

  it("picks the majority category and ignores a stray one", () => {
    const history = [
      txn({
        name: "CITY WATER",
        postedAt: "2026-03-20",
        amount: "-64.00",
        categoryId: HOUSING,
        categoryKind: "expense",
      }),
      txn({
        name: "CITY WATER",
        postedAt: "2026-04-20",
        amount: "-64.00",
        categoryId: HOUSING,
        categoryKind: "expense",
      }),
      txn({
        name: "CITY WATER",
        postedAt: "2026-05-20",
        amount: "-64.00",
        categoryId: SUBSCRIPTIONS,
        categoryKind: "expense",
      }),
      txn({
        name: "CITY WATER",
        postedAt: "2026-06-20",
        amount: "-64.00",
        categoryId: HOUSING,
        categoryKind: "expense",
      }),
    ];
    expect(detectObligations(history, { today: TODAY })[0]?.categoryId).toBe(HOUSING);
  });

  it("reports occurrences in date order with their transaction ids", () => {
    const candidates = detectObligations(realisticHistory(), { today: TODAY });
    const mortgage = candidates.find((c) => c.payeeKey === "pinecrest mortgag mortgage");
    const dates = mortgage?.occurrences.map((o) => o.date) ?? [];
    expect(dates).toEqual([...dates].sort());
    expect(mortgage?.occurrences[0]).toMatchObject({ date: "2026-01-02", amount: "-2481.37" });
    expect(mortgage?.occurrences[0]?.transactionId).toMatch(/^txn-/);
  });
});

describe("detectObligations — determinism and purity", () => {
  it("returns the same candidates in the same order regardless of input order", () => {
    const history = realisticHistory();
    const forwards = detectObligations(history, { today: TODAY });
    const backwards = detectObligations([...history].reverse(), { today: TODAY });
    expect(backwards).toEqual(forwards);
  });

  it("reads today only from its options, never from the clock", () => {
    // Same history, two different "todays": the stale gym membership is live in
    // the earlier one and suppressed in the later one. A function that called
    // `new Date()` could not produce both.
    const history = realisticHistory();
    const inMarch = detectObligations(history, { today: "2026-03-31" });
    const inJune = detectObligations(history, { today: TODAY });
    expect(inMarch.some((c) => c.payeeKey.includes("gym"))).toBe(true);
    expect(inJune.some((c) => c.payeeKey.includes("gym"))).toBe(false);
  });

  it("does not mutate the transactions it was given", () => {
    const history = realisticHistory();
    const snapshot = structuredClone(history);
    detectObligations(history, { today: TODAY });
    expect(history).toEqual(snapshot);
  });
});
