// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  type EndpointBreakdown,
  assertWindow,
  endpointsFor,
  endpointsOfType,
  withinWindow,
} from "./endpoints.ts";

/**
 * P17-06 — the ADR-039 §1 anchor, made concrete.
 *
 * The endpoints are *given*; the rungs are the hypothesis. Everything asserted
 * below protects that direction of dependency: the totals come out exactly as
 * they went in, and the per-account deltas are derived once so no rung ever
 * issues a balance query of its own.
 */

function item(
  accountId: string,
  accountType: string,
  balance: string,
): EndpointBreakdown["items"][number] {
  return { accountId, accountName: `acct ${accountId}`, accountType, currency: "USD", balance };
}

function breakdown(
  asOf: string,
  total: string,
  items: readonly EndpointBreakdown["items"][number][],
): EndpointBreakdown {
  return { asOf, total, items };
}

describe("endpointsFor", () => {
  it("carries the window straight off the two breakdowns", () => {
    const result = endpointsFor(
      breakdown("2026-01-01", "0.00", []),
      breakdown("2026-06-30", "0.00", []),
    );

    expect(result.from).toBe("2026-01-01");
    expect(result.to).toBe("2026-06-30");
  });

  it("takes both totals VERBATIM and never re-sums the items", () => {
    // `computeNetWorth` sums only items whose currency matches the base, so
    // `total` is deliberately not `Σ items`. Re-summing here would produce a
    // waterfall whose endpoints disagree with the dashboard directly above it —
    // the exact failure ADR-039 §1 exists to prevent.
    const opening = breakdown("2026-01-01", "100000.00", [
      item("a", "depository", "100000.00"),
      { ...item("eur", "depository", "9999.00"), currency: "EUR" },
    ]);
    const closing = breakdown("2026-06-30", "140200.00", [
      item("a", "depository", "140200.00"),
      { ...item("eur", "depository", "8888.00"), currency: "EUR" },
    ]);

    const result = endpointsFor(opening, closing);

    expect(result.opening).toBe("100000.00");
    expect(result.closing).toBe("140200.00");
    expect(result.delta).toBe("40200.00");
  });

  it("reports a negative delta without clamping it", () => {
    const result = endpointsFor(
      breakdown("2026-01-01", "50000.00", []),
      breakdown("2026-06-30", "42500.00", []),
    );

    expect(result.delta).toBe("-7500.00");
  });

  it("derives the delta for an account present at BOTH endpoints", () => {
    const result = endpointsFor(
      breakdown("2026-01-01", "1000.00", [item("a", "depository", "1000.00")]),
      breakdown("2026-06-30", "1750.50", [item("a", "depository", "1750.50")]),
    );

    expect(result.byAccount.get("a")).toEqual({
      accountId: "a",
      accountName: "acct a",
      accountType: "depository",
      opening: "1000.00",
      closing: "1750.50",
      delta: "750.50",
      presence: "both",
    });
    expect(result.asymmetric).toEqual([]);
  });

  it("gives an account OPENED mid-window a zero opening and records the asymmetry", () => {
    const result = endpointsFor(
      breakdown("2026-01-01", "0.00", []),
      breakdown("2026-06-30", "4200.00", [item("new", "depository", "4200.00")]),
    );

    const entry = result.byAccount.get("new");
    expect(entry?.opening).toBe("0.00");
    expect(entry?.closing).toBe("4200.00");
    expect(entry?.delta).toBe("4200.00");
    expect(entry?.presence).toBe("opened");
    // Recorded as a diagnostic input, not smoothed over: a balance measured
    // against a counterpart that was never observed is a different kind of
    // number from one measured against a real opening balance.
    expect(result.asymmetric.map((a) => a.accountId)).toEqual(["new"]);
  });

  it("gives an account CLOSED mid-window a zero closing and records the asymmetry", () => {
    const result = endpointsFor(
      breakdown("2026-01-01", "4200.00", [item("gone", "depository", "4200.00")]),
      breakdown("2026-06-30", "0.00", []),
    );

    const entry = result.byAccount.get("gone");
    expect(entry?.closing).toBe("0.00");
    expect(entry?.delta).toBe("-4200.00");
    expect(entry?.presence).toBe("closed");
    expect(result.asymmetric.map((a) => a.accountId)).toEqual(["gone"]);
  });

  it("prefers the closing endpoint's name and type when both are present", () => {
    // A renamed or re-typed account should read as the user sees it today.
    const result = endpointsFor(
      breakdown("2026-01-01", "10.00", [
        { ...item("a", "depository", "10.00"), accountName: "Old name" },
      ]),
      breakdown("2026-06-30", "10.00", [
        { ...item("a", "personal_asset", "10.00"), accountName: "New name" },
      ]),
    );

    expect(result.byAccount.get("a")?.accountName).toBe("New name");
    expect(result.byAccount.get("a")?.accountType).toBe("personal_asset");
  });

  it("orders the asymmetric list deterministically by account id", () => {
    const result = endpointsFor(
      breakdown("2026-01-01", "0.00", []),
      breakdown("2026-06-30", "3.00", [
        item("z", "depository", "1.00"),
        item("a", "depository", "1.00"),
        item("m", "depository", "1.00"),
      ]),
    );

    expect(result.asymmetric.map((a) => a.accountId)).toEqual(["a", "m", "z"]);
  });

  it("rejects a window that runs backwards rather than reporting a mirrored delta", () => {
    expect(() =>
      endpointsFor(breakdown("2026-06-30", "0.00", []), breakdown("2026-01-01", "0.00", [])),
    ).toThrow();
  });

  it("accepts a single-instant window", () => {
    // A zero-length range is degenerate but legal; every rung comes out zero.
    const same = endpointsFor(
      breakdown("2026-06-30", "500.00", [item("a", "depository", "500.00")]),
      breakdown("2026-06-30", "500.00", [item("a", "depository", "500.00")]),
    );

    expect(same.delta).toBe("0.00");
  });
});

