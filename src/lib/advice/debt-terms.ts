import "server-only";

import { db } from "@/db/client.ts";
import { accountSnapshots, accounts, creditLines, liabilities } from "@/db/schema/index.ts";
import { Money } from "@/lib/money/money.ts";
import { balanceAtMonth, monthlyPayment } from "@/lib/mortgage/amortization.ts";
import { and, desc, inArray, isNull } from "drizzle-orm";

/**
 * Unified debt terms — one shape for an amortizing loan and a revolving card
 * (Phase 15, PLAN15 P15-11, ADR-033 §3).
 *
 * The app models debt in two tables that share nothing: `liabilities` (a
 * fixed-rate amortizing loan — principal, rate, term, start date, all NOT NULL)
 * and `credit_lines` (revolving terms — APR, limit, minimum, all nullable).
 * ADR-033 kept them apart on purpose: reusing `liabilities` for a card would
 * force `DROP NOT NULL` on a table that drives shipped mortgage math.
 *
 * The cost of that decision is paid here, once: the payoff simulator (P15-18),
 * the high-interest rule (P15-17) and the utilization rule (P15-19) all want a
 * single list, so this module unions the two into `DebtTerm[]` and nothing
 * downstream ever learns there were two tables.
 *
 * ── Balances come from `account_snapshots` ─────────────────────────────────
 * Not from `liabilities`, which stores only origination parameters, and not from
 * `credit_lines`, which deliberately stores no balance at all. The latest
 * snapshot row per account is the same path net worth uses — debt does not get
 * its own balance story.
 *
 * Snapshots store debt as a **negative** balance (`snapshots.ts`: a loan is
 * `-1 × remaining principal`, and a card is likewise negative). This module
 * flips the sign so every `DebtTerm.balance` is a positive "amount owed", and
 * clamps a positive snapshot (an overpaid card sitting in credit) to zero —
 * you cannot owe a negative amount.
 *
 * ── Honesty about missing terms ────────────────────────────────────────────
 * Terms are manual-first (ADR-033 §6) and the columns ship empty, so "no APR
 * recorded" is the NORMAL state on day one, not an error. Every `DebtTerm`
 * therefore carries `status` and `missing[]`. A debt with no terms is emitted
 * with `status: 'unknown_input'` and its balance intact — **never silently
 * dropped, and never defaulted to a 0% APR**, which would make the payoff
 * simulator confidently recommend paying it last.
 *
 * A `credit_card` or `loan` account with no terms row *at all* is still emitted:
 * the snapshot proves the debt exists, and hiding it would understate the
 * household's obligations. That is the sharpest case P15-11 has to get right.
 *
 * ── UNITS (CLAUDE.md §Money) ───────────────────────────────────────────────
 * `apr` is a decimal FRACTION on both branches ("0.249900" = 24.99%), matching
 * `liabilities.annual_rate` and `credit_lines.apr`. The percentage-valued
 * `credit_lines.minimum_payment_percent` is converted here so nothing
 * downstream has to remember which convention applies to which column.
 */

const CURRENCY = "USD";

/** Amortizing (a loan with a term) vs. revolving (a card with a limit). */
export type DebtKind = "amortizing" | "revolving";

/** An input a rule may need but the household has not recorded. */
export type MissingDebtInput = "balance" | "apr" | "minimum_payment" | "credit_limit";

export interface DebtTerm {
  readonly accountId: string;
  readonly accountName: string;
  readonly institution: string;
  readonly kind: DebtKind;
  /** Positive "amount owed", clamped at zero. `"0.00"` when no snapshot exists. */
  readonly balance: string;
  /** Decimal FRACTION ("0.249900" = 24.99%). `null` when not recorded. */
  readonly apr: string | null;
  /**
   * Monthly minimum. Amortizing: the scheduled P+I payment, derived from the
   * origination parameters. Revolving: the greater of the flat minimum and the
   * percent-of-balance minimum, since issuers commonly bill exactly that.
   * `null` when neither is recorded.
   */
  readonly minimumPayment: string | null;
  /** Revolving only — drives the utilization rule (P15-19). `null` otherwise. */
  readonly creditLimit: string | null;
  /** Date of the balance snapshot; `null` when the account has none. */
  readonly balanceAsOf: string | null;
  /**
   * When the terms row was last touched. Shown next to the APR (P15-30) so a
   * hand-entered figure that has gone stale reads as stale rather than current
   * (ADR-033 consequence 2). `null` when there is no terms row.
   */
  readonly termsUpdatedAt: Date | null;
  /**
   * `'unknown_input'` when a **payoff-critical** input is missing (balance, APR
   * or minimum payment). `credit_limit` alone does not flip this: it is needed
   * by the utilization rule, not by the payoff simulator, and a card can be
   * simulated to zero without knowing its limit.
   */
  readonly status: "complete" | "unknown_input";
  /** Every absent input, including the non-critical `credit_limit`. */
  readonly missing: readonly MissingDebtInput[];
}

