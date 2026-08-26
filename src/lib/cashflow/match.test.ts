// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  DEFAULT_MATCH_TOLERANCE,
  type MatchOptions,
  type MatchableOccurrence,
  type MatchableTransaction,
  matchOccurrences,
} from "./match.ts";

/**
 * P16-22 — occurrence matching, expressed as a DATA CONTRACT.
 *
 * These cases are the contract, not prose about it (`data-quality-frameworks`
 * §Data Contracts, applied to a single-user Postgres app rather than a
 * warehouse). Each block below is one quality dimension:
 *
 *   validity     — a match satisfies the window AND the amount tolerance
 *   uniqueness   — one transaction is claimed by at most one occurrence
 *   completeness — an occurrence past its window is resolved, not left silent
 *   consistency  — a terminal occurrence is never re-decided
 *   determinism  — the same inputs produce byte-identical output
 *
 * The stakes: matched occurrences are what makes the residual subtraction
 * EXACT (ADR-038 §2). An occurrence that fails to match leaves its outflow
 * inside observed spend and un-attributed, so the run-rate charges it a second
 * time — the double-count the whole phase exists to prevent. A match that fires
 * on the WRONG transaction attributes spending that never happened. Both errors
 * move safe-to-spend, which is a number a household acts on.
 */

const OPTIONS: MatchOptions = { tolerance: DEFAULT_MATCH_TOLERANCE, today: "2026-04-30" };

function occurrence(over: Partial<MatchableOccurrence> = {}): MatchableOccurrence {
  return {
    id: "occ-1",
    obligationId: "ob-1",
    accountId: "acct-1",
    payeeKey: "acme mortgage",
    dueDate: "2026-03-01",
    expectedAmount: "2150.00",
    direction: "outflow",
    amountMode: "fixed",
    status: "scheduled",
    ...over,
  };
}

function transaction(over: Partial<MatchableTransaction> = {}): MatchableTransaction {
  return {
    id: "txn-1",
    accountId: "acct-1",
    payeeKey: "acme mortgage",
    postedAt: "2026-03-01",
    amount: "-2150.00",
    ...over,
  };
}

describe("matchOccurrences — validity", () => {
  it("matches a transaction that posts on the due date for the expected amount", () => {
    const result = matchOccurrences([occurrence()], [transaction()], OPTIONS);

    expect(result.matched).toEqual([
      {
        occurrenceId: "occ-1",
        transactionId: "txn-1",
        matchedAmount: "-2150.00",
        amountDelta: "0.00",
        dayOffset: 0,
        basis: "payee",
      },
    ]);
    expect(result.missed).toEqual([]);
    expect(result.pending).toEqual([]);
  });

  it("matches a payment that posts three days late", () => {
    const result = matchOccurrences(
      [occurrence()],
      [transaction({ postedAt: "2026-03-04" })],
      OPTIONS,
    );

    expect(result.matched[0]?.dayOffset).toBe(3);
  });

  it("matches a payment that posts early", () => {
    const result = matchOccurrences(
      [occurrence()],
      [transaction({ postedAt: "2026-02-27" })],
      OPTIONS,
    );

    expect(result.matched[0]?.dayOffset).toBe(-2);
  });

  it("reports the amount drift when the bill came in higher", () => {
    // What `obligation_amount_changed` (P16-28) reads. The delta compares
    // MAGNITUDES, so a positive number always means "bigger than expected"
    // regardless of which way the money moved.
    const result = matchOccurrences(
      [occurrence({ expectedAmount: "180.00" })],
      [transaction({ amount: "-192.40" })],
      OPTIONS,
    );

    expect(result.matched[0]?.amountDelta).toBe("12.40");
  });

  it("does not match a transaction outside the date window", () => {
    const result = matchOccurrences(
      [occurrence()],
      [transaction({ postedAt: "2026-03-20" })],
      OPTIONS,
    );

    expect(result.matched).toEqual([]);
    expect(result.missed.map((m) => m.occurrenceId)).toEqual(["occ-1"]);
  });

  it("does not match an amount outside the tolerance", () => {
    // 2150 +/- 15% is 1827.50-2472.50. A 3000 charge from the same payee in the
    // same window is a different event, and claiming it would attribute $3,000
    // of spend the mortgage never made.
    const result = matchOccurrences([occurrence()], [transaction({ amount: "-3000.00" })], OPTIONS);

    expect(result.matched).toEqual([]);
  });

  it("uses the absolute floor so a small bill is not held to a percentage", () => {
    // 15% of $9.99 is $1.50 — a $2 price rise would read as a different charge.
    // The floor is what keeps a subscription bump a match rather than a miss.
    const result = matchOccurrences(
      [occurrence({ expectedAmount: "9.99", payeeKey: "netflix" })],
      [transaction({ amount: "-12.99", payeeKey: "netflix" })],
      OPTIONS,
    );

    expect(result.matched).toHaveLength(1);
    expect(result.matched[0]?.amountDelta).toBe("3.00");
  });

  it("gives a variable obligation the wider tolerance its amount_mode implies", () => {
    // A utility bill priced from a trailing median moves with the season. The
    // schema models that with `amount_mode`; the matcher honours it rather than
    // reporting a July electric bill as missed.
    const varied = occurrence({
      expectedAmount: "120.00",
      amountMode: "trailing_median",
      payeeKey: "city power",
    });
    const summer = transaction({ amount: "-176.00", payeeKey: "city power" });

    expect(matchOccurrences([varied], [summer], OPTIONS).matched).toHaveLength(1);
    // The same amount against a FIXED obligation is out of tolerance.
    expect(
      matchOccurrences([occurrence({ ...varied, amountMode: "fixed" })], [summer], OPTIONS).matched,
    ).toEqual([]);
  });

  it("never matches across accounts, even for the same payee", () => {
    const result = matchOccurrences(
      [occurrence()],
      [transaction({ accountId: "acct-2" })],
      OPTIONS,
    );

    expect(result.matched).toEqual([]);
  });

  it("never matches a payment against a receipt", () => {
    // An inflow obligation (a lodger's rent) must not be satisfied by an
    // outflow of the same size, which would invert the projection's sign.
    const result = matchOccurrences(
      [occurrence({ direction: "inflow" })],
      [transaction({ amount: "-2150.00" })],
      OPTIONS,
    );

    expect(result.matched).toEqual([]);
  });
});

