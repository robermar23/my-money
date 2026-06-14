import "server-only";

import { db } from "@/db/client.ts";
import {
  type Holding,
  accountSnapshots,
  accounts,
  holdingLots,
  holdings,
  investmentTransactions,
  securities,
} from "@/db/schema/index.ts";
import { and, asc, desc, eq, inArray, or } from "drizzle-orm";

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
  }));
}

export interface InvestmentLotRow {
  readonly holdingId: string;
  readonly quantity: string;
  readonly costBasisTotal: string;
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
