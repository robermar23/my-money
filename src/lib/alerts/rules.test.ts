import { describe, expect, it } from "vitest";
import {
  type AlertThresholds,
  type PriceTargetInput,
  balanceDropAlerts,
  itemLoginRequiredAlerts,
  largeTransactionAlerts,
  priceTargetAlerts,
  stalePriceAlerts,
  staleSnapshotAlerts,
  syncFailureAlerts,
  thresholdsFromEnv,
} from "./rules.ts";

const THRESH: AlertThresholds = {
  largeTxnUsd: 2000,
  balanceDropPct: 25,
  staleDays: 3,
  currency: "USD",
};
const NOW = new Date("2026-06-07T12:00:00.000Z");

describe("largeTransactionAlerts", () => {
  const txn = (over: Partial<{ id: string; amount: string }>) => ({
    id: "t1",
    accountId: "a1",
    postedAt: "2026-06-07",
    amount: "-50.00",
    name: "Store",
    ...over,
  });

  it("fires when |amount| exceeds the threshold (outflow magnitude counts)", () => {
    const out = largeTransactionAlerts([txn({ amount: "-2500.00" })], THRESH);
    expect(out).toHaveLength(1);
    expect(out[0]?.type).toBe("large_transaction");
    // Title carries NO raw amount.
    expect(out[0]?.title).not.toMatch(/2500|2,500/);
    expect(out[0]?.detail.amount).toBe("-2500.00");
  });

  it("is silent at or below the threshold", () => {
    expect(largeTransactionAlerts([txn({ amount: "2000.00" })], THRESH)).toHaveLength(0);
    expect(largeTransactionAlerts([txn({ amount: "-1999.99" })], THRESH)).toHaveLength(0);
  });

  it("dedups stably per transaction id", () => {
    const a = largeTransactionAlerts([txn({ id: "tX", amount: "-5000.00" })], THRESH);
    const b = largeTransactionAlerts([txn({ id: "tX", amount: "-5000.00" })], THRESH);
    expect(a[0]?.dedupHash).toBe(b[0]?.dedupHash);
  });
});

describe("balanceDropAlerts", () => {
  const pair = (over: Partial<{ priorBalance: string; latestBalance: string }>) => ({
    accountId: "a1",
    accountName: "Checking",
    latestDate: "2026-06-07",
    priorBalance: "1000.00",
    latestBalance: "1000.00",
    ...over,
  });

  it("fires when the drop exceeds the percentage threshold", () => {
    // 1000 → 730 is a 27% drop (> 25%).
    const out = balanceDropAlerts([pair({ latestBalance: "730.00" })], THRESH);
    expect(out).toHaveLength(1);
    expect(out[0]?.title).not.toMatch(/\d{3}/); // no raw amounts in the title
  });

  it("does not fire at exactly the threshold (strictly greater)", () => {
    // 1000 → 750 is exactly a 25% drop.
    expect(balanceDropAlerts([pair({ latestBalance: "750.00" })], THRESH)).toHaveLength(0);
  });

  it("ignores rising balances and non-positive baselines", () => {
    expect(balanceDropAlerts([pair({ latestBalance: "1500.00" })], THRESH)).toHaveLength(0);
    expect(
      balanceDropAlerts([pair({ priorBalance: "0.00", latestBalance: "-500.00" })], THRESH),
    ).toHaveLength(0);
  });
});

describe("itemLoginRequiredAlerts", () => {
  it("fires for each broken status and marks revoked as critical", () => {
    const out = itemLoginRequiredAlerts([
      { id: "i1", institutionName: "M&T", status: "login_required" },
      { id: "i2", institutionName: "Amex", status: "revoked" },
      { id: "i3", institutionName: "Fidelity", status: "active" },
    ]);
    expect(out).toHaveLength(2);
    expect(out.find((a) => a.detail.institutionName === "Amex")?.severity).toBe("critical");
    expect(out.find((a) => a.detail.institutionName === "M&T")?.severity).toBe("warning");
  });

  it("keys dedup on status so a status change re-fires", () => {
    const a = itemLoginRequiredAlerts([
      { id: "i1", institutionName: "X", status: "login_required" },
    ]);
    const b = itemLoginRequiredAlerts([{ id: "i1", institutionName: "X", status: "revoked" }]);
    expect(a[0]?.dedupHash).not.toBe(b[0]?.dedupHash);
  });
});

describe("staleSnapshotAlerts / stalePriceAlerts", () => {
  it("fires when the latest snapshot is older than staleDays, not when fresh", () => {
    const stale = staleSnapshotAlerts(
      [
        { accountId: "a1", accountName: "Old", latestSnapshotDate: "2026-06-01" }, // 6 days
        { accountId: "a2", accountName: "Fresh", latestSnapshotDate: "2026-06-06" }, // 1 day
      ],
      NOW,
      THRESH,
    );
    expect(stale).toHaveLength(1);
    expect(stale[0]?.detail.accountId).toBe("a1");
  });

  it("skips accounts/symbols that were never snapshotted/priced (null)", () => {
    expect(
      staleSnapshotAlerts(
        [{ accountId: "a1", accountName: "X", latestSnapshotDate: null }],
        NOW,
        THRESH,
      ),
    ).toHaveLength(0);
    expect(stalePriceAlerts([{ symbol: "AAPL", latestPriceDate: null }], NOW, THRESH)).toHaveLength(
      0,
    );
  });

  it("flags a stale held-symbol price as info severity", () => {
    const out = stalePriceAlerts([{ symbol: "AAPL", latestPriceDate: "2026-06-01" }], NOW, THRESH);
    expect(out).toHaveLength(1);
    expect(out[0]?.severity).toBe("info");
    expect(out[0]?.detail.symbol).toBe("AAPL");
  });
});