describe("matchOccurrences — the deterministic pick", () => {
  it("prefers the closest date, then the smallest amount difference", () => {
    // Two plausible charges in one window. The rule is documented and total:
    // date proximity first, then amount, then transaction id. Without it the
    // pick would depend on row order, and the residual attribution would change
    // between two runs over identical data.
    const result = matchOccurrences(
      [occurrence()],
      [
        transaction({ id: "txn-far", postedAt: "2026-03-04", amount: "-2150.00" }),
        transaction({ id: "txn-near", postedAt: "2026-03-02", amount: "-2149.00" }),
      ],
      OPTIONS,
    );

    expect(result.matched[0]?.transactionId).toBe("txn-near");
  });

  it("breaks a date tie on the smaller amount difference", () => {
    const result = matchOccurrences(
      [occurrence()],
      [
        transaction({ id: "txn-loose", postedAt: "2026-03-02", amount: "-2100.00" }),
        transaction({ id: "txn-tight", postedAt: "2026-03-02", amount: "-2150.00" }),
      ],
      OPTIONS,
    );

    expect(result.matched[0]?.transactionId).toBe("txn-tight");
  });

  it("breaks a full tie on transaction id so the answer is total", () => {
    const result = matchOccurrences(
      [occurrence()],
      [transaction({ id: "txn-b" }), transaction({ id: "txn-a" })],
      OPTIONS,
    );

    expect(result.matched[0]?.transactionId).toBe("txn-a");
  });

  it("is invariant to the order of its inputs", () => {
    const occurrences = [
      occurrence({ id: "occ-mar", dueDate: "2026-03-01" }),
      occurrence({ id: "occ-apr", dueDate: "2026-04-01" }),
    ];
    const txns = [
      transaction({ id: "txn-mar", postedAt: "2026-03-01" }),
      transaction({ id: "txn-apr", postedAt: "2026-04-01" }),
    ];

    const forward = matchOccurrences(occurrences, txns, OPTIONS);
    const reversed = matchOccurrences([...occurrences].reverse(), [...txns].reverse(), OPTIONS);

    expect(reversed).toEqual(forward);
  });
});

