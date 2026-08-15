import "server-only";

import { db } from "@/db/client.ts";
import {
  type Holding,
  accountSnapshots,
  accounts,
  holdingLots,
  holdingSnapshots,
  holdings,
  investmentTransactions,
  prices,
  securities,
} from "@/db/schema/index.ts";
import { type SQL, and, asc, desc, eq, gte, inArray, lte, or, sql } from "drizzle-orm";

/**
 * Read helpers for the /investments dashboard (Phase 5, P5-21 → P5-23).
 *
 * "Investment" accounts are `investment` + `crypto_ira` — the two types whose
 * value comes from priced holdings rather than a balance or amortization.
 */

const INVESTMENT_TYPES = ["investment", "crypto_ira"] as const;

export interface InvestmentPosition {
  readonly holding: Holding;
  readonly accountId: string;
  readonly accountName: string;
  readonly accountType: string;
  readonly accountCurrency: string;
  /** Security display name (Plaid-sourced); null for hand-typed symbols. */
  readonly securityName: string | null;
  /** Enrichment metadata (ADR-020); null until the weekly job fills it. */
  readonly sector: string | null;
  readonly industry: string | null;
  readonly region: string | null;
  readonly assetType: string | null;
  /** Forward annual dividend rate ($/share); null when none/unenriched. */
  readonly dividendRate: string | null;
}

/** Every holding across investment/crypto_ira accounts, with account + security meta. */
export async function listInvestmentPositions(): Promise<InvestmentPosition[]> {
  const rows = await db
    .select({
      holding: holdings,
      accountName: accounts.name,
      accountType: accounts.type,
      accountCurrency: accounts.currency,
      securityName: securities.name,
      sector: securities.sector,
      industry: securities.industry,
      region: securities.region,
      assetType: securities.assetType,
      dividendRate: securities.dividendRate,
    })
    .from(holdings)
    .innerJoin(accounts, eq(holdings.accountId, accounts.id))
    .leftJoin(securities, eq(holdings.securityId, securities.id))
    .where(inArray(accounts.type, [...INVESTMENT_TYPES]))
    .orderBy(asc(accounts.name), asc(holdings.symbol));

  return rows.map((r) => ({
    holding: r.holding,
    accountId: r.holding.accountId,
    accountName: r.accountName,
    accountType: r.accountType,
    accountCurrency: r.accountCurrency,
    securityName: r.securityName,
    sector: r.sector,
    industry: r.industry,
    region: r.region,
    assetType: r.assetType,
    dividendRate: r.dividendRate,
  }));
}

export interface InvestmentLotRow {
  readonly holdingId: string;
  readonly quantity: string;
  readonly costBasisTotal: string;
  /**
   * Lot provenance — 'manual' | 'plaid' | 'income'. Carried so the UI can say
   * where a cost basis came from (P14-16); `resolveCostBasis` ignores it.
   */
  readonly source: string;
}

export interface BalanceOnlyAccount {
  readonly accountId: string;
  readonly accountName: string;
  readonly accountType: string;
  readonly currency: string;
  /** Latest snapshot balance (Plaid's reported balance for Plaid accounts). */
  readonly balance: string;
}

/**
 * Investment/crypto_ira accounts that carry a balance but NO itemized holdings —
 * e.g. a 401k whose plan Plaid reports only as a total, not per-fund. They have
 * value (their latest snapshot) yet contribute no positions, so the
 * holdings-centric queries above skip them. The /investments page lists them
 * separately and folds their value into the page total so it reconciles with
 * net worth.
 */
export async function listBalanceOnlyInvestmentAccounts(): Promise<BalanceOnlyAccount[]> {
  const invAccounts = await db
    .select({
      id: accounts.id,
      name: accounts.name,
      type: accounts.type,
      currency: accounts.currency,
    })
    .from(accounts)
    .where(inArray(accounts.type, [...INVESTMENT_TYPES]));

  const out: BalanceOnlyAccount[] = [];
  for (const a of invAccounts) {
    const [held] = await db
      .select({ id: holdings.id })
      .from(holdings)
      .where(eq(holdings.accountId, a.id))
      .limit(1);
    if (held) continue; // itemized — surfaced via listInvestmentPositions
    const [snap] = await db
      .select({ balance: accountSnapshots.balance })
      .from(accountSnapshots)
      .where(eq(accountSnapshots.accountId, a.id))
      .orderBy(desc(accountSnapshots.date))
      .limit(1);
    if (!snap) continue;
    out.push({
      accountId: a.id,
      accountName: a.name,
      accountType: a.type,
      currency: a.currency,
      balance: snap.balance,
    });
  }
  return out;
}

