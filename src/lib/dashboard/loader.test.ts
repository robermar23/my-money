// @vitest-environment node

import type { Holding } from "@/db/schema/holdings.ts";
import type { SpendingSummary } from "@/lib/analytics/spending.ts";
import type { BudgetLine, BudgetVsActual } from "@/lib/budgets/queries.ts";
import type {
  BalanceOnlyAccount,
  HoldingSnapshotRow,
  InvestmentFlowRow,
  ValuePoint,
} from "@/lib/investments/queries.ts";
import type { ValuedPosition } from "@/lib/investments/valued.ts";
import { Money } from "@/lib/money/money.ts";
import type { NetWorthBreakdown, NetWorthPoint } from "@/lib/net-worth/compute.ts";
import type { WatchlistRow } from "@/lib/watchlist/queries.ts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadDashboard } from "./loader.ts";

/**
 * P13-17 — `loadDashboard` composition tests (ADR-029).
 *
 * The loader owns exactly one job: **compose already-tested library functions
 * and discriminate each card's status**. So this file mocks every DB-touching
 * read at the module boundary and asserts the *composition* — which query feeds
 * which card, what window is passed down, and when a card degrades to
 * `empty`/`insufficient`. The libraries themselves (allocation math, TWR,
 * forward income, `Money`) are left REAL and are covered by their own suites;
 * re-asserting their arithmetic here would test them twice and pin the loader
 * to nothing.
 *
 * Range parsing (P13-01) and the delta math (P13-03) have their own files —
 * `range.test.ts` and `delta.test.ts` — so they are exercised here only through
 * the fields the loader hands the hero.
 */

/** Query mocks, hoisted so the `vi.mock` factories below can close over them. */
const q = vi.hoisted(() => ({
  computeNetWorth: vi.fn(),
  netWorthSeries: vi.fn(),
  listValuedPositions: vi.fn(),
  listHoldingSnapshots: vi.fn(),
  listInvestmentFlows: vi.fn(),
  benchmarkCloseSeries: vi.fn(),
  budgetVsActual: vi.fn(),
  spendingSummary: vi.fn(),
  listOpenAlerts: vi.fn(),
  listWatchlist: vi.fn(),
}));

// Only the *reads* are replaced. The pure modules the loader composes —
// allocation.ts, forward-income.ts, performance.ts, money.ts — stay real.
vi.mock("@/lib/net-worth/compute.ts", () => ({
  computeNetWorth: q.computeNetWorth,
  netWorthSeries: q.netWorthSeries,
}));
vi.mock("@/lib/investments/valued.ts", () => ({
  listValuedPositions: q.listValuedPositions,
}));
vi.mock("@/lib/investments/queries.ts", () => ({
  listHoldingSnapshots: q.listHoldingSnapshots,
  listInvestmentFlows: q.listInvestmentFlows,
  benchmarkCloseSeries: q.benchmarkCloseSeries,
}));
vi.mock("@/lib/analytics/spending.ts", () => ({ spendingSummary: q.spendingSummary }));
vi.mock("@/lib/alerts/queries.ts", () => ({ listOpenAlerts: q.listOpenAlerts }));
vi.mock("@/lib/watchlist/queries.ts", () => ({ listWatchlist: q.listWatchlist }));
// `monthRange` is pure and drives the spending window — keep the real one.
vi.mock("@/lib/budgets/queries.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/budgets/queries.ts")>()),
  budgetVsActual: q.budgetVsActual,
}));

/** Fixed "today": mid-month (so a run-rate projection is meaningful) and mid-year. */
const NOW = new Date("2026-06-15T00:00:00Z");
const USD = "USD";
const ACCOUNT_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

// ── Fixture factories ────────────────────────────────────────────────────────

