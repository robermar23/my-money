import { Money } from "@/lib/money/money.ts";
import Decimal from "decimal.js";
import type { DebtTerm, MissingDebtInput } from "./debt-terms.ts";

/**
 * The avalanche-vs-snowball payoff simulator (Phase 15, PLAN15 P15-18).
 *
 * Month by month, Decimal only. This is the sharpest math in the phase: the
 * simulation compounds, so a float here does not produce a slightly wrong answer,
 * it produces a *drifting* one that gets worse the longer the horizon — and a
 * 30-year loan is 360 compounding steps (CLAUDE.md §Money).
 *
 * ── The two strategies ─────────────────────────────────────────────────────
 *   **Avalanche** — highest APR first. Mathematically optimal; always pays the
 *       least total interest.
 *   **Snowball** — smallest balance first. Pays more interest, but clears whole
 *       debts sooner, which is the behavioural argument for it.
 *
 * Both are simulated and both are reported, with the delta between them. The
 * engine does not pick for the user: ADR-032 §4 is about recommending structures,
 * and "you would pay $1,840 more interest but close your first card 9 months
 * earlier" is a structure the user can decide on. Presenting only the optimal one
 * would be arithmetically right and unhelpful.
 *
 * ── The payment model ──────────────────────────────────────────────────────
 * The monthly outlay is **constant**: the sum of every minimum plus any extra.
 * When a debt is cleared its minimum does not disappear — it rolls into the
 * surplus attacking the next debt. That rolling is the entire mechanism both
 * strategies share, and the reason the last debt is repaid so much faster than
 * the first.
 *
 * Each month: accrue interest on every open balance, pay every minimum, then
 * throw the whole remaining surplus at the priority debt (cascading onward if
 * that clears it mid-month).
 *
 * ── TERMINATION IS A GUARANTEE, NOT AN OBSERVATION ─────────────────────────
 * A debt whose minimum does not cover its monthly interest grows forever. The
 * loop therefore has **two** independent stops, neither of which is an emergent
 * property of the inputs:
 *
 *   1. A **hard ceiling** of {@link MAX_SIMULATION_MONTHS} iterations. Nothing
 *      about the data can make this loop run longer, including data that has not
 *      been imagined yet.
 *   2. A **no-progress detector**: if the household's total balance did not
 *      strictly fall over a whole month, it never will — the rates, the minimums
 *      and the outlay are all constant — so the simulation stops immediately and
 *      reports `blocked` with the debts that are underwater.
 *
 * `blocked` is a real answer, not an error: "at these minimums this card never
 * gets paid off" is exactly what a household in that position needs told.
 *
 * Pure and I/O-free (ADR-032 §1).
 */

const CURRENCY = "USD";

/**
 * Hard iteration ceiling — 50 years of months.
 *
 * Well past any real consumer debt (a 30-year mortgage is 360), and small enough
 * that the worst case is still microseconds. This is the guard that makes
 * non-termination structurally impossible rather than merely unlikely.
 */
export const MAX_SIMULATION_MONTHS = 600;

export type PayoffStrategy = "avalanche" | "snowball";

/** A debt as the simulator needs it: a balance, a rate, and a minimum. */
export interface PayoffDebtInput {
  readonly accountId: string;
  readonly accountName: string;
  /** Positive amount owed. */
  readonly balance: string;
  /** Decimal FRACTION ("0.249900" = 24.99%). */
  readonly apr: string;
  readonly minimumPayment: string;
}

/** A debt the simulator could not include, and why. */
export interface ExcludedDebt {
  readonly accountId: string;
  readonly accountName: string;
  readonly missing: readonly MissingDebtInput[];
}

/** Per-debt outcome under one strategy. */
export interface PayoffDebtResult {
  readonly accountId: string;
  readonly accountName: string;
  /** Month index (1-based) the balance reached zero. `null` when never cleared. */
  readonly monthsToPayoff: number | null;
  readonly interestPaid: string;
  /** `"0.00"` once cleared; the underwater balance when `blocked`. */
  readonly remainingBalance: string;
  /** True when this debt is why the simulation stopped short. */
  readonly blocked: boolean;
}