/** All cost-basis lots for investment-account holdings (for resolved basis). */
export async function listInvestmentLots(): Promise<InvestmentLotRow[]> {
  return db
    .select({
      holdingId: holdingLots.holdingId,
      quantity: holdingLots.quantity,
      costBasisTotal: holdingLots.costBasisTotal,
      source: holdingLots.source,
    })
    .from(holdingLots)
    .innerJoin(holdings, eq(holdingLots.holdingId, holdings.id))
    .innerJoin(accounts, eq(holdings.accountId, accounts.id))
    .where(inArray(accounts.type, [...INVESTMENT_TYPES]));
}

export interface IncomeTxnRow {
  readonly subtype: string | null;
  readonly tradeDate: string;
  readonly amount: string;
  readonly isoCurrencyCode: string;
}

/** Dividend + interest investment transactions across investment accounts. */
export async function listInvestmentIncome(): Promise<IncomeTxnRow[]> {
  return db
    .select({
      subtype: investmentTransactions.subtype,
      tradeDate: investmentTransactions.tradeDate,
      amount: investmentTransactions.amount,
      isoCurrencyCode: investmentTransactions.isoCurrencyCode,
    })
    .from(investmentTransactions)
    .innerJoin(accounts, eq(investmentTransactions.accountId, accounts.id))
    .where(
      and(
        inArray(accounts.type, [...INVESTMENT_TYPES]),
        or(
          eq(investmentTransactions.subtype, "dividend"),
          eq(investmentTransactions.subtype, "interest"),
        ),
      ),
    )
    .orderBy(asc(investmentTransactions.tradeDate));
}

// ── Historical value (holding_snapshots) — PLAN9 P9-04 ──────────────────────
//
// These feed the value-over-time / performance series (Batch 3) and the
// per-security drill-down (Batch 4). All monetary results stay strings, summed
// in SQL with `numeric` (never `Number`); the chart islands do the single
// `Number()` at the display edge. Single-currency aggregation today — true
// cross-currency FX is a logged Open Item (PLAN9 §Open Items).

export interface SnapshotRange {
  /** Inclusive lower bound (YYYY-MM-DD); omit for "from the beginning". */
  readonly from?: string;
  /** Inclusive upper bound (YYYY-MM-DD); omit for "up to the latest". */
  readonly to?: string;
  /** Restrict to these accounts; omit for all investment accounts. */
  readonly accountIds?: readonly string[];
  /** Restrict to these holdings; omit for all. */
  readonly holdingIds?: readonly string[];
}

export interface HoldingSnapshotRow {
  readonly holdingId: string;
  readonly date: string;
  readonly quantity: string;
  readonly value: string;
  readonly costBasis: string | null;
  readonly currency: string;
}

/** Build the shared WHERE for the holding-snapshot series queries. */
function snapshotFilters(range: SnapshotRange, restrictToInvestment: boolean): SQL[] {
  const conds: SQL[] = [];
  if (restrictToInvestment) conds.push(inArray(accounts.type, [...INVESTMENT_TYPES]));
  if (range.from) conds.push(gte(holdingSnapshots.date, range.from));
  if (range.to) conds.push(lte(holdingSnapshots.date, range.to));
  if (range.accountIds && range.accountIds.length > 0) {
    conds.push(inArray(holdings.accountId, [...range.accountIds]));
  }
  if (range.holdingIds && range.holdingIds.length > 0) {
    conds.push(inArray(holdingSnapshots.holdingId, [...range.holdingIds]));
  }
  return conds;
}

/** Raw per-holding snapshot rows, filtered + chronologically ordered. */
export async function listHoldingSnapshots(
  range: SnapshotRange = {},
): Promise<HoldingSnapshotRow[]> {
  return db
    .select({
      holdingId: holdingSnapshots.holdingId,
      date: holdingSnapshots.date,
      quantity: holdingSnapshots.quantity,
      value: holdingSnapshots.value,
      costBasis: holdingSnapshots.costBasis,
      currency: holdingSnapshots.currency,
    })
    .from(holdingSnapshots)
    .innerJoin(holdings, eq(holdingSnapshots.holdingId, holdings.id))
    .innerJoin(accounts, eq(holdings.accountId, accounts.id))
    .where(and(...snapshotFilters(range, false)))
    .orderBy(asc(holdingSnapshots.date), asc(holdingSnapshots.holdingId));
}

export interface ValuePoint {
  readonly date: string;
  readonly value: string;
}

