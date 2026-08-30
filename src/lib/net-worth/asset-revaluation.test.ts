// @vitest-environment node
import { describe, expect, it } from "vitest";
import { assetRevaluation } from "./asset-revaluation.ts";
import type { AccountEndpoint } from "./endpoints.ts";

/**
 * P17-08 — the revaluation rung, per ADR-041 §5.
 *
 * A `property` or `personal_asset` account changes value only by being
 * revalued — that is what the type *means*. So the rung is the delta, by
 * definition, and there is deliberately no transaction data anywhere in this
 * file.
 */

function endpoint(over: Partial<AccountEndpoint> & Pick<AccountEndpoint, "accountId">) {
  const opening = over.opening ?? "0.00";
  const closing = over.closing ?? "0.00";
  return {
    accountName: `acct ${over.accountId}`,
    accountType: "property",
    presence: "both" as const,
    ...over,
    opening,
    closing,
    delta: over.delta ?? String(Number(closing) - Number(opening)),
  } satisfies AccountEndpoint;
}

function byAccount(...entries: readonly AccountEndpoint[]): ReadonlyMap<string, AccountEndpoint> {
  return new Map(entries.map((e) => [e.accountId, e]));
}

describe("assetRevaluation", () => {
  it("returns zero for an empty book", () => {
    const result = assetRevaluation(byAccount());

    expect(result.revaluation).toBe("0.00");
    expect(result.byAccount).toEqual([]);
    expect(result.asymmetric).toEqual([]);
  });

  it("sums property and personal_asset deltas", () => {
    const result = assetRevaluation(
      byAccount(
        endpoint({
          accountId: "home",
          accountType: "property",
          opening: "400000.00",
          closing: "412000.00",
          delta: "12000.00",
        }),
        endpoint({
          accountId: "truck",
          accountType: "personal_asset",
          opening: "28000.00",
          closing: "25500.00",
          delta: "-2500.00",
        }),
      ),
    );

    // A house that appreciated and a truck that depreciated. The rung is the
    // net, and the depreciation is not clamped away.
    expect(result.revaluation).toBe("9500.00");
    expect(result.byAccount.map((a) => a.accountId)).toEqual(["home", "truck"]);
  });

  it("ignores every other account type", () => {
    // Cash, cards, brokerages and loans all move for reasons this rung does not
    // describe. Counting any of them here would double-count against `saved`,
    // `investment_return`, or `debt_principal`.
    const result = assetRevaluation(
      byAccount(
        endpoint({
          accountId: "chk",
          accountType: "depository",
          opening: "1000.00",
          closing: "9000.00",
          delta: "8000.00",
        }),
        endpoint({
          accountId: "card",
          accountType: "credit_card",
          opening: "-500.00",
          closing: "-200.00",
          delta: "300.00",
        }),
        endpoint({
          accountId: "brk",
          accountType: "investment",
          opening: "50000.00",
          closing: "58000.00",
          delta: "8000.00",
        }),
        endpoint({
          accountId: "mtg",
          accountType: "loan",
          opening: "-190000.00",
          closing: "-186000.00",
          delta: "4000.00",
        }),
      ),
    );

    expect(result.revaluation).toBe("0.00");
    expect(result.byAccount).toEqual([]);
  });

  it("reports a home first tracked mid-window as an asymmetric endpoint, not as appreciation", () => {
    // The whole value lands in the rung, because the anchored delta contains it
    // too and the identity has to hold. But "we started tracking your house" is
    // not "your house went up $400,000", so the account is named separately for
    // the residual diagnostics to pick up.
    const result = assetRevaluation(
      byAccount(
        endpoint({
          accountId: "home",
          accountType: "property",
          opening: "0.00",
          closing: "400000.00",
          delta: "400000.00",
          presence: "opened",
        }),
      ),
    );

    expect(result.revaluation).toBe("400000.00");
    expect(result.asymmetric.map((a) => a.accountId)).toEqual(["home"]);
  });

  it("does not flag an asset present at both endpoints as asymmetric", () => {
    const result = assetRevaluation(
      byAccount(
        endpoint({
          accountId: "home",
          accountType: "property",
          opening: "400000.00",
          closing: "412000.00",
          delta: "12000.00",
        }),
      ),
    );

    expect(result.asymmetric).toEqual([]);
  });

  it("counts an asset sold mid-window at its full negative delta", () => {
    const result = assetRevaluation(
      byAccount(
        endpoint({
          accountId: "boat",
          accountType: "personal_asset",
          opening: "30000.00",
          closing: "0.00",
          delta: "-30000.00",
          presence: "closed",
        }),
      ),
    );

    expect(result.revaluation).toBe("-30000.00");
    expect(result.asymmetric.map((a) => a.accountId)).toEqual(["boat"]);
  });
});