/** An account row as {@link unifyDebtTermsFrom} needs it. */
export interface DebtAccountRow {
  readonly id: string;
  readonly name: string;
  readonly institution: string;
  /** Only `'loan'` and `'credit_card'` are debts; the caller filters. */
  readonly type: string;
}

/** A `liabilities` row (all columns NOT NULL in the schema). */
export interface LiabilityRow {
  readonly accountId: string;
  readonly principalAtOrigination: string;
  /** Decimal fraction. */
  readonly annualRate: string;
  readonly termMonths: number;
  /** ISO `YYYY-MM-DD`. */
  readonly startDate: string;
  readonly updatedAt: Date;
}

/** A `credit_lines` row (every term nullable). */
export interface CreditLineRow {
  readonly accountId: string;
  readonly apr: string | null;
  readonly creditLimit: string | null;
  readonly minimumPayment: string | null;
  /** A PERCENTAGE ("2.0000" = 2%) — converted here. */
  readonly minimumPaymentPercent: string | null;
  readonly updatedAt: Date;
}

/** The latest `account_snapshots` row for an account. */
export interface LatestBalanceRow {
  readonly accountId: string;
  /** ISO `YYYY-MM-DD`. */
  readonly date: string;
  /** Signed: negative for debts. */
  readonly balance: string;
}

export interface DebtSources {
  readonly accounts: readonly DebtAccountRow[];
  readonly liabilities: readonly LiabilityRow[];
  readonly creditLines: readonly CreditLineRow[];
  readonly latestBalances: readonly LatestBalanceRow[];
}

/** Whole months elapsed between an ISO date and `today` (never negative). */
function monthsElapsed(startDate: string, today: string): number {
  const startYear = Number(startDate.slice(0, 4));
  const startMonth = Number(startDate.slice(5, 7));
  const startDay = Number(startDate.slice(8, 10));
  const nowYear = Number(today.slice(0, 4));
  const nowMonth = Number(today.slice(5, 7));
  const nowDay = Number(today.slice(8, 10));

  let months = (nowYear - startYear) * 12 + (nowMonth - startMonth);
  // The current month only counts once its anniversary day has passed.
  if (nowDay < startDay) months -= 1;
  return Math.max(0, months);
}

/** Snapshot balance → positive amount owed, clamped at zero. */
function owed(balance: string | undefined): Money | null {
  if (balance === undefined) return null;
  const signed = Money.fromString(balance, CURRENCY);
  const magnitude = signed.negate();
  return magnitude.isNegative() ? Money.zero(CURRENCY) : magnitude;
}

/**
 * The pure core: union amortizing and revolving debts into one `DebtTerm[]`.
 *
 * I/O-free so every branch — including the "no terms recorded" case that must
 * degrade to `unknown_input` rather than to a silent zero — is unit-testable
 * without a database (ADR-032 §1). {@link unifyDebtTerms} is the DB wrapper.
 *
 * @param sources - Accounts, both terms tables, and the latest balance per account.
 * @param today - Reference date, `YYYY-MM-DD`. Used only for the amortization
 *   fallback when a loan has no snapshot. Injected so tests are deterministic.
 * @returns One entry per debt account, ordered by descending balance (the
 *   largest obligation first, which is also the order every debt UI wants).
 */