export interface PayoffResult {
  readonly strategy: PayoffStrategy;
  /**
   *   - `complete` — every included debt reaches zero.
   *   - `blocked` — the outlay does not retire the debt (see the file header).
   *   - `unknown_input` — nothing could be simulated because no debt had a
   *     complete set of terms.
   *   - `no_debts` — the household has none. Worth saying out loud.
   */
  readonly status: "complete" | "blocked" | "unknown_input" | "no_debts";
  /** Included account ids in payoff-priority order. */
  readonly order: readonly string[];
  /** Months until every included debt is cleared. `null` when not `complete`. */
  readonly monthsToDebtFree: number | null;
  readonly totalInterest: string;
  readonly totalPaid: string;
  /** The constant monthly outlay: every minimum plus the extra. */
  readonly monthlyOutlay: string;
  readonly debts: readonly PayoffDebtResult[];
  /** Debts left out for missing terms — always reported, never silently dropped. */
  readonly excluded: readonly ExcludedDebt[];
  /** One sentence, present whenever the status is not `complete`. */
  readonly reason: string | null;
}

export interface PayoffOptions {
  /** Extra dollars per month above the minimums. Default `"0.00"`. */
  readonly extraMonthly?: string;
  /** Iteration ceiling override, for tests. Clamped to {@link MAX_SIMULATION_MONTHS}. */
  readonly maxMonths?: number;
}

/** Mutable per-debt state inside the loop. */
interface DebtState {
  readonly accountId: string;
  readonly accountName: string;
  readonly monthlyRate: Decimal;
  readonly minimum: Money;
  balance: Money;
  interest: Money;
  clearedInMonth: number | null;
}

/** The lesser of two same-currency Money values. */
function min(a: Money, b: Money): Money {
  return a.sub(b).isNegative() ? a : b;
}

/** True when `a > b`. */
function greater(a: Money, b: Money): boolean {
  const diff = a.sub(b);
  return !diff.isNegative() && !diff.isZero();
}

/**
 * Split a unified {@link DebtTerm} list into what can be simulated and what
 * cannot.
 *
 * A debt with no APR is **not** treated as 0% — that would make the simulator
 * confidently recommend paying it last, which is the exact failure mode
 * [debt-terms.ts](./debt-terms.ts) exists to prevent. It is excluded and
 * reported.
 *
 * Zero-balance debts are dropped from both lists: a paid-off card is not part of
 * a payoff plan and its stale minimum would inflate the monthly outlay.
 *
 * @param terms - Unified debt terms from the snapshot.
 * @returns Simulatable debts and the excluded ones with their missing inputs.
 */
export function partitionDebts(terms: readonly DebtTerm[]): {
  readonly simulatable: readonly PayoffDebtInput[];
  readonly excluded: readonly ExcludedDebt[];
} {
  const simulatable: PayoffDebtInput[] = [];
  const excluded: ExcludedDebt[] = [];

  for (const term of terms) {
    if (Money.fromString(term.balance, CURRENCY).isZero()) continue;

    if (term.apr === null || term.minimumPayment === null) {
      excluded.push({
        accountId: term.accountId,
        accountName: term.accountName,
        missing: term.missing.filter((m) => m !== "credit_limit"),
      });
      continue;
    }

    simulatable.push({
      accountId: term.accountId,
      accountName: term.accountName,
      balance: term.balance,
      apr: term.apr,
      minimumPayment: term.minimumPayment,
    });
  }

  return { simulatable, excluded };
}

/**
 * Order debts by strategy.
 *
 * Ties are broken all the way down to the account name so the order is fully
 * deterministic. Two cards at 19.99% with identical balances must not swap places
 * between page loads — an advice list that reshuffles reads as broken even when
 * every figure in it is right.
 *
 * @param debts - Simulatable debts.
 * @param strategy - `avalanche` (highest APR first) or `snowball` (smallest
 *   balance first).
 * @returns A new array in payoff-priority order.
 */
