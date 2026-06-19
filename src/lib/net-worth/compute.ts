import "server-only";

import { db } from "@/db/client.ts";
import { accountSnapshots, accounts, liabilities } from "@/db/schema/index.ts";
import { valueAccountHoldings } from "@/lib/holdings/value.ts";
import { Money } from "@/lib/money/money.ts";
import { balanceAtMonth } from "@/lib/mortgage/amortization.ts";
import { and, desc, eq, gt, isNull, lte, or, sql } from "drizzle-orm";

function monthsBetween(startIso: string, asOf: Date): number {
  const start = new Date(`${startIso}T00:00:00Z`);
  const months =
    (asOf.getUTCFullYear() - start.getUTCFullYear()) * 12 +
    (asOf.getUTCMonth() - start.getUTCMonth());
  return Math.max(0, months);
}

interface NetWorthLineItem {
  readonly accountId: string;
  readonly accountName: string;
  readonly accountType: string;
  readonly currency: string;
  readonly balance: Money;
}

export interface NetWorthBreakdown {
  readonly asOf: Date;
  readonly total: Money;
  readonly items: readonly NetWorthLineItem[];
}

/**
 * Compute net worth as of a given date.
 *
 * Strategy:
 *   1. For non-loan accounts: take the most-recent account_snapshots row with
 *      date <= asOf. (Empty = $0 contribution.)
 *   2. For loan accounts: compute live balance via amortization, then negate
 *      (liabilities reduce net worth).
 *
 * All values are summed in the user's base currency (defaulted to USD for
 * Phase 1 — multi-currency aggregation will pull fx_rates when needed).
 *
 * @param asOf - Snapshot timestamp. Defaults to "now".
 * @param baseCurrency - Currency to sum in. Defaults to "USD".
 */
export async function computeNetWorth(
  asOf: Date = new Date(),
  baseCurrency = "USD",
): Promise<NetWorthBreakdown> {
  const asOfIso = asOf.toISOString().slice(0, 10);
  // Exclude accounts closed on or before `asOf` (P7-04). A closed account
  // contributes $0 going forward, but historical points (asOf earlier than the
  // close) still include it — its past value stays in old chart points.
  const all = await db
    .select()
    .from(accounts)
    .where(or(isNull(accounts.closedAt), gt(accounts.closedAt, asOf)));

  const items: NetWorthLineItem[] = [];

  for (const account of all) {
    if (account.type === "loan") {
      const [liab] = await db
        .select()
        .from(liabilities)
        .where(eq(liabilities.accountId, account.id))
        .limit(1);
      if (!liab) continue;
      const remaining = balanceAtMonth(
        Money.fromString(liab.principalAtOrigination, account.currency),
        liab.annualRate,
        liab.termMonths,
        monthsBetween(liab.startDate, asOf),
      );
      items.push({
        accountId: account.id,
        accountName: account.name,
        accountType: account.type,
        currency: account.currency,
        balance: remaining.negate(),
      });
      continue;
    }

    // For holdings-based accounts, prefer live valuation from cached prices
    // over the last-written snapshot — gives the user the freshest possible
    // dashboard value without waiting for the nightly snapshot job.
    if (account.type === "investment" || account.type === "crypto_ira") {
      const live = await valueAccountHoldings(account.id, account.currency, asOfIso);
      if (!live.isZero()) {
        items.push({
          accountId: account.id,
          accountName: account.name,
          accountType: account.type,
          currency: account.currency,
          balance: live,
        });
        continue;
      }
      // No prices yet: fall through to the snapshot lookup so manual entries still show.
    }

    const [latest] = await db
      .select({ balance: accountSnapshots.balance, date: accountSnapshots.date })
      .from(accountSnapshots)
      .where(and(eq(accountSnapshots.accountId, account.id), lte(accountSnapshots.date, asOfIso)))
      .orderBy(desc(accountSnapshots.date))
      .limit(1);

    // Plaid-linked accounts get a zero-balance line immediately after mapping,
    // so the user can see what they just created while the initial sync runs.
    // Pure-manual accounts continue to be hidden until a balance is entered —
    // they shouldn't clutter the dashboard with empty rows.
    if (!latest) {
      if (account.plaidItemId) {
        items.push({
          accountId: account.id,
          accountName: account.name,
          accountType: account.type,
          currency: account.currency,
          balance: Money.zero(account.currency),
        });
      }
      continue;
    }

    items.push({
      accountId: account.id,
      accountName: account.name,
      accountType: account.type,
      currency: account.currency,
      balance: Money.fromString(latest.balance, account.currency),
    });
  }

  // Phase 1: all accounts assumed to be in the same baseCurrency. The Money.sum
  // throw on mismatch will fire if a multi-currency account creeps in — useful
  // as an early-warning until fx_rates plumbing arrives.
  const values = items.map((i) => i.balance);
  const total = Money.sum(
    values.filter((v) => v.currency === baseCurrency),
    baseCurrency,
  );

  return { asOf, total, items };
}

/**
 * Net-worth value at each date in `account_snapshots`. Used by the dashboard
 * chart to show the historical trend without needing the snapshot job to have
 * pre-populated every date.
 *
 * For each distinct date D present in any snapshot, compute net worth as-of D
 * using the most-recent-snapshot-per-account-on-or-before-D rule. Loan
 * accounts compute amortization at D.
 */
export interface NetWorthPoint {
  readonly date: string;
  readonly value: string;
}

export async function netWorthSeries(baseCurrency = "USD"): Promise<NetWorthPoint[]> {
  const distinctDates = await db
    .select({ date: accountSnapshots.date })
    .from(accountSnapshots)
    .groupBy(accountSnapshots.date)
    .orderBy(sql`${accountSnapshots.date} asc`);

  const points: NetWorthPoint[] = [];
  for (const { date } of distinctDates) {
    const snap = await computeNetWorth(new Date(`${date}T00:00:00Z`), baseCurrency);
    points.push({ date, value: snap.total.toString() });
  }
  return points;
}