export function unifyDebtTermsFrom(sources: DebtSources, today: string): DebtTerm[] {
  const liabilityByAccount = new Map(sources.liabilities.map((l) => [l.accountId, l]));
  const creditLineByAccount = new Map(sources.creditLines.map((c) => [c.accountId, c]));
  const balanceByAccount = new Map(sources.latestBalances.map((b) => [b.accountId, b]));

  const terms: DebtTerm[] = [];

  for (const account of sources.accounts) {
    if (account.type !== "loan" && account.type !== "credit_card") continue;

    const kind: DebtKind = account.type === "loan" ? "amortizing" : "revolving";
    const snapshot = balanceByAccount.get(account.id);
    const missing: MissingDebtInput[] = [];

    let balance = owed(snapshot?.balance);
    let apr: string | null = null;
    let minimumPayment: string | null = null;
    let creditLimit: string | null = null;
    let termsUpdatedAt: Date | null = null;

    if (kind === "amortizing") {
      const liability = liabilityByAccount.get(account.id);
      if (liability) {
        termsUpdatedAt = liability.updatedAt;
        apr = liability.annualRate;

        const principal = Money.fromString(liability.principalAtOrigination, CURRENCY);
        minimumPayment = monthlyPayment(
          principal,
          liability.annualRate,
          liability.termMonths,
        ).toString();

        // No snapshot yet? The origination parameters fully determine the
        // scheduled balance, so derive it rather than reporting `unknown_input`
        // for a loan whose terms we know exactly. Documented as a fallback: a
        // real snapshot always wins, because extra principal payments make the
        // schedule optimistic.
        if (balance === null) {
          balance = balanceAtMonth(
            principal,
            liability.annualRate,
            liability.termMonths,
            monthsElapsed(liability.startDate, today),
          );
        }
      }
    } else {
      const line = creditLineByAccount.get(account.id);
      if (line) {
        termsUpdatedAt = line.updatedAt;
        apr = line.apr;
        creditLimit = line.creditLimit;

        // Issuers commonly bill the GREATER of a flat floor and a percentage of
        // the balance, so take the max of whichever are recorded.
        const flat =
          line.minimumPayment === null ? null : Money.fromString(line.minimumPayment, CURRENCY);
        const fromPercent =
          line.minimumPaymentPercent === null || balance === null
            ? null
            : balance.mul(line.minimumPaymentPercent).div(100);

        if (flat !== null && fromPercent !== null) {
          minimumPayment = fromPercent.sub(flat).isNegative()
            ? flat.toString()
            : fromPercent.toString();
        } else if (flat !== null) {
          minimumPayment = flat.toString();
        } else if (fromPercent !== null) {
          minimumPayment = fromPercent.toString();
        }
      }
    }

    if (balance === null) missing.push("balance");
    if (apr === null) missing.push("apr");
    if (minimumPayment === null) missing.push("minimum_payment");
    if (kind === "revolving" && creditLimit === null) missing.push("credit_limit");

    // `credit_limit` is deliberately excluded from the payoff-critical set —
    // see the `status` doc on DebtTerm.
    const critical = missing.filter((m) => m !== "credit_limit");

    terms.push({
      accountId: account.id,
      accountName: account.name,
      institution: account.institution,
      kind,
      balance: (balance ?? Money.zero(CURRENCY)).toString(),
      apr,
      minimumPayment,
      creditLimit,
      balanceAsOf: snapshot?.date ?? null,
      termsUpdatedAt,
      status: critical.length === 0 ? "complete" : "unknown_input",
      missing,
    });
  }

  // Largest obligation first. Ties break on account name so the order is stable
  // across runs — an advice list that reshuffles between page loads reads as
  // broken even when every figure is right.
  return terms.sort((a, b) => {
    const diff = Money.fromString(b.balance, CURRENCY).sub(Money.fromString(a.balance, CURRENCY));
    if (!diff.isZero()) return diff.isNegative() ? -1 : 1;
    return a.accountName < b.accountName ? -1 : a.accountName > b.accountName ? 1 : 0;
  });
}