/** Total investment value per date — the portfolio value-over-time line. */
export async function portfolioValueSeries(range: SnapshotRange = {}): Promise<ValuePoint[]> {
  return db
    .select({
      date: holdingSnapshots.date,
      value: sql<string>`sum(${holdingSnapshots.value})`.as("value"),
    })
    .from(holdingSnapshots)
    .innerJoin(holdings, eq(holdingSnapshots.holdingId, holdings.id))
    .innerJoin(accounts, eq(holdings.accountId, accounts.id))
    .where(and(...snapshotFilters(range, true)))
    .groupBy(holdingSnapshots.date)
    .orderBy(asc(holdingSnapshots.date));
}

export interface DimensionValuePoint extends ValuePoint {
  /** The slice key (asset class, account id, …). */
  readonly key: string;
  /** Human label for the key (account name); equals `key` for asset class. */
  readonly label: string;
}

/** Investment value per date, broken down by holding asset class. */
export async function valueSeriesByAssetClass(
  range: SnapshotRange = {},
): Promise<DimensionValuePoint[]> {
  const rows = await db
    .select({
      date: holdingSnapshots.date,
      key: holdings.assetClass,
      value: sql<string>`sum(${holdingSnapshots.value})`.as("value"),
    })
    .from(holdingSnapshots)
    .innerJoin(holdings, eq(holdingSnapshots.holdingId, holdings.id))
    .innerJoin(accounts, eq(holdings.accountId, accounts.id))
    .where(and(...snapshotFilters(range, true)))
    .groupBy(holdingSnapshots.date, holdings.assetClass)
    .orderBy(asc(holdingSnapshots.date));
  return rows.map((r) => ({ date: r.date, key: r.key, label: r.key, value: r.value }));
}

/** Investment value per date, broken down by account. */
export async function valueSeriesByAccount(
  range: SnapshotRange = {},
): Promise<DimensionValuePoint[]> {
  const rows = await db
    .select({
      date: holdingSnapshots.date,
      key: holdings.accountId,
      label: accounts.name,
      value: sql<string>`sum(${holdingSnapshots.value})`.as("value"),
    })
    .from(holdingSnapshots)
    .innerJoin(holdings, eq(holdingSnapshots.holdingId, holdings.id))
    .innerJoin(accounts, eq(holdings.accountId, accounts.id))
    .where(and(...snapshotFilters(range, true)))
    .groupBy(holdingSnapshots.date, holdings.accountId, accounts.name)
    .orderBy(asc(holdingSnapshots.date));
  return rows.map((r) => ({ date: r.date, key: r.key, label: r.label, value: r.value }));
}

// ── Performance inputs — flows + benchmark (PLAN9 P9-10 / P9-12) ─────────────
//
// These feed the pure performance math in performance.ts: the raw external-flow
// transactions (classified there by `externalFlow`) and the benchmark close
// series. Both stay strings; the math layer does all the Decimal work.

export interface InvestmentFlowRow {
  readonly type: string;
  readonly subtype: string | null;
  readonly amount: string;
  readonly date: string;
}

/**
 * Buy/sell/cash/transfer transactions across investment accounts within the
 * range — the raw input to `externalFlow`/`netExternalFlows` (TWR/XIRR/
 * attribution). Dividends/interest/fees are *included* here and filtered out by
 * the classifier (single source of truth for what counts as external).
 */
export async function listInvestmentFlows(range: SnapshotRange = {}): Promise<InvestmentFlowRow[]> {
  const conds: SQL[] = [inArray(accounts.type, [...INVESTMENT_TYPES])];
  if (range.from) conds.push(gte(investmentTransactions.tradeDate, range.from));
  if (range.to) conds.push(lte(investmentTransactions.tradeDate, range.to));
  if (range.accountIds && range.accountIds.length > 0) {
    conds.push(inArray(investmentTransactions.accountId, [...range.accountIds]));
  }
  const rows = await db
    .select({
      type: investmentTransactions.type,
      subtype: investmentTransactions.subtype,
      amount: investmentTransactions.amount,
      date: investmentTransactions.tradeDate,
    })
    .from(investmentTransactions)
    .innerJoin(accounts, eq(investmentTransactions.accountId, accounts.id))
    .where(and(...conds))
    .orderBy(asc(investmentTransactions.tradeDate));
  return rows;
}

/** Benchmark (^GSPC) daily closes within the range, as a value series. */
export async function benchmarkCloseSeries(
  symbol: string,
  range: Pick<SnapshotRange, "from" | "to"> = {},
): Promise<ValuePoint[]> {
  const conds: SQL[] = [eq(prices.symbol, symbol)];
  if (range.from) conds.push(gte(prices.date, range.from));
  if (range.to) conds.push(lte(prices.date, range.to));
  return db
    .select({ date: prices.date, value: prices.close })
    .from(prices)
    .where(and(...conds))
    .orderBy(asc(prices.date));
}

