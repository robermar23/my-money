// @vitest-environment node
import { Money } from "@/lib/money/money.ts";
import { monthlyPayment } from "@/lib/mortgage/amortization.ts";
import { describe, expect, it } from "vitest";
import {
  type LiabilityCandidateInput,
  type LiabilityTerms,
  type ObservedOutflow,
  type PayingAccount,
  liabilityCandidates,
} from "./liability-obligations.ts";
import { DEFAULT_MATCH_TOLERANCE, type MatchableOccurrence, matchOccurrences } from "./match.ts";

/**
 * CF-A3 — the stated-schedule proposal (ADR-047).
 *
 * An always-test surface by CLAUDE.md §Testing Philosophy: this is amortization
 * math feeding the largest single line in a household's month, and getting it
 * wrong moves the low-water date the family plans around.
 *
 * The cases are organised by the thing that could go wrong rather than by
 * function, and the last one is the important one: **a confirmed liability
 * obligation must still MATCH the real payment**. If it does not, the mortgage
 * is dated on the calendar *and* left inside the residual daily rate, which is
 * ADR-038 §2's double-count arriving through the door ADR-047 opened. The guard
 * runs end-to-end through the shipped matcher rather than asserting on a field,
 * because the field is only interesting for what the matcher does with it.
 */

const CURRENCY = "USD";
const TODAY = "2026-08-30";

const CHECKING: PayingAccount = {
  accountId: "acct-checking",
  name: "M&T Checking",
  institution: "M&T Bank",
};
const SECOND_CHECKING: PayingAccount = {
  accountId: "acct-checking-2",
  name: "Joint Checking",
  institution: "Ally",
};

const MORTGAGE: LiabilityTerms = {
  id: "liab-mortgage",
  accountId: "acct-loan",
  name: "Sunwest Mortgage",
  principalAtOrigination: "400000.00",
  annualRate: "0.065",
  termMonths: 360,
  startDate: "2019-09-01",
};

/** Principal-and-interest for the fixture loan, from the shipped math. */
function pi(liability: LiabilityTerms = MORTGAGE): Money {
  return monthlyPayment(
    Money.fromString(liability.principalAtOrigination, CURRENCY),
    liability.annualRate,
    liability.termMonths,
  );
}

/** Monthly outflows on one account, all the same magnitude, ascending by date. */
function series(
  account: PayingAccount,
  payeeKey: string,
  amount: Money,
  dates: readonly string[],
): ObservedOutflow[] {
  return dates.map((postedAt) => ({
    accountId: account.accountId,
    payeeKey,
    name: "SUNWEST MTG ACH PMT",
    postedAt,
    amount: amount.negate().toString(),
  }));
}

const MONTHLY_DATES = [
  "2026-03-03",
  "2026-04-03",
  "2026-05-03",
  "2026-06-03",
  "2026-07-03",
  "2026-08-03",
] as const;

function run(overrides: Partial<LiabilityCandidateInput> = {}) {
  return liabilityCandidates({
    liabilities: [MORTGAGE],
    operatingAccounts: [CHECKING],
    observedOutflows: [],
    today: TODAY,
    ...overrides,
  });
}

describe("liabilityCandidates — what it proposes with no payment history", () => {
  it("proposes the computed schedule and says escrow is not in it", () => {
    const [candidate] = run();

    expect(candidate).toBeDefined();
    expect(candidate?.expectedAmount).toBe(pi().toString());
    expect(candidate?.scheduledPayment).toBe(pi().toString());
    expect(candidate?.amountMode).toBe("fixed");
    // The caveat is the whole point: a mortgage figure that is quietly a few
    // hundred dollars light is worse than no figure at all.
    expect(candidate?.escrowCaveat).toBe(true);
    expect(candidate?.observedMedian).toBeNull();
    expect(candidate?.observedCount).toBe(0);
  });

  it("does not back-date the schedule to the loan's origination", () => {
    // Materialization walks from `startDate`. A 2019 start with no imported
    // payments would create ~80 occurrences the app holds no evidence for,
    // sweep every one to `missed`, and bury the household in alerts for a
    // mortgage they have paid every month for six years.
    const [candidate] = run();
    expect(candidate?.startDate).toBe(TODAY);
    // The anchor still phases from the stated terms — that IS known.
    expect(candidate?.anchorDate).toBe(MORTGAGE.startDate);
  });

  it("never guesses the account the money leaves", () => {
    const [candidate] = run({ operatingAccounts: [CHECKING, SECOND_CHECKING] });
    expect(candidate?.accountId).toBeNull();
    // …but hands the UI everything it needs to ask.
    expect(candidate?.accountOptions).toHaveLength(2);
  });
});