export function orderDebts(
  debts: readonly PayoffDebtInput[],
  strategy: PayoffStrategy,
): PayoffDebtInput[] {
  const byName = (a: PayoffDebtInput, b: PayoffDebtInput): number =>
    a.accountName < b.accountName ? -1 : a.accountName > b.accountName ? 1 : 0;

  return [...debts].sort((a, b) => {
    const aprA = new Decimal(a.apr);
    const aprB = new Decimal(b.apr);
    const balA = new Decimal(a.balance);
    const balB = new Decimal(b.balance);

    if (strategy === "avalanche") {
      if (!aprA.equals(aprB)) return aprB.comparedTo(aprA);
      if (!balA.equals(balB)) return balA.comparedTo(balB);
      return byName(a, b);
    }

    if (!balA.equals(balB)) return balA.comparedTo(balB);
    if (!aprA.equals(aprB)) return aprB.comparedTo(aprA);
    return byName(a, b);
  });
}

/**
 * Simulate one payoff strategy to completion (P15-18).
 *
 * @param debts - Simulatable debts (use {@link partitionDebts} first).
 * @param strategy - Which ordering to follow.
 * @param options - Extra monthly payment and an optional iteration ceiling.
 * @param excluded - Debts left out, carried through onto the result so the
 *   caller never has to remember to re-attach them.
 * @returns Months to debt-free, total interest, and per-debt outcomes — or a
 *   `blocked` result naming the debts the outlay never retires.
 */
export function simulatePayoff(
  debts: readonly PayoffDebtInput[],
  strategy: PayoffStrategy,
  options: PayoffOptions = {},
  excluded: readonly ExcludedDebt[] = [],
): PayoffResult {
  const extra = Money.fromString(options.extraMonthly ?? "0", CURRENCY);
  const ceiling = Math.min(
    MAX_SIMULATION_MONTHS,
    Math.max(1, Math.floor(options.maxMonths ?? MAX_SIMULATION_MONTHS)),
  );

  const ordered = orderDebts(debts, strategy);
  const order = ordered.map((d) => d.accountId);

  if (ordered.length === 0) {
    return {
      strategy,
      status: excluded.length > 0 ? "unknown_input" : "no_debts",
      order,
      monthsToDebtFree: excluded.length > 0 ? null : 0,
      totalInterest: "0.00",
      totalPaid: "0.00",
      monthlyOutlay: extra.toString(),
      debts: [],
      excluded,
      reason:
        excluded.length > 0
          ? "No debt has both an APR and a minimum payment recorded, so no payoff plan can be simulated."
          : null,
    };
  }

  const state: DebtState[] = ordered.map((d) => ({
    accountId: d.accountId,
    accountName: d.accountName,
    // APR is an annual decimal fraction; the monthly rate is a twelfth of it.
    // Simple monthly periodic rate, matching how card issuers actually bill.
    monthlyRate: new Decimal(d.apr).dividedBy(12),
    minimum: Money.fromString(d.minimumPayment, CURRENCY),
    balance: Money.fromString(d.balance, CURRENCY),
    interest: Money.zero(CURRENCY),
    clearedInMonth: null,
  }));

  // The outlay never shrinks: a cleared debt's minimum rolls into the surplus.
  const outlay = Money.sum(
    state.map((s) => s.minimum),
    CURRENCY,
  ).add(extra);

  let totalInterest = Money.zero(CURRENCY);
  let totalPaid = Money.zero(CURRENCY);
  let months = 0;
  let stopped: "cleared" | "no_progress" | "ceiling" = "ceiling";

  const totalBalance = (): Money =>
    Money.sum(
      state.map((s) => s.balance),
      CURRENCY,
    );

  while (months < ceiling) {
    const before = totalBalance();
    if (before.isZero()) {
      stopped = "cleared";
      break;
    }
    months += 1;

    // 1. Accrue interest on every open balance.
    for (const debt of state) {
      if (debt.balance.isZero()) continue;
      const interest = Money.fromString(
        debt.balance.mul(debt.monthlyRate.toString()).toString(),
        CURRENCY,
      );
      debt.balance = debt.balance.add(interest);
      debt.interest = debt.interest.add(interest);
      totalInterest = totalInterest.add(interest);
    }

    // 2. Pay every minimum (never more than the balance owed).
    let budget = outlay;
    for (const debt of state) {
      if (debt.balance.isZero()) continue;
      const payment = min(min(debt.minimum, debt.balance), budget);
      if (payment.isZero()) continue;
      debt.balance = debt.balance.sub(payment);
      budget = budget.sub(payment);
      totalPaid = totalPaid.add(payment);
      if (debt.balance.isZero() && debt.clearedInMonth === null) debt.clearedInMonth = months;
    }

    // 3. Throw the whole surplus at the priority debt, cascading onward when it
    //    clears mid-month. `state` is already in strategy order.
    for (const debt of state) {
      if (budget.isZero()) break;
      if (debt.balance.isZero()) continue;
      const payment = min(budget, debt.balance);
      debt.balance = debt.balance.sub(payment);
      budget = budget.sub(payment);
      totalPaid = totalPaid.add(payment);
      if (debt.balance.isZero() && debt.clearedInMonth === null) debt.clearedInMonth = months;
    }

    const after = totalBalance();
    if (after.isZero()) {
      stopped = "cleared";
      break;
    }
    // No-progress detector — see the file header. Rates, minimums and outlay are
    // all constant, so a month that did not reduce the total never will.
    if (!greater(before, after)) {
      stopped = "no_progress";
      break;
    }
  }

  const complete = stopped === "cleared";
  const blockedDebts = state.filter((s) => !s.balance.isZero());

  return {
    strategy,
    status: complete ? "complete" : "blocked",
    order,
    monthsToDebtFree: complete ? months : null,
    totalInterest: totalInterest.toString(),
    totalPaid: totalPaid.toString(),
    monthlyOutlay: outlay.toString(),
    debts: state.map((s) => ({
      accountId: s.accountId,
      accountName: s.accountName,
      monthsToPayoff: s.clearedInMonth,
      interestPaid: s.interest.toString(),
      remainingBalance: s.balance.toString(),
      blocked: !s.balance.isZero(),
    })),
    excluded,
    reason: complete
      ? null
      : stopped === "no_progress"
        ? `At the current minimums the balance stops falling, so ${blockedDebts
            .map((d) => d.accountName)
            .join(", ")} is never repaid. Interest is outrunning the payment.`
        : `Still not repaid after ${ceiling} months of simulation.`,
  };
}