describe("matchOccurrences — uniqueness", () => {
  it("never lets two occurrences claim the same transaction", () => {
    // A doubled-up schedule (two obligations for one bill) must not attribute
    // the same $2,150 twice. Over-attribution drives the residual rate to zero
    // and inflates safe-to-spend — the dangerous direction.
    const result = matchOccurrences(
      [
        occurrence({ id: "occ-a", obligationId: "ob-a" }),
        occurrence({ id: "occ-b", obligationId: "ob-b" }),
      ],
      [transaction()],
      OPTIONS,
    );

    expect(result.matched).toHaveLength(1);
    expect(result.missed.map((m) => m.occurrenceId)).toEqual(["occ-b"]);
  });

  it("lets a payee-keyed occurrence claim before an amount-only one", () => {
    // A manual obligation matches on amount alone (see below), which is the
    // looser test. Running the certain match first stops the loose one from
    // stealing a transaction its keyed sibling would have claimed.
    const result = matchOccurrences(
      [
        occurrence({ id: "occ-manual", obligationId: "ob-manual", payeeKey: null }),
        occurrence({ id: "occ-keyed", obligationId: "ob-keyed" }),
      ],
      [transaction()],
      OPTIONS,
    );

    expect(result.matched[0]?.occurrenceId).toBe("occ-keyed");
    expect(result.missed.map((m) => m.occurrenceId)).toEqual(["occ-manual"]);
  });

  it("matches a manual obligation on amount and window alone, and says so", () => {
    // A hand-entered obligation has no `detection_key` — nothing identifies its
    // payee. Refusing to match it would report every manually-tracked bill as
    // missed; matching it silently would hide how weak the evidence is. So it
    // matches, and the basis travels with the match.
    const result = matchOccurrences(
      [occurrence({ payeeKey: null })],
      [transaction({ payeeKey: "some other description" })],
      OPTIONS,
    );

    expect(result.matched[0]).toMatchObject({ transactionId: "txn-1", basis: "amount" });
  });
});

describe("matchOccurrences — completeness and consistency", () => {
  it("leaves an occurrence whose window is still open as pending", () => {
    // Today is inside the window. "Not yet" is not "missed" — raising a miss
    // alert here would nag about a bill that is not late.
    const result = matchOccurrences([occurrence({ dueDate: "2026-04-28" })], [], {
      ...OPTIONS,
      today: "2026-04-30",
    });

    expect(result.pending).toEqual(["occ-1"]);
    expect(result.missed).toEqual([]);
  });

  it("marks an occurrence missed once its window has closed with nothing found", () => {
    const result = matchOccurrences([occurrence({ dueDate: "2026-04-01" })], [], OPTIONS);

    expect(result.missed).toEqual([{ occurrenceId: "occ-1", dueDate: "2026-04-01" }]);
  });

  it("treats the last day of the window as still open", () => {
    // Boundary: due 2026-04-25 + 5 days tolerance = through 2026-04-30. On the
    // 30th the payment can still post.
    const result = matchOccurrences([occurrence({ dueDate: "2026-04-25" })], [], OPTIONS);

    expect(result.pending).toEqual(["occ-1"]);
  });

  it("never re-decides an occurrence that is already matched", () => {
    const result = matchOccurrences([occurrence({ status: "matched" })], [transaction()], OPTIONS);

    expect(result.matched).toEqual([]);
    expect(result.missed).toEqual([]);
    expect(result.pending).toEqual([]);
  });

  it("never re-decides an occurrence the user deliberately skipped", () => {
    // A skip is intent (ADR-037). Re-matching it would resurrect a payment the
    // user said is not happening, and marking it missed would alert on it.
    const result = matchOccurrences([occurrence({ status: "skipped" })], [transaction()], OPTIONS);

    expect(result.matched).toEqual([]);
    expect(result.missed).toEqual([]);
  });

  it("does not resurrect an occurrence already recorded as missed", () => {
    const result = matchOccurrences([occurrence({ status: "missed" })], [transaction()], OPTIONS);

    expect(result.matched).toEqual([]);
    expect(result.missed).toEqual([]);
  });

  it("resolves every scheduled occurrence exactly once", () => {
    // The completeness property: nothing scheduled falls through the sweep
    // unclassified. An occurrence that vanished from all three lists would
    // silently drop out of the attribution.
    const occurrences = [
      occurrence({ id: "occ-hit", dueDate: "2026-03-01" }),
      occurrence({ id: "occ-late", dueDate: "2026-02-01" }),
      occurrence({ id: "occ-open", dueDate: "2026-04-29" }),
    ];
    const result = matchOccurrences(occurrences, [transaction()], OPTIONS);

    const resolved = [
      ...result.matched.map((m) => m.occurrenceId),
      ...result.missed.map((m) => m.occurrenceId),
      ...result.pending,
    ];
    expect(resolved.sort()).toEqual(["occ-hit", "occ-late", "occ-open"]);
  });

  it("does not mutate its inputs", () => {
    const occurrences = [occurrence()];
    const txns = [transaction()];
    const before = structuredClone({ occurrences, txns });

    matchOccurrences(occurrences, txns, OPTIONS);

    expect({ occurrences, txns }).toEqual(before);
  });

  it("rejects a negative tolerance rather than matching nothing quietly", () => {
    expect(() =>
      matchOccurrences([occurrence()], [transaction()], {
        ...OPTIONS,
        tolerance: { ...DEFAULT_MATCH_TOLERANCE, days: -1 },
      }),
    ).toThrow(/days/i);
  });
});