describe("endpointsOfType", () => {
  it("selects only the requested account types, in account-id order", () => {
    const result = endpointsFor(
      breakdown("2026-01-01", "0.00", [
        item("home", "property", "400000.00"),
        item("car", "personal_asset", "20000.00"),
        item("chk", "depository", "1000.00"),
      ]),
      breakdown("2026-06-30", "0.00", [
        item("home", "property", "410000.00"),
        item("car", "personal_asset", "18000.00"),
        item("chk", "depository", "1500.00"),
      ]),
    );

    const picked = endpointsOfType(result.byAccount, ["property", "personal_asset"]);

    expect(picked.map((e) => e.accountId)).toEqual(["car", "home"]);
  });

  it("returns an empty list when no account matches", () => {
    const result = endpointsFor(
      breakdown("2026-01-01", "0.00", [item("chk", "depository", "1.00")]),
      breakdown("2026-06-30", "0.00", [item("chk", "depository", "2.00")]),
    );

    expect(endpointsOfType(result.byAccount, ["property"])).toEqual([]);
  });
});

describe("assertWindow", () => {
  it("throws on a backwards window and names the caller", () => {
    // Pinned here rather than only through its three callers: a shared guard
    // that is exercised solely by consumers is one refactor away from being
    // silently emptied. Caught by mutation-checking this suite — emptying
    // `assertWindow` left `endpoints.test.ts` green, because `endpointsFor`
    // has its own inline check and never calls it.
    expect(() => assertWindow("2026-06-30", "2026-01-01", "someRung")).toThrow(/someRung/);
  });

  it("accepts a forward window and a single-instant window", () => {
    expect(() => assertWindow("2026-01-01", "2026-06-30", "someRung")).not.toThrow();
    expect(() => assertWindow("2026-01-01", "2026-01-01", "someRung")).not.toThrow();
  });
});

describe("withinWindow", () => {
  it("is inclusive at both ends, matching resolveRange", () => {
    expect(withinWindow("2026-01-01", "2026-01-01", "2026-06-30")).toBe(true);
    expect(withinWindow("2026-06-30", "2026-01-01", "2026-06-30")).toBe(true);
    expect(withinWindow("2025-12-31", "2026-01-01", "2026-06-30")).toBe(false);
    expect(withinWindow("2026-07-01", "2026-01-01", "2026-06-30")).toBe(false);
  });
});