/** Both strategies, plus what choosing the optimal one is worth. */
export interface PayoffComparison {
  readonly avalanche: PayoffResult;
  readonly snowball: PayoffResult;
  /**
   * Interest the avalanche saves over the snowball. `null` when either side did
   * not complete — a difference against a plan that never finishes is not a
   * number worth showing.
   */
  readonly interestSaved: string | null;
  /** Months the avalanche saves. Frequently `0`; occasionally negative is impossible. */
  readonly monthsSaved: number | null;
}

/**
 * Run both strategies over the same debts and budget (P15-18).
 *
 * @param debts - Simulatable debts.
 * @param options - Extra monthly payment and optional ceiling.
 * @param excluded - Debts left out for missing terms.
 * @returns Both results plus the interest/months delta.
 */
export function comparePayoffStrategies(
  debts: readonly PayoffDebtInput[],
  options: PayoffOptions = {},
  excluded: readonly ExcludedDebt[] = [],
): PayoffComparison {
  const avalanche = simulatePayoff(debts, "avalanche", options, excluded);
  const snowball = simulatePayoff(debts, "snowball", options, excluded);

  const bothComplete = avalanche.status === "complete" && snowball.status === "complete";

  return {
    avalanche,
    snowball,
    interestSaved: bothComplete
      ? Money.fromString(snowball.totalInterest, CURRENCY)
          .sub(Money.fromString(avalanche.totalInterest, CURRENCY))
          .toString()
      : null,
    monthsSaved:
      bothComplete && snowball.monthsToDebtFree !== null && avalanche.monthsToDebtFree !== null
        ? snowball.monthsToDebtFree - avalanche.monthsToDebtFree
        : null,
  };
}