describe("syncFailureAlerts", () => {
  it("fires per failed run and keeps the error in detail (dedup on run id)", () => {
    const out = syncFailureAlerts([
      { id: "r1", institutionName: "M&T", error: "ITEM_LOGIN_REQUIRED", startedAt: "2026-06-07" },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.detail.error).toBe("ITEM_LOGIN_REQUIRED");
  });
});

describe("priceTargetAlerts", () => {
  const target = (over: Partial<PriceTargetInput>): PriceTargetInput => ({
    targetId: "tgt1",
    watchlistItemId: "wl1",
    symbol: "AAPL",
    direction: "above",
    threshold: "200.00000000",
    latestClose: "150.00000000",
    latestDate: "2026-06-07",
    currency: "USD",
    ...over,
  });

  it("fires an 'above' target when the close meets or exceeds the threshold", () => {
    const out = priceTargetAlerts([target({ direction: "above", latestClose: "205.00000000" })]);
    expect(out).toHaveLength(1);
    expect(out[0]?.type).toBe("price_target");
    expect(out[0]?.severity).toBe("info");
    expect(out[0]?.detail.price).toBe("205.00000000");
    expect(out[0]?.detail.threshold).toBe("200.00000000");
  });

  it("fires a 'below' target when the close falls to or under the threshold", () => {
    const out = priceTargetAlerts([
      target({ direction: "below", threshold: "120.00000000", latestClose: "115.00000000" }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.detail.direction).toBe("below");
  });

  it("does not fire when the close has not yet crossed", () => {
    expect(
      priceTargetAlerts([target({ direction: "above", latestClose: "199.99999999" })]),
    ).toHaveLength(0);
    expect(
      priceTargetAlerts([
        target({ direction: "below", threshold: "120.00000000", latestClose: "120.00000001" }),
      ]),
    ).toHaveLength(0);
  });

  it("fires at exact equality (inclusive boundary, both directions)", () => {
    expect(
      priceTargetAlerts([target({ direction: "above", latestClose: "200.00000000" })]),
    ).toHaveLength(1);
    expect(
      priceTargetAlerts([
        target({ direction: "below", threshold: "200.00000000", latestClose: "200.00000000" }),
      ]),
    ).toHaveLength(1);
  });

  it("skips an unpriced symbol (no latest close yet)", () => {
    expect(priceTargetAlerts([target({ latestClose: null, latestDate: null })])).toHaveLength(0);
  });

  it("keeps the title free of digits (figures live only in detail)", () => {
    const out = priceTargetAlerts([target({ direction: "above", latestClose: "205.00000000" })]);
    expect(out[0]?.title).not.toMatch(/\d/);
    expect(out[0]?.title).toBe("AAPL hit your above target");
  });

  it("attaches pretend P&L to detail only when provided", () => {
    const withPnl = priceTargetAlerts([
      target({ latestClose: "205.00000000", pretendPnl: { gainAbsolute: "55.00" } }),
    ]);
    expect(withPnl[0]?.detail.pretendPnl).toEqual({ gainAbsolute: "55.00" });
    const withoutPnl = priceTargetAlerts([target({ latestClose: "205.00000000" })]);
    expect(withoutPnl[0]?.detail.pretendPnl).toBeUndefined();
  });

  it("dedups per (target, day): same day stable, new day re-fires", () => {
    const a = priceTargetAlerts([
      target({ latestClose: "205.00000000", latestDate: "2026-06-07" }),
    ]);
    const b = priceTargetAlerts([
      target({ latestClose: "205.00000000", latestDate: "2026-06-07" }),
    ]);
    const c = priceTargetAlerts([
      target({ latestClose: "205.00000000", latestDate: "2026-06-08" }),
    ]);
    expect(a[0]?.dedupHash).toBe(b[0]?.dedupHash);
    expect(a[0]?.dedupHash).not.toBe(c[0]?.dedupHash);
  });
});

describe("thresholdsFromEnv", () => {
  it("uses defaults when unset and parses overrides", () => {
    expect(thresholdsFromEnv({})).toEqual({
      largeTxnUsd: 2000,
      balanceDropPct: 25,
      staleDays: 3,
      currency: "USD",
    });
    expect(thresholdsFromEnv({ ALERT_LARGE_TXN_USD: "5000", ALERT_STALE_DAYS: "7" })).toMatchObject(
      { largeTxnUsd: 5000, staleDays: 7 },
    );
  });
});