// ── Per-security drill-down (PLAN9 P9-17) ────────────────────────────────────
//
// Backs /investments/security/[id], keyed by HOLDING id (one position in one
// account). A `SEC:`-synthetic or manual holding simply has null security meta;
// every query degrades gracefully rather than 404-ing.

export interface SecurityDetail {
  readonly holding: Holding;
  readonly accountId: string;
  readonly accountName: string;
  readonly accountType: string;
  readonly accountCurrency: string;
  /** Security metadata; null for hand-typed symbols with no `security_id`. */
  readonly security: {
    readonly id: string;
    readonly name: string;
    readonly sector: string | null;
    readonly industry: string | null;
    readonly region: string | null;
    readonly assetType: string | null;
    readonly expenseRatio: string | null;
    readonly dividendRate: string | null;
    readonly dividendExDate: string | null;
  } | null;
  readonly lots: InvestmentLotRow[];
}

/** Full detail for one holding: account, security metadata, and cost-basis lots. */
export async function securityDetail(holdingId: string): Promise<SecurityDetail | null> {
  const [row] = await db
    .select({
      holding: holdings,
      accountName: accounts.name,
      accountType: accounts.type,
      accountCurrency: accounts.currency,
      secId: securities.id,
      secName: securities.name,
      sector: securities.sector,
      industry: securities.industry,
      region: securities.region,
      assetType: securities.assetType,
      expenseRatio: securities.expenseRatio,
      dividendRate: securities.dividendRate,
      dividendExDate: securities.dividendExDate,
    })
    .from(holdings)
    .innerJoin(accounts, eq(holdings.accountId, accounts.id))
    .leftJoin(securities, eq(holdings.securityId, securities.id))
    .where(and(eq(holdings.id, holdingId), inArray(accounts.type, [...INVESTMENT_TYPES])))
    .limit(1);
  if (!row) return null;

  const lots = await db
    .select({
      holdingId: holdingLots.holdingId,
      quantity: holdingLots.quantity,
      costBasisTotal: holdingLots.costBasisTotal,
      source: holdingLots.source,
    })
    .from(holdingLots)
    .where(eq(holdingLots.holdingId, holdingId));

  return {
    holding: row.holding,
    accountId: row.holding.accountId,
    accountName: row.accountName,
    accountType: row.accountType,
    accountCurrency: row.accountCurrency,
    security: row.secId
      ? {
          id: row.secId,
          name: row.secName ?? row.holding.symbol,
          sector: row.sector,
          industry: row.industry,
          region: row.region,
          assetType: row.assetType,
          expenseRatio: row.expenseRatio,
          dividendRate: row.dividendRate,
          dividendExDate: row.dividendExDate,
        }
      : null,
    lots,
  };
}

/** Daily closes for a symbol within the range — the per-security price sparkline. */
export async function securityPriceHistory(
  symbol: string,
  range: Pick<SnapshotRange, "from" | "to"> = {},
): Promise<ValuePoint[]> {
  return benchmarkCloseSeries(symbol, range);
}

/** Value & cost-basis history for a single holding (its own snapshots). */
export async function holdingSnapshotSeries(
  holdingId: string,
  range: Pick<SnapshotRange, "from" | "to"> = {},
): Promise<HoldingSnapshotRow[]> {
  return listHoldingSnapshots({ ...range, holdingIds: [holdingId] });
}

/**
 * Dividend/interest income recorded for one holding's security in its account.
 * Returns `[]` when the holding has no linked security (manual symbol).
 */
export async function securityIncome(holdingId: string): Promise<IncomeTxnRow[]> {
  const [h] = await db
    .select({ accountId: holdings.accountId, securityId: holdings.securityId })
    .from(holdings)
    .where(eq(holdings.id, holdingId))
    .limit(1);
  if (!h || !h.securityId) return [];
  return db
    .select({
      subtype: investmentTransactions.subtype,
      tradeDate: investmentTransactions.tradeDate,
      amount: investmentTransactions.amount,
      isoCurrencyCode: investmentTransactions.isoCurrencyCode,
    })
    .from(investmentTransactions)
    .where(
      and(
        eq(investmentTransactions.accountId, h.accountId),
        eq(investmentTransactions.securityId, h.securityId),
        or(
          eq(investmentTransactions.subtype, "dividend"),
          eq(investmentTransactions.subtype, "interest"),
        ),
      ),
    )
    .orderBy(asc(investmentTransactions.tradeDate));
}