function holdingRow(over: Partial<Holding> = {}): Holding {
  return {
    id: "hhhhhhhh-hhhh-hhhh-hhhh-hhhhhhhhhhhh",
    accountId: ACCOUNT_ID,
    symbol: "VTI",
    quantity: "100.00000000",
    quantityUnit: "shares",
    assetClass: "equity",
    costBasis: "10000.00",
    securityId: null,
    source: "manual",
    costBasisOverriddenAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

function valuedPosition(over: {
  readonly holding?: Partial<Holding>;
  readonly value?: string;
  readonly costBasis?: string | null;
  readonly dividendRate?: string | null;
}): ValuedPosition {
  return {
    position: {
      holding: holdingRow(over.holding),
      accountId: ACCOUNT_ID,
      accountName: "Brokerage",
      accountType: "investment",
      accountCurrency: USD,
      securityName: "Vanguard Total Stock Market ETF",
      sector: null,
      industry: null,
      region: null,
      assetType: null,
      dividendRate: over.dividendRate ?? null,
    },
    value: Money.fromString(over.value ?? "25000.00", USD),
    costBasis: over.costBasis === null ? null : Money.fromString(over.costBasis ?? "10000.00", USD),
    priced: true,
  };
}

function balanceOnly(balance: string): BalanceOnlyAccount {
  return {
    accountId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
    accountName: "Employer 401k",
    accountType: "investment",
    currency: USD,
    balance,
  };
}

function snapshot(date: string, value: string): HoldingSnapshotRow {
  return {
    holdingId: "hhhhhhhh-hhhh-hhhh-hhhh-hhhhhhhhhhhh",
    date,
    quantity: "100.00000000",
    value,
    costBasis: "10000.00",
    currency: USD,
  };
}

function budgetLine(
  over: Partial<BudgetLine> & Pick<BudgetLine, "categoryId" | "name">,
): BudgetLine {
  return {
    kind: "expense",
    groupId: null,
    groupName: null,
    target: "0.00",
    hasBudget: false,
    actual: "0.00",
    remaining: "0.00",
    pct: 0,
    projected: null,
    ...over,
  };
}

function budget(over: Partial<BudgetVsActual> = {}): BudgetVsActual {
  return {
    month: "2026-06",
    lines: [],
    groups: [],
    totals: { target: "0.00", actual: "0.00", remaining: "0.00", pct: 0, projected: null },
    ...over,
  };
}

function summary(over: Partial<SpendingSummary> = {}): SpendingSummary {
  return {
    income: "0.00",
    expense: "0.00",
    net: "0.00",
    uncategorizedCount: 0,
    uncategorizedOutflow: "0.00",
    ...over,
  };
}

function watchRow(over: {
  readonly id: string;
  readonly symbol: string;
  readonly percent: string | null;
  readonly absolute: string | null;
}): WatchlistRow {
  const priced = over.percent !== null && over.absolute !== null;
  return {
    id: over.id,
    symbol: over.symbol,
    label: null,
    assetClass: "equity",
    currency: USD,
    latestClose: priced ? "100.00000000" : null,
    valuation: {
      value: priced ? Money.fromString("1000.00", USD) : null,
      costBasis: priced ? Money.fromString("900.00", USD) : null,
      gainLoss: {
        absolute: over.absolute === null ? null : Money.fromString(over.absolute, USD),
        percent: over.percent,
      },
    },
    hasPretend: priced,
    activeTargetCount: 0,
  };
}

/** The brand-new-install baseline: every read returns "nothing here yet". */
function emptyBook(): void {
  const nw: NetWorthBreakdown = { asOf: NOW, total: Money.zero(USD), items: [] };
  q.computeNetWorth.mockResolvedValue(nw);
  q.netWorthSeries.mockResolvedValue([] as NetWorthPoint[]);
  q.listValuedPositions.mockResolvedValue({ positions: [], balanceOnly: [] });
  q.listHoldingSnapshots.mockResolvedValue([] as HoldingSnapshotRow[]);
  q.listInvestmentFlows.mockResolvedValue([] as InvestmentFlowRow[]);
  q.benchmarkCloseSeries.mockResolvedValue([] as ValuePoint[]);
  q.budgetVsActual.mockResolvedValue(budget());
  q.spendingSummary.mockResolvedValue(summary());
  q.listOpenAlerts.mockResolvedValue([]);
  q.listWatchlist.mockResolvedValue([] as WatchlistRow[]);
}

beforeEach(() => {
  vi.clearAllMocks();
  emptyBook();
});

// ── Composition wiring ───────────────────────────────────────────────────────

describe("loadDashboard — composition", () => {
  it("fans out every read exactly once per load", async () => {
    await loadDashboard("1Y", NOW);
    for (const [name, fn] of Object.entries(q)) {
      expect(fn, `${name} should be called exactly once`).toHaveBeenCalledTimes(1);
    }
  });

  it("passes the resolved range window to the range-scoped reads", async () => {
    await loadDashboard("3M", NOW);
    const window = { from: "2026-03-15", to: "2026-06-15" };
    expect(q.listHoldingSnapshots).toHaveBeenCalledWith(window);
    expect(q.listInvestmentFlows).toHaveBeenCalledWith(window);
    expect(q.benchmarkCloseSeries).toHaveBeenCalledWith("^GSPC", window);
    // Valuation is "as of today", not as of the window — the hero is a *current*
    // figure that the range only rewinds for history.
    expect(q.listValuedPositions).toHaveBeenCalledWith("2026-06-15");
  });

  it("scopes the spending card to the calendar month, not the range", async () => {
    await loadDashboard("ALL", NOW);
    expect(q.budgetVsActual).toHaveBeenCalledWith("2026-06", NOW);
    expect(q.spendingSummary).toHaveBeenCalledWith({ from: "2026-06-01", to: "2026-06-30" });
  });

  it("clips the hero series to the window and echoes the range back", async () => {
    q.computeNetWorth.mockResolvedValue({
      asOf: NOW,
      total: Money.fromString("125000.00", USD),
      items: [
        {
          accountId: ACCOUNT_ID,
          accountName: "Brokerage",
          accountType: "investment",
          currency: USD,
          balance: Money.fromString("125000.00", USD),
        },
      ],
    } satisfies NetWorthBreakdown);
    q.netWorthSeries.mockResolvedValue([
      { date: "2026-05-01", value: "120000.00" },
      { date: "2026-06-01", value: "125000.00" },
    ] satisfies NetWorthPoint[]);

    const data = await loadDashboard("3M", NOW);

    expect(data.range).toBe("3M");
    expect(data.window).toEqual({ from: "2026-03-15", to: "2026-06-15" });
    expect(data.baseCurrency).toBe(USD);
    expect(data.hasAnyAccount).toBe(true);
    // Windowing is the query's job, not the loader's: it pushes the active
    // window down so a 3M view reads three months instead of fetching all of
    // history and filtering in JS (which is what made the hero the slowest
    // thing on the page). The loader must therefore pass the window through…
    expect(q.netWorthSeries).toHaveBeenCalledWith(USD, {
      from: "2026-03-15",
      to: "2026-06-15",
    });
    // …and hand the result to the card untouched.
    expect(data.netWorth.series.map((p) => p.date)).toEqual(["2026-05-01", "2026-06-01"]);
    // Money reaches the card as Money — never round-tripped through Number.
    expect(data.netWorth.total).toBeInstanceOf(Money);
    expect(data.netWorth.total.toString()).toBe("125000.00");
    expect(data.netWorth.delta.direction).toBe("up");
  });

  it("leaves the Phase 14 savings-rate seam unpopulated", async () => {
    // P13-13: the field exists on the type so P14-17 drops a card in; the
    // Phase 13 loader must never fabricate one.
    const data = await loadDashboard("1Y", NOW);
    expect(data.savingsRate).toBeUndefined();
  });
});

// ── Status discrimination, card by card ──────────────────────────────────────

describe("loadDashboard — brand-new install", () => {
  it("reports no accounts and degrades every card to empty", async () => {
    const data = await loadDashboard("1Y", NOW);

    expect(data.hasAnyAccount).toBe(false);
    expect(data.allocation.status).toBe("empty");
    expect(data.performance.status).toBe("empty");
    expect(data.spending.status).toBe("empty");
    expect(data.income.status).toBe("empty");
    expect(data.alerts.status).toBe("empty");
    expect(data.movers.status).toBe("empty");
    // The hero still renders — it is the dashboard's spine, at $0.
    expect(data.netWorth.total.isZero()).toBe(true);
    expect(data.netWorth.series).toEqual([]);
  });
});

describe("loadDashboard — allocation card", () => {
  it("slices priced positions when investments exist", async () => {
    q.listValuedPositions.mockResolvedValue({
      positions: [valuedPosition({ value: "30000.00" })],
      balanceOnly: [],
    });

    const allocation = (await loadDashboard("1Y", NOW)).allocation;

    expect(allocation.status).toBe("ok");
    if (allocation.status !== "ok") return;
    expect(allocation.total.toString()).toBe("30000.00");
    // One equity position → a single slice carrying the whole book.
    expect(allocation.slices).toHaveLength(1);
    expect(allocation.slices[0]?.percent).toBe("100.00");
  });

  it("counts balance-only accounts even with zero itemized positions", async () => {
    // A 401k Plaid reports only as a total still belongs in the donut.
    q.listValuedPositions.mockResolvedValue({
      positions: [],
      balanceOnly: [balanceOnly("80000.00")],
    });

    const allocation = (await loadDashboard("1Y", NOW)).allocation;

    expect(allocation.status).toBe("ok");
    if (allocation.status !== "ok") return;
    expect(allocation.total.toString()).toBe("80000.00");
  });
});

describe("loadDashboard — performance card", () => {
  const positions = { positions: [valuedPosition({})], balanceOnly: [] };

  it("is empty when there are no investments at all", async () => {
    expect((await loadDashboard("1Y", NOW)).performance.status).toBe("empty");
  });

  it("is insufficient with fewer than two snapshot days in range (ADR-021)", async () => {
    q.listValuedPositions.mockResolvedValue(positions);
    q.listHoldingSnapshots.mockResolvedValue([snapshot("2026-06-01", "25000.00")]);

    // Holdings exist but the window has one data point — a return % computed
    // from a single day would be fabricated, so the card says so instead.
    expect((await loadDashboard("1Y", NOW)).performance.status).toBe("insufficient");
  });

  it("computes TWR + benchmark once two snapshot days exist", async () => {
    q.listValuedPositions.mockResolvedValue(positions);
    q.listHoldingSnapshots.mockResolvedValue([
      snapshot("2026-01-02", "20000.00"),
      snapshot("2026-06-01", "25000.00"),
    ]);
    q.benchmarkCloseSeries.mockResolvedValue([
      { date: "2026-01-02", value: "4000.00" },
      { date: "2026-06-01", value: "4400.00" },
    ] satisfies ValuePoint[]);

    const performance = (await loadDashboard("1Y", NOW)).performance;

    expect(performance.status).toBe("ok");
    if (performance.status !== "ok") return;
    // Exact percentages belong to performance.test.ts — here we pin that the
    // loader wired both series through and derived the delta from the pair.
    expect(performance.twr).not.toBeNull();
    expect(performance.benchmarkTwr).not.toBeNull();
    expect(performance.benchmarkDelta).not.toBeNull();
    expect(performance.gainLoss.length).toBeGreaterThan(0);
  });

  it("leaves the benchmark delta null when the benchmark has no prices", async () => {
    q.listValuedPositions.mockResolvedValue(positions);
    q.listHoldingSnapshots.mockResolvedValue([
      snapshot("2026-01-02", "20000.00"),
      snapshot("2026-06-01", "25000.00"),
    ]);

    const performance = (await loadDashboard("1Y", NOW)).performance;
    if (performance.status !== "ok") throw new Error("expected an ok performance card");
    expect(performance.benchmarkTwr).toBeNull();
    expect(performance.benchmarkDelta).toBeNull();
  });
});

describe("loadDashboard — spending card", () => {
  it("is empty only when nothing is budgeted AND nothing is spent", async () => {
    expect((await loadDashboard("1Y", NOW)).spending.status).toBe("empty");
  });

  it("stays ok with spend but no budgets (so the card can nudge, not hide)", async () => {
    q.budgetVsActual.mockResolvedValue(
      budget({
        totals: {
          target: "0.00",
          actual: "450.00",
          remaining: "-450.00",
          pct: 0,
          projected: "900.00",
        },
      }),
    );
    q.spendingSummary.mockResolvedValue(summary({ expense: "450.00", net: "-450.00" }));

    const spending = (await loadDashboard("1Y", NOW)).spending;

    expect(spending.status).toBe("ok");
    if (spending.status !== "ok") return;
    expect(spending.hasBudgets).toBe(false);
    expect(spending.totalSpend.toString()).toBe("450.00");
    expect(spending.projected?.toString()).toBe("900.00");
    expect(spending.overBudget).toEqual([]);
  });

  it("keeps the top three overages, largest first, and drops under-budget lines", async () => {
    q.budgetVsActual.mockResolvedValue(
      budget({
        lines: [
          budgetLine({
            categoryId: "c1",
            name: "Groceries",
            hasBudget: true,
            target: "500.00",
            actual: "560.00",
          }),
          budgetLine({
            categoryId: "c2",
            name: "Dining",
            hasBudget: true,
            target: "200.00",
            actual: "350.00",
          }),
          budgetLine({
            categoryId: "c3",
            name: "Transit",
            hasBudget: true,
            target: "100.00",
            actual: "180.00",
          }),
          budgetLine({
            categoryId: "c4",
            name: "Pets",
            hasBudget: true,
            target: "80.00",
            actual: "90.00",
          }),
          // Under budget → never an "over" line.
          budgetLine({
            categoryId: "c5",
            name: "Utilities",
            hasBudget: true,
            target: "300.00",
            actual: "120.00",
          }),
          // Spend with no budget set → excluded (nothing to be over).
          budgetLine({ categoryId: "c6", name: "Gifts", actual: "75.00" }),
        ],
        totals: {
          target: "1180.00",
          actual: "1375.00",
          remaining: "-195.00",
          pct: 117,
          projected: null,
        },
      }),
    );

    const spending = (await loadDashboard("1Y", NOW)).spending;
    if (spending.status !== "ok") throw new Error("expected an ok spending card");

    expect(spending.hasBudgets).toBe(true);
    expect(spending.overBudget.map((l) => l.name)).toEqual(["Dining", "Transit", "Groceries"]);
    expect(spending.overBudget.map((l) => l.over.toString())).toEqual(["150.00", "80.00", "60.00"]);
    expect(spending.projected).toBeNull();
  });
});

describe("loadDashboard — forward-income card", () => {
  it("is empty when no holding pays a dividend", async () => {
    q.listValuedPositions.mockResolvedValue({
      positions: [valuedPosition({ dividendRate: null })],
      balanceOnly: [],
    });
    expect((await loadDashboard("1Y", NOW)).income.status).toBe("empty");
  });

  it("surfaces the forward total, yield-on-cost, and top payers", async () => {
    q.listValuedPositions.mockResolvedValue({
      positions: [
        valuedPosition({
          holding: { id: "h-vym", symbol: "VYM", quantity: "100.00000000" },
          dividendRate: "3.50",
          costBasis: "10000.00",
        }),
        valuedPosition({
          holding: { id: "h-schd", symbol: "SCHD", quantity: "200.00000000" },
          dividendRate: "1.00",
          costBasis: "5000.00",
        }),
        // No rate → contributes nothing and never appears as a payer.
        valuedPosition({ holding: { id: "h-vti", symbol: "VTI" }, dividendRate: null }),
      ],
      balanceOnly: [],
    });

    const income = (await loadDashboard("1Y", NOW)).income;

    expect(income.status).toBe("ok");
    if (income.status !== "ok") return;
    // 100 × 3.50 + 200 × 1.00 — arithmetic owned by forward-income.test.ts.
    expect(income.forward12mo.toString()).toBe("550.00");
    expect(income.yieldOnCost).not.toBeNull();
    expect(income.topPayers.map((p) => p.symbol)).toEqual(["VYM", "SCHD"]);
    expect(income.topPayers.length).toBeLessThanOrEqual(3);
  });
});

describe("loadDashboard — alerts card", () => {
  it("is empty when nothing is open (the calm good-news state)", async () => {
    expect((await loadDashboard("1Y", NOW)).alerts.status).toBe("empty");
  });

  it("reports the full count but only the three most recent titles", async () => {
    q.listOpenAlerts.mockResolvedValue(
      Array.from({ length: 5 }, (_, i) => ({
        id: `alert-${i}`,
        title: `Alert ${i}`,
        detectedAt: NOW,
      })),
    );

    const alerts = (await loadDashboard("1Y", NOW)).alerts;

    expect(alerts.status).toBe("ok");
    if (alerts.status !== "ok") return;
    expect(alerts.count).toBe(5);
    expect(alerts.recent.map((a) => a.id)).toEqual(["alert-0", "alert-1", "alert-2"]);
    // ADR-015: titles are content-free — the loader must not attach figures.
    for (const a of alerts.recent) {
      expect(Object.keys(a).sort()).toEqual(["detectedAt", "id", "title"]);
    }
  });
});

describe("loadDashboard — watchlist movers card", () => {
  it("is empty when no watched item has a valued paper position", async () => {
    q.listWatchlist.mockResolvedValue([
      watchRow({ id: "w1", symbol: "NVDA", percent: null, absolute: null }),
    ]);
    expect((await loadDashboard("1Y", NOW)).movers.status).toBe("empty");
  });

  it("takes the two best and two worst movers, skipping unpriced rows", async () => {
    q.listWatchlist.mockResolvedValue([
      watchRow({ id: "w1", symbol: "AAA", percent: "12.00", absolute: "120.00" }),
      watchRow({ id: "w2", symbol: "BBB", percent: "8.00", absolute: "80.00" }),
      watchRow({ id: "w3", symbol: "CCC", percent: "1.00", absolute: "10.00" }),
      watchRow({ id: "w4", symbol: "DDD", percent: "-5.00", absolute: "-50.00" }),
      watchRow({ id: "w5", symbol: "EEE", percent: "-9.00", absolute: "-90.00" }),
      watchRow({ id: "w6", symbol: "FFF", percent: null, absolute: null }),
    ]);

    const movers = (await loadDashboard("1Y", NOW)).movers;

    expect(movers.status).toBe("ok");
    if (movers.status !== "ok") return;
    expect(movers.movers.map((m) => m.symbol)).toEqual(["AAA", "BBB", "DDD", "EEE"]);
    expect(movers.movers.map((m) => m.gain.toString())).toEqual([
      "120.00",
      "80.00",
      "-50.00",
      "-90.00",
    ]);
  });

  it("de-duplicates when fewer than four rows qualify", async () => {
    q.listWatchlist.mockResolvedValue([
      watchRow({ id: "w1", symbol: "AAA", percent: "12.00", absolute: "120.00" }),
      watchRow({ id: "w2", symbol: "BBB", percent: "-3.00", absolute: "-30.00" }),
    ]);

    const movers = (await loadDashboard("1Y", NOW)).movers;
    if (movers.status !== "ok") throw new Error("expected an ok movers card");
    // Top-2 and bottom-2 overlap entirely — the same row must not appear twice.
    expect(movers.movers.map((m) => m.id)).toEqual(["w1", "w2"]);
  });
});
