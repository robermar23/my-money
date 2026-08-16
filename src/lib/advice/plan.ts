import "server-only";

import { isPositive, m } from "./amounts.ts";
import { listDismissals } from "./dismissals.ts";
import { type AdviceResult, runAdvice } from "./engine.ts";
import { type AdviceInput, type LoadSnapshotOptions, loadFinancialSnapshot } from "./snapshot.ts";

/**
 * `loadPlan` — the one composition the guidance surfaces call (Phase 15, P15-33).
 *
 * Snapshot → dismissals → engine → readiness, in one function. Both `/plan`
 * (P15-33) and the dashboard's advice card (P15-35) go through it, deliberately:
 * two independent compositions would eventually disagree about which
 * recommendation is the most urgent one, and a dashboard card that names a
 * different top priority than the page it links to reads as a bug even when both
 * halves are individually right. Same reasoning as ADR-029's "the loader is
 * smart, the cards are dumb", one level up.
 *
 * Zero egress, no logging of figures (CLAUDE.md §Privacy). The engine and every
 * rule under it remain pure; the only I/O is the two reads below.
 */

/**
 * One input the household has not supplied, with somewhere to go and fix it
 * (P15-37, ADR-029 §5).
 *
 * The rule is that an empty state must **name the missing input and link to it**.
 * "Insufficient data" on its own tells a user that the app is not working; "no
 * APR recorded for 2 cards" tells them what to do next, which is the difference
 * between a dead end and a to-do.
 */
export interface MissingInput {
  /** Stable key for React lists and tests. */
  readonly id: string;
  readonly label: string;
  /** What is missing and which figures it holds back. */
  readonly detail: string;
  readonly href: string;
  readonly linkLabel: string;
}

/**
 * How much the guidance can currently be trusted, and what would improve it.
 *
 * Computed from the snapshot alone — pure, so the whole degradation matrix is
 * unit-testable without a database.
 */
export interface PlanReadiness {
  /** Months between the earliest transaction and today. */
  readonly historyMonths: number;
  /** False on a book with no transactions at all — the genuine first-run state. */
  readonly hasHistory: boolean;
  /** Inputs that would sharpen the guidance, most consequential first. */
  readonly missing: readonly MissingInput[];
}

export interface PlanData {
  readonly advice: AdviceResult;
  readonly readiness: PlanReadiness;
  /** The window the baselines were computed over, for the page's dateline. */
  readonly window: { readonly from: string; readonly to: string };
  readonly currency: string;
}

/**
 * Everything the guidance surfaces render.
 *
 * @param options - Reference date and window depth, injected for tests.
 * @param now - Reference instant for snooze expiry only (see `runAdvice`).
 * @returns The engine's output plus the readiness report.
 */
export async function loadPlan(
  options: LoadSnapshotOptions = {},
  now: Date = new Date(),
): Promise<PlanData> {
  const input = await loadFinancialSnapshot(options);
  const dismissals = await listDismissals();
  const advice = runAdvice(input, dismissals, now);

  return {
    advice,
    readiness: planReadiness(input),
    window: input.window,
    currency: input.currency,
  };
}

/**
 * What the household could supply to improve the guidance (P15-37).
 *
 * Ordered by how much each unlocks: history first (it gates whole rules), then
 * the classification that sizes the reserve, then the terms that order debt
 * payoff, then the household details that refine the multipliers.
 *
 * @param input - The assembled snapshot.
 * @returns History depth plus the named, linked gaps.
 */
export function planReadiness(input: AdviceInput): PlanReadiness {
  const missing: MissingInput[] = [];

  // Classified spend sizes the reserve, the needs/wants split and the cash
  // tiers. It is listed first because it moves the most numbers.
  const unclassifiedPct = Math.round(input.essentials.unclassifiedShare * 100);
  if (unclassifiedPct > 0) {
    missing.push({
      id: "category-necessity",
      label: "Spending classification",
      detail: `${unclassifiedPct}% of your spending is in categories with no necessity set, so the essential-expense baseline behind your reserve target is low by an unknown amount.`,
      href: "/settings/categories",
      linkLabel: "Classify categories",
    });
  }

  // Cash with no subtype cannot be tiered, so it counts toward neither
  // operating money nor reserve — it is reported as unclassified rather than
  // guessed into a tier (see cash-tiers.ts).
  const untypedCash = input.accounts.filter(
    (account) => account.type === "depository" && account.subtype === null,
  );
  if (untypedCash.length > 0) {
    missing.push({
      id: "account-subtype",
      label: "Cash account types",
      detail: `${untypedCash.length} cash ${untypedCash.length === 1 ? "account has" : "accounts have"} no subtype, so their balances sit in the unclassified tier and count as neither spending money nor reserve.`,
      href: "/accounts",
      linkLabel: "Set account subtypes",
    });
  }

  // A debt with a balance but no APR cannot be ranked against the others, and
  // the payoff ordering declines to guess (ADR-033 §6).
  const unratedDebts = input.debts.filter(
    (debt) => debt.apr === null && isPositive(m(debt.balance)),
  );
  if (unratedDebts.length > 0) {
    missing.push({
      id: "debt-apr",
      label: "Interest rates",
      detail: `${unratedDebts.length} ${unratedDebts.length === 1 ? "debt has" : "debts have"} a balance but no APR recorded, so they cannot be placed in a payoff order.`,
      href: "/accounts",
      linkLabel: "Enter card and loan terms",
    });
  }

  // No income observed means no take-home to measure anything against.
  if (input.netIncome.trailingMedian === null) {
    missing.push({
      id: "net-income",
      label: "Observed take-home pay",
      detail:
        "No income transactions were found in the window, so savings and contribution figures have no denominator.",
      href: "/settings/categories",
      linkLabel: "Check your income categories",
    });
  }

  // The household profile only refines defaults, so it is last: guidance works
  // without it, using the checked-in multipliers.
  if (input.household.profile === null && input.household.members.length === 0) {
    missing.push({
      id: "household",
      label: "Household details",
      detail:
        "No household details are recorded, so generic multipliers are being used — a single earner with no dependents. Adding earners and dependents refines the reserve target.",
      href: "/settings/household",
      linkLabel: "Add household details",
    });
  }

  return {
    historyMonths: input.historyMonths,
    hasHistory: input.historyMonths > 0,
    missing,
  };
}