/**
 * The latest `account_snapshots` row for each of the given accounts.
 *
 * Exported because the snapshot loader (P15-12) needs exactly the same balances
 * for cash tiering and holdings totals; running it once and sharing the result
 * keeps `loadFinancialSnapshot` to a single pass over the table.
 *
 * @param accountIds - Accounts to fetch. An empty list short-circuits.
 * @returns One row per account that has at least one snapshot, newest first.
 */
export async function latestBalances(
  accountIds: readonly string[],
): Promise<readonly LatestBalanceRow[]> {
  if (accountIds.length === 0) return [];
  return db
    .selectDistinctOn([accountSnapshots.accountId], {
      accountId: accountSnapshots.accountId,
      date: accountSnapshots.date,
      balance: accountSnapshots.balance,
    })
    .from(accountSnapshots)
    .where(inArray(accountSnapshots.accountId, [...accountIds]))
    .orderBy(accountSnapshots.accountId, desc(accountSnapshots.date));
}

/**
 * Unified debt terms across every `loan` and `credit_card` account (P15-11).
 *
 * @param today - Reference date, `YYYY-MM-DD`. Defaults to the current UTC date.
 * @returns One {@link DebtTerm} per debt account, largest balance first.
 */
export async function unifyDebtTerms(
  today: string = new Date().toISOString().slice(0, 10),
): Promise<DebtTerm[]> {
  const debtAccounts = await db
    .select({
      id: accounts.id,
      name: accounts.name,
      institution: accounts.institution,
      type: accounts.type,
    })
    .from(accounts)
    // Closed accounts are excluded: a paid-off card is not a debt to order in a
    // payoff plan, and its stale minimum would inflate the essential baseline.
    .where(and(inArray(accounts.type, ["loan", "credit_card"]), isNull(accounts.closedAt)));

  if (debtAccounts.length === 0) return [];
  const ids = debtAccounts.map((a) => a.id);

  const [liabilityRows, creditLineRows, balanceRows] = await Promise.all([
    db
      .select({
        accountId: liabilities.accountId,
        principalAtOrigination: liabilities.principalAtOrigination,
        annualRate: liabilities.annualRate,
        termMonths: liabilities.termMonths,
        startDate: liabilities.startDate,
        updatedAt: liabilities.updatedAt,
      })
      .from(liabilities)
      .where(inArray(liabilities.accountId, ids)),
    db
      .select({
        accountId: creditLines.accountId,
        apr: creditLines.apr,
        creditLimit: creditLines.creditLimit,
        minimumPayment: creditLines.minimumPayment,
        minimumPaymentPercent: creditLines.minimumPaymentPercent,
        updatedAt: creditLines.updatedAt,
      })
      .from(creditLines)
      .where(inArray(creditLines.accountId, ids)),
    latestBalances(ids),
  ]);

  return unifyDebtTermsFrom(
    {
      accounts: debtAccounts,
      liabilities: liabilityRows,
      creditLines: creditLineRows,
      latestBalances: balanceRows,
    },
    today,
  );
}

/** Total monthly minimum debt service, plus what we could not price. */
export interface MinimumDebtService {
  /** Sum of every known minimum payment, as a money string. */
  readonly total: string;
  /**
   * How many debts carry a balance but no recorded minimum. A nonzero count
   * means `total` is LOW, and the essential baseline built on it is low too —
   * the UI says so rather than presenting the sum as complete.
   */
  readonly unknownCount: number;
}

/**
 * Sum the monthly minimums across a debt list (P15-09's second component).
 *
 * Debts with no recorded minimum contribute nothing to the total and are
 * counted separately. Zero-balance debts are skipped entirely: a paid-off card
 * bills no minimum, and counting its stale minimum would inflate the essential
 * baseline and therefore the reserve target.
 *
 * @param terms - Unified debt terms.
 * @returns The known total and the count of unpriced debts.
 */
export function totalMinimumDebtService(terms: readonly DebtTerm[]): MinimumDebtService {
  let total = Money.zero(CURRENCY);
  let unknownCount = 0;

  for (const term of terms) {
    if (Money.fromString(term.balance, CURRENCY).isZero()) continue;
    if (term.minimumPayment === null) {
      unknownCount += 1;
      continue;
    }
    total = total.add(Money.fromString(term.minimumPayment, CURRENCY));
  }

  return { total: total.toString(), unknownCount };
}