describe("liabilityCandidates — observed payments outrank computed P&I", () => {
  /** An escrowed payment: 25% above P&I, well past the matcher's ±15% band. */
  const ESCROWED = pi().mul("1.25");

  it("takes the amount from the household's own payments", () => {
    const [candidate] = run({
      observedOutflows: series(CHECKING, "sunwest mtg ach pmt", ESCROWED, MONTHLY_DATES),
    });

    expect(candidate?.expectedAmount).toBe(ESCROWED.toString());
    expect(candidate?.observedMedian).toBe(ESCROWED.toString());
    expect(candidate?.observedCount).toBe(MONTHLY_DATES.length);
    expect(candidate?.escrowCaveat).toBe(false);
    // P&I is still carried, because the gap between the two IS the escrow.
    expect(candidate?.scheduledPayment).toBe(pi().toString());
  });

  it("prices it as a trailing median, so the annual escrow step is not an alarm", () => {
    // ADR-047 §6: the mode is decided by provenance, not by how tight the
    // observed amounts happen to be. These six payments are identical to the
    // cent and would grade as `fixed` on stability alone — and a `fixed`
    // mortgage reports MISSED the month escrow is re-analysed.
    const [candidate] = run({
      observedOutflows: series(CHECKING, "sunwest mtg ach pmt", ESCROWED, MONTHLY_DATES),
    });
    expect(candidate?.amountMode).toBe("trailing_median");
  });

  it("phases the schedule on the observed day of month", () => {
    const [candidate] = run({
      observedOutflows: series(CHECKING, "sunwest mtg ach pmt", ESCROWED, MONTHLY_DATES),
    });
    expect(candidate?.anchorDate).toBe("2026-08-03");
    expect(candidate?.startDate).toBe("2026-03-03");
  });

  it("infers the paying account from the payments themselves", () => {
    const [candidate] = run({
      operatingAccounts: [CHECKING, SECOND_CHECKING],
      observedOutflows: series(CHECKING, "sunwest mtg ach pmt", ESCROWED, MONTHLY_DATES),
    });
    expect(candidate?.accountId).toBe(CHECKING.accountId);
  });

  it("leaves the account unset when the payments span two accounts", () => {
    const [candidate] = run({
      operatingAccounts: [CHECKING, SECOND_CHECKING],
      observedOutflows: [
        ...series(CHECKING, "sunwest mtg ach pmt", ESCROWED, MONTHLY_DATES),
        ...series(SECOND_CHECKING, "sunwest mtg ach pmt", ESCROWED, MONTHLY_DATES),
      ],
    });
    // Ambiguous: the household could be paying from either, and attaching the
    // largest bill in the month to the wrong balance moves the low-water date.
    expect(candidate?.accountId).toBeNull();
    // The amount is still the better figure, and the evidence is shown with it.
    expect(candidate?.expectedAmount).toBe(ESCROWED.toString());
  });

  it("ignores an inflow of the same size", () => {
    const refunds = series(CHECKING, "sunwest mtg ach pmt", ESCROWED, MONTHLY_DATES).map((row) => ({
      ...row,
      amount: Money.fromString(row.amount, CURRENCY).abs().toString(),
    }));
    const [candidate] = run({ observedOutflows: refunds });
    expect(candidate?.observedCount).toBe(0);
    expect(candidate?.escrowCaveat).toBe(true);
  });
});

describe("liabilityCandidates — what it refuses to claim", () => {
  it("ignores a payee whose amount is nothing like the payment", () => {
    const [candidate] = run({
      observedOutflows: series(CHECKING, "some other biller", pi().mul("3"), MONTHLY_DATES),
    });
    // Failing to the safe side: P&I with the caveat stated, which the user can
    // correct in the field, rather than a confident wrong number.
    expect(candidate?.observedCount).toBe(0);
    expect(candidate?.amountMode).toBe("fixed");
  });

  it("ignores a single payment — one occurrence is not a series", () => {
    const [candidate] = run({
      observedOutflows: series(CHECKING, "sunwest mtg ach pmt", pi(), ["2026-08-03"]),
    });
    expect(candidate?.observedCount).toBe(0);
    expect(candidate?.escrowCaveat).toBe(true);
  });

  it("ignores payments that are not a month apart", () => {
    const [candidate] = run({
      observedOutflows: series(CHECKING, "sunwest mtg ach pmt", pi(), [
        "2026-08-03",
        "2026-08-10",
        "2026-08-17",
      ]),
    });
    expect(candidate?.observedCount).toBe(0);
  });

  it("ignores outflows on an account that is not operating cash", () => {
    const [candidate] = run({
      observedOutflows: series(
        { accountId: "acct-savings", name: "Savings", institution: "Ally" },
        "sunwest mtg ach pmt",
        pi(),
        MONTHLY_DATES,
      ),
    });
    expect(candidate?.observedCount).toBe(0);
  });

  it("proposes nothing for a loan whose term has run out", () => {
    const paidOff: LiabilityTerms = {
      ...MORTGAGE,
      id: "liab-old-car",
      name: "Old car loan",
      principalAtOrigination: "20000.00",
      termMonths: 60,
      startDate: "2018-01-01",
    };
    expect(run({ liabilities: [paidOff] })).toEqual([]);
  });

  it("proposes nothing for a zero-principal row", () => {
    const empty: LiabilityTerms = { ...MORTGAGE, principalAtOrigination: "0.00" };
    expect(run({ liabilities: [empty] })).toEqual([]);
  });

  it("gives one payment series to only one loan", () => {
    // Two loans whose bands overlap must not both claim the same payments, or
    // the same money would be dated twice on the calendar.
    const second: LiabilityTerms = { ...MORTGAGE, id: "liab-second", name: "Second lien" };
    const candidates = run({
      liabilities: [MORTGAGE, second],
      observedOutflows: series(CHECKING, "sunwest mtg ach pmt", pi(), MONTHLY_DATES),
    });

    expect(candidates).toHaveLength(2);
    expect(candidates.filter((c) => c.observedCount > 0)).toHaveLength(1);
  });
});

