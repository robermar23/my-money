// @vitest-environment node
import { describe, expect, it } from "vitest";
import { filterCandidates } from "./candidates.ts";
import type { ObligationCandidate } from "./detect.ts";

const CHECKING = "11111111-1111-4111-8111-111111111111";
const CARD = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-06-30T12:00:00Z");

function candidate(overrides: Partial<ObligationCandidate> = {}): ObligationCandidate {
  return {
    accountId: CHECKING,
    payeeKey: "pinecrest mortgag mortgage",
    sampleName: "Pinecrest Mortgag Mortgage",
    label: "Pinecrest Mortgag Mortgage",
    direction: "outflow",
    categoryId: null,
    cadence: "monthly",
    anchorDate: "2026-06-02",
    expectedAmount: "2481.37",
    amountSpread: "0.00",
    amountMode: "fixed",
    confidence: "high",
    occurrences: [{ date: "2026-06-02", amount: "-2481.37", transactionId: "txn-1" }],
    firstSeen: "2026-01-02",
    lastSeen: "2026-06-02",
    ...overrides,
  };
}

describe("filterCandidates — against confirmed obligations", () => {
  it("passes everything through when nothing is confirmed or dismissed", () => {
    const candidates = [candidate(), candidate({ payeeKey: "netflix com" })];
    expect(filterCandidates(candidates, { confirmed: [], dismissed: [], now: NOW })).toEqual(
      candidates,
    );
  });

  it("suppresses a series the user has already confirmed", () => {
    // The whole point: a confirmed obligation must never come back as a
    // proposal. Re-proposing it is the re-nag ADR-026 rejected, and confirming
    // it twice would collide with the partial UNIQUE index on
    // (account_id, detection_key) anyway.
    const result = filterCandidates([candidate()], {
      confirmed: [{ accountId: CHECKING, detectionKey: "pinecrest mortgag mortgage" }],
      dismissed: [],
      now: NOW,
    });
    expect(result).toEqual([]);
  });

  it("matches on the account as well as the payee", () => {
    // The same subscription billed to two different cards is two obligations;
    // confirming one must not hide the other.
    const result = filterCandidates([candidate({ accountId: CARD })], {
      confirmed: [{ accountId: CHECKING, detectionKey: "pinecrest mortgag mortgage" }],
      dismissed: [],
      now: NOW,
    });
    expect(result).toHaveLength(1);
  });

  it("does not suppress a different payee on the same account", () => {
    const result = filterCandidates([candidate({ payeeKey: "netflix com" })], {
      confirmed: [{ accountId: CHECKING, detectionKey: "pinecrest mortgag mortgage" }],
      dismissed: [],
      now: NOW,
    });
    expect(result).toHaveLength(1);
  });

  it("ignores a manual obligation, which carries no detection key", () => {
    // `detection_key` is NULL for anything the user entered by hand — that is
    // exactly why the unique index is partial. A NULL key identifies no series
    // and must not swallow every candidate on the account.
    const result = filterCandidates([candidate()], {
      confirmed: [{ accountId: CHECKING, detectionKey: null }],
      dismissed: [],
      now: NOW,
    });
    expect(result).toHaveLength(1);
  });
});

describe("filterCandidates — against dismissals", () => {
  it("suppresses a candidate the user dismissed indefinitely", () => {
    const result = filterCandidates([candidate()], {
      confirmed: [],
      dismissed: [
        { accountId: CHECKING, detectionKey: "pinecrest mortgag mortgage", snoozeUntil: null },
      ],
      now: NOW,
    });
    expect(result).toEqual([]);
  });

  it("keeps suppressing an indefinite dismissal however much time passes", () => {
    const result = filterCandidates([candidate()], {
      confirmed: [],
      dismissed: [
        { accountId: CHECKING, detectionKey: "pinecrest mortgag mortgage", snoozeUntil: null },
      ],
      now: new Date("2030-01-01T00:00:00Z"),
    });
    expect(result).toEqual([]);
  });

  it("suppresses a snoozed candidate while the snooze is live", () => {
    const result = filterCandidates([candidate()], {
      confirmed: [],
      dismissed: [
        {
          accountId: CHECKING,
          detectionKey: "pinecrest mortgag mortgage",
          snoozeUntil: new Date("2026-07-31T00:00:00Z"),
        },
      ],
      now: NOW,
    });
    expect(result).toEqual([]);
  });

  it("proposes again once a snooze has expired", () => {
    // A snooze that never ended would be a dismissal wearing a different name.
    const result = filterCandidates([candidate()], {
      confirmed: [],
      dismissed: [
        {
          accountId: CHECKING,
          detectionKey: "pinecrest mortgag mortgage",
          snoozeUntil: new Date("2026-05-31T00:00:00Z"),
        },
      ],
      now: NOW,
    });
    expect(result).toHaveLength(1);
  });

  it("treats the snooze boundary as expired at the instant it is reached", () => {
    const result = filterCandidates([candidate()], {
      confirmed: [],
      dismissed: [
        { accountId: CHECKING, detectionKey: "pinecrest mortgag mortgage", snoozeUntil: NOW },
      ],
      now: NOW,
    });
    expect(result).toHaveLength(1);
  });

  it("matches a dismissal on the account too", () => {
    const result = filterCandidates([candidate({ accountId: CARD })], {
      confirmed: [],
      dismissed: [
        { accountId: CHECKING, detectionKey: "pinecrest mortgag mortgage", snoozeUntil: null },
      ],
      now: NOW,
    });
    expect(result).toHaveLength(1);
  });
});

describe("filterCandidates — behaviour of the filter itself", () => {
  it("preserves the order detection ranked them in", () => {
    const candidates = [
      candidate({ payeeKey: "pinecrest mortgag mortgage" }),
      candidate({ payeeKey: "city water bill" }),
      candidate({ payeeKey: "netflix com" }),
    ];
    const result = filterCandidates(candidates, {
      confirmed: [{ accountId: CHECKING, detectionKey: "city water bill" }],
      dismissed: [],
      now: NOW,
    });
    expect(result.map((c) => c.payeeKey)).toEqual(["pinecrest mortgag mortgage", "netflix com"]);
  });

  it("returns an empty list for no candidates", () => {
    expect(filterCandidates([], { confirmed: [], dismissed: [], now: NOW })).toEqual([]);
  });

  it("does not mutate its inputs", () => {
    const candidates = [candidate()];
    const snapshot = structuredClone(candidates);
    filterCandidates(candidates, {
      confirmed: [{ accountId: CHECKING, detectionKey: "pinecrest mortgag mortgage" }],
      dismissed: [],
      now: NOW,
    });
    expect(candidates).toEqual(snapshot);
  });

  it("suppresses on either ground when both apply", () => {
    const result = filterCandidates([candidate()], {
      confirmed: [{ accountId: CHECKING, detectionKey: "pinecrest mortgag mortgage" }],
      dismissed: [
        { accountId: CHECKING, detectionKey: "pinecrest mortgag mortgage", snoozeUntil: null },
      ],
      now: NOW,
    });
    expect(result).toEqual([]);
  });
});
