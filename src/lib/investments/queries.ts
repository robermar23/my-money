import "server-only";

import { db } from "@/db/client.ts";
import {
  type Holding,
  accounts,
  holdingLots,
  holdings,
  investmentTransactions,
  securities,
} from "@/db/schema/index.ts";
import { and, asc, eq, inArray, or } from "drizzle-orm";

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