describe("liabilityCandidates — determinism", () => {
  it("does not depend on the order rows arrive in", () => {
    const outflows = series(CHECKING, "sunwest mtg ach pmt", pi().mul("1.2"), MONTHLY_DATES);
    const forwards = run({ observedOutflows: outflows });
    const backwards = run({ observedOutflows: [...outflows].reverse() });
    expect(backwards).toEqual(forwards);
  });

  it("orders candidates stably by label", () => {
    const auto: LiabilityTerms = {
      ...MORTGAGE,
      id: "liab-auto",
      name: "Auto loan",
      principalAtOrigination: "28000.00",
      termMonths: 72,
      startDate: "2024-02-01",
    };
    expect(run({ liabilities: [MORTGAGE, auto] }).map((c) => c.label)).toEqual([
      "Auto loan",
      "Sunwest Mortgage",
    ]);
  });
});

describe("CF-A3 — the confirmed occurrence still matches the real payment (ADR-047 §4)", () => {
  const ESCROWED = pi().mul("1.25");

  /** The occurrence a confirmed liability candidate materializes. */
  function occurrenceFor(payeeKey: string | null): MatchableOccurrence {
    const [candidate] = run({
      observedOutflows: series(CHECKING, "sunwest mtg ach pmt", ESCROWED, MONTHLY_DATES),
    });
    if (candidate === undefined) throw new Error("fixture produced no candidate");
    return {
      id: "occ-1",
      obligationId: "ob-1",
      accountId: candidate.accountId ?? CHECKING.accountId,
      // Confirming writes `detection_key = NULL` (ADR-047 §4). The parameter
      // exists so the negative control below can put a synthetic key here.
      payeeKey,
      dueDate: "2026-09-03",
      expectedAmount: candidate.expectedAmount,
      direction: "outflow",
      amountMode: candidate.amountMode,
      status: "scheduled",
    };
  }

  /** The payment that actually posts the month after the candidate is confirmed. */
  const POSTED = {
    id: "txn-9",
    accountId: CHECKING.accountId,
    payeeKey: "sunwest mtg ach pmt",
    postedAt: "2026-09-03",
    amount: ESCROWED.negate().toString(),
  };

  it("matches on (account, direction, window, amount) with no detection key", () => {
    const result = matchOccurrences([occurrenceFor(null)], [POSTED], {
      tolerance: DEFAULT_MATCH_TOLERANCE,
      today: "2026-09-20",
    });

    expect(result.matched).toHaveLength(1);
    expect(result.matched[0]?.transactionId).toBe(POSTED.id);
    // Weaker evidence, and it says so — the same basis a manual bill matches on.
    expect(result.matched[0]?.basis).toBe("amount");
    expect(result.missed).toEqual([]);
  });

  it("would MISS the payment if a synthetic key were stored in detection_key", () => {
    // The negative control, and the reason `liability_id` is its own column. A
    // key like this matches no transaction that will ever exist, so the
    // occurrence goes unmatched: the residual keeps the mortgage inside the flat
    // daily rate while the calendar also dates it — ADR-038 §2's double-count,
    // plus a false "a bill did not post" alert every month.
    const result = matchOccurrences([occurrenceFor("liability:liab-mortgage")], [POSTED], {
      tolerance: DEFAULT_MATCH_TOLERANCE,
      today: "2026-09-20",
    });

    expect(result.matched).toEqual([]);
    expect(result.missed).toHaveLength(1);
  });

  it("still matches when escrow moves the payment mid-year", () => {
    // A `fixed` obligation priced at P&I would blow past the ±15% band here and
    // report missed. Priced at the observed median in `trailing_median` mode, a
    // seasonal move is inside tolerance — which is ADR-047 §6's whole argument.
    const raised = { ...POSTED, amount: ESCROWED.mul("1.12").negate().toString() };
    const result = matchOccurrences([occurrenceFor(null)], [raised], {
      tolerance: DEFAULT_MATCH_TOLERANCE,
      today: "2026-09-20",
    });

    expect(result.matched).toHaveLength(1);
    expect(result.missed).toEqual([]);
  });
});
