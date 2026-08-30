import {
  type FlowTxn as InvestmentTxnFields,
  externalFlow,
} from "@/lib/investments/performance.ts";
import { Money } from "@/lib/money/money.ts";
import { parseIsoDate } from "@/lib/schedule/occurrences.ts";
import Decimal from "decimal.js";
import type { ClassifiedFlow } from "./boundary.ts";
import { type AccountEndpoint, assertWindow, withinWindow } from "./endpoints.ts";
import { DEFAULT_PAIRING, type PairingOptions } from "./pairing.ts";
import type { SavedResult } from "./saved.ts";
import type { ResidualDiagnostic, ResidualDiagnosticCode } from "./types.ts";

/**
 * Making `unexplained` name its own causes (P17-16/17, ADR-039 §4).
 *
 * Pure and I/O-free. Turns the residual from a verdict into an instruction: not
 * *"$4,200 is unexplained"* but *"$4,200 of transactions in this window have no
 * category, and here is the page where you fix that"*.
 *
 * ── Why this is the task that decides whether the phase is worth shipping ───
 * A decomposition that reconciles perfectly on every book is one that derived a
 * rung from the balances it claims to explain (see [saved.ts](./saved.ts)), so a
 * real residual is the *proof* the measurement is honest. But an honest number
 * nobody can act on erodes trust exactly as fast as a dishonest one: a household
 * shown "we can't explain $4,200 of your money" with no further detail learns
 * only that the app is unreliable. Every diagnostic here exists to convert that
 * into a specific, fixable input.
 *
 * ── The signature deviates from the plan's sketch, and it has to ───────────
 * PLAN17 P17-16 sketches `residualDiagnostics(input, result)`. It cannot take
 * the {@link AttributionResult}: `diagnostics` is a *field* of that result, so
 * the assembler (P17-11) must call this function to build the very object the
 * sketch would have it pass in. The dependency only runs one way. Nothing is
 * lost — every condition below is a property of the inputs, not of the
 * arithmetic, which is also why an all-clean book returns `[]` even when the
 * residual happens to be large.
 *
 * ── A magnitude is not a correction ────────────────────────────────────────
 * `magnitude` answers "how much money does this involve", never "fix this and
 * the residual moves by exactly this much". Two diagnostics can describe the
 * same dollars from different angles, and their magnitudes deliberately do not
 * sum to anything. Presenting them as signed contributions would assert an
 * arithmetic relationship the app cannot honestly support, so they are unsigned
 * and sorted rather than totalled.
 *
 * ── Money discipline (CLAUDE.md §Money) ────────────────────────────────────
 * Every money value goes through {@link Money}. The one place raw `Decimal`
 * appears is the quantity ratio in {@link quantityDriftDiagnostic}, because
 * share counts are `numeric(28,8)` and rounding them to cents would erase a
 * crypto position's whole quantity. That ratio is dimensionless; the money it
 * scales is `Money` on both sides of the multiplication.
 *
 * ── Privacy (CLAUDE.md §Privacy, enforced by P17-27) ───────────────────────
 * Diagnostics carry account names and ticker symbols — both of which the
 * authenticated UI already shows on the page these link to — and never a payee
 * string, a household member label, or a transaction descriptor. A diagnostic
 * is rendered on screen and could end up in a screenshot; a merchant name in one
 * would be a disclosure the user did not ask for and the diagnostic does not
 * need.
 */

const CURRENCY = "USD";
const MS_PER_DAY = 86_400_000;

/**
 * Account types whose balance change is supposed to be explained by `saved`.
 *
 * The narrow set is the point. A property's balance moving with no transactions
 * is an appraisal, and the `asset_revaluation` rung already explains it; an
 * investment account's is market movement, and `investment_return` explains
 * that; a loan's is amortization. Only cash and cards have their movement
 * attributed to transaction flow, so only they can move *without* transactions
 * and land the difference straight in the residual.
 */
export const FLOW_EXPLAINED_ACCOUNT_TYPES = ["depository", "credit_card"] as const;

/**
 * Account types `computeNetWorth` values from `account_snapshots` (compute.ts
 * rules 2, 4 and 5).
 *
 * Loans are excluded because they never read a snapshot at all — they are
 * computed from the amortization schedule — so a "missing snapshot" is not a
 * defect for them. Investment accounts are excluded because they are valued from
 * holdings × prices and only *fall back* to a snapshot, so a missing one is
 * frequently the normal case rather than a gap.
 */
export const SNAPSHOT_DRIVEN_ACCOUNT_TYPES = [
  "depository",
  "credit_card",
  "property",
  "personal_asset",
] as const;

/**
 * How far a snapshot may sit behind an endpoint before it is a gap.
 *
 * A stated constant with a rationale, per the ADR-040 consequence-2 discipline —
 * **not a number tuned until the diagnostic stopped firing.**
 *
 * The figure follows from how the app writes snapshots rather than from how
 * often a household checks its accounts: `compute-snapshots-daily` writes a row
 * **every night**, carrying the previous balance forward for exactly the types
 * listed above. So on a running install the newest snapshot on or before any
 * date is that date itself, and a 45-day gap does not mean "the user forgot to
 * update a balance" — it means the worker has not run, which on a self-hosted
 * box usually means the machine was off or the queue is wedged. That is worth
 * saying out loud, and 45 days (a full statement cycle plus two weeks) is wide
 * enough that a brief outage does not cry wolf.
 */
export const STALE_SNAPSHOT_DAYS = 45;

/** An account as the diagnostics read it — endpoints plus what the loader knows. */
export interface DiagnosticAccount {
  readonly accountId: string;
  readonly accountName: string;
  readonly accountType: string;
  /**
   * Whether a `liabilities` row exists. Only meaningful for `type='loan'`.
   *
   * `computeNetWorth` **skips** a loan without one entirely — it is not zeroed,
   * it is absent — so the account is missing from net worth at both endpoints.
   */
  readonly hasLiabilityRow: boolean;
  /** Latest `account_snapshots.date` on or before the window start; `null` if none. */
  readonly openingSnapshotDate: string | null;
  /** Latest `account_snapshots.date` on or before the window end; `null` if none. */
  readonly closingSnapshotDate: string | null;
}

/**
 * An investment transaction, widened with the one field the rung does not need.
 *
 * `source` is here and nowhere else in this phase's investment shapes because of
 * ADR-041 §3: a payroll-direct contribution (`source='income'`) is an external
 * flow into a brokerage that by design has **no** matching cash outflow — the
 * money never passed through a tracked checking account. Without this field the
 * unmatched-deposit diagnostic would flag every single 401(k) contribution as a
 * data problem, on a book where nothing whatsoever is wrong.
 */
export interface DiagnosticInvestmentTxn extends InvestmentTxnFields {
  readonly accountId: string;
  /** `'plaid' | 'manual' | 'income'`. `'income'` is exempt — see above. */
  readonly source: string;
}

/** One position's share count at the window's opening date versus today. */
export interface HoldingQuantity {
  readonly holdingId: string;
  /** Ticker or coin id. Display only; never parsed. */
  readonly symbol: string;
  readonly accountId: string;
  /** `holding_snapshots.quantity` on the opening date; `null` when unrecorded. */
  readonly openingQuantity: string | null;
  /** `holding_snapshots.value` on that date — quantity × that day's close. */
  readonly openingValue: string | null;
  /** `holdings.quantity` today — what every historical date is priced at. */
  readonly currentQuantity: string;
}

/** Everything the diagnostics read. A structural subset, per ADR-032 §1. */
export interface DiagnosticsInput {
  /** Inclusive window start, `YYYY-MM-DD`. */
  readonly from: string;
  /** Inclusive window end, `YYYY-MM-DD`. */
  readonly to: string;
  /** Every account on the book — including ones absent from `endpoints`. */
  readonly accounts: readonly DiagnosticAccount[];
  /** Per-account deltas from `endpointsFor` (P17-06). */
  readonly endpoints: ReadonlyMap<string, AccountEndpoint>;
  /** The `saved` rung's excluded volumes, computed in the same pass (P17-05). */
  readonly saved: SavedResult;
  /** How many transfer legs `pairTransfers` could not match (P17-04). */
  readonly unpairedTransferCount: number;
  /** Every cash row in the window with its verdict (P17-03). */
  readonly classified: readonly ClassifiedFlow[];
  /** Every investment transaction in the window. */
  readonly investmentTxns: readonly DiagnosticInvestmentTxn[];
  /** Every position, with its opening share count. */
  readonly holdings: readonly HoldingQuantity[];
  /** Tolerances for matching a brokerage deposit to a cash outflow. */
  readonly pairing?: PairingOptions;
}

/**
 * Name every contributor to the residual this window's inputs can support.
 *
 * @param input - The window and the rows behind it. Never mutated.
 * @param currency - Currency to sum magnitudes in. Single-currency app; USD.
 * @returns Diagnostics sorted by magnitude descending, ties broken by `code` so
 *   the list is byte-identical across runs. An empty array is a real and common
 *   answer: it says the app checked every cause it knows and found none, which
 *   is different from having nothing to say.
 * @throws If the window runs backwards.
 */
export function residualDiagnostics(
  input: DiagnosticsInput,
  currency: string = CURRENCY,
): ResidualDiagnostic[] {
  assertWindow(input.from, input.to, "residualDiagnostics");

  const found = [
    untrackedLoanDiagnostic(input),
    snapshotGapDiagnostic(input, currency),
    manualBalanceDiagnostic(input, currency),
    uncategorizedDiagnostic(input),
    unpairedTransferDiagnostic(input),
    unmatchedDepositDiagnostic(input, currency),
    quantityDriftDiagnostic(input, currency),
  ].filter((d): d is ResidualDiagnostic => d !== null);

  return found.sort((a, b) => {
    const byMagnitude = Money.fromString(b.magnitude, currency).compare(
      Money.fromString(a.magnitude, currency),
    );
    return byMagnitude !== 0 ? byMagnitude : compareCodes(a.code, b.code);
  });
}

/**
 * Loan accounts with no amortization terms.
 *
 * Magnitude is `"0.00"` and that is the honest figure, not a placeholder: a loan
 * `computeNetWorth` skips contributes nothing to *either* endpoint, so it
 * contributes nothing to the delta and nothing to the residual. Its real cost is
 * that net worth itself is wrong — which is a larger problem than the one this
 * page is about, and is why the diagnostic is reported even though it sorts last
 * among the nonzero ones.
 */
function untrackedLoanDiagnostic(input: DiagnosticsInput): ResidualDiagnostic | null {
  const loans = input.accounts.filter((a) => a.accountType === "loan" && !a.hasLiabilityRow);
  if (loans.length === 0) return null;

  return {
    code: "untracked_loan",
    label: "Loans with no repayment terms",
    detail: `${countPhrase(loans.length, "loan account")} ${loans.length === 1 ? "has" : "have"} no principal, rate, or term recorded, so ${namesOf(loans)} ${loans.length === 1 ? "is" : "are"} left out of net worth entirely — at both ends of this window.`,
    magnitude: "0.00",
    href: accountHref(loans),
  };
}

/** Accounts whose endpoint value came from a missing or long-stale snapshot. */
function snapshotGapDiagnostic(
  input: DiagnosticsInput,
  currency: string,
): ResidualDiagnostic | null {
  const affected = input.accounts.filter(
    (a) =>
      (SNAPSHOT_DRIVEN_ACCOUNT_TYPES as readonly string[]).includes(a.accountType) &&
      (isGap(a.openingSnapshotDate, input.from) || isGap(a.closingSnapshotDate, input.to)),
  );
  if (affected.length === 0) return null;

  // The balance being *stated* from the gap, not the account's delta: when both
  // endpoints read the same stale row the delta is exactly zero, which would
  // sort a two-month-old house valuation last precisely when it matters most.
  const magnitude = Money.sum(
    affected.map((a) => largerEndpoint(input.endpoints.get(a.accountId), currency)),
    currency,
  );

  return {
    code: "snapshot_gap",
    label: "Balances with no recent record",
    detail: `${countPhrase(affected.length, "account")} had no balance recorded within ${STALE_SNAPSHOT_DAYS} days of one end of this window (${namesOf(affected)}), so that end of the change is stated from stale or missing data. The nightly job records a balance every day, so a gap this wide usually means it has not been running.`,
    magnitude: magnitude.toString(),
    href: accountHref(affected),
  };
}

/**
 * Cash and card accounts that moved without a single transaction to show for it.
 *
 * This is the manual-balance case: a household types a new checking balance, net
 * worth moves, and no row exists for `saved` to have seen. The delta is real and
 * the identity still holds — the whole amount simply lands in the residual.
 */
function manualBalanceDiagnostic(
  input: DiagnosticsInput,
  currency: string,
): ResidualDiagnostic | null {
  const withActivity = new Set(input.classified.map((c) => c.txn.accountId));
  const affected = input.accounts.filter((a) => {
    if (!(FLOW_EXPLAINED_ACCOUNT_TYPES as readonly string[]).includes(a.accountType)) return false;
    if (withActivity.has(a.accountId)) return false;
    const endpoint = input.endpoints.get(a.accountId);
    return endpoint !== undefined && !Money.fromString(endpoint.delta, currency).isZero();
  });
  if (affected.length === 0) return null;

  const magnitude = Money.sum(
    affected.map((a) =>
      Money.fromString(input.endpoints.get(a.accountId)?.delta ?? "0.00", currency).abs(),
    ),
    currency,
  );

  return {
    code: "manual_balance_accounts",
    label: "Balances that changed with no transactions",
    detail: `${namesOf(affected)} changed over this window without a single transaction in it, so nothing explains the movement. Importing or connecting the account's transactions is what turns this into a rung.`,
    magnitude: magnitude.toString(),
    href: accountHref(affected),
  };
}

/** Rows with no category, which contribute to no rung at all. */
function uncategorizedDiagnostic(input: DiagnosticsInput): ResidualDiagnostic | null {
  if (input.saved.uncategorizedCount === 0) return null;

  return {
    code: "uncategorized",
    label: "Uncategorized transactions",
    detail: `${countPhrase(input.saved.uncategorizedCount, "transaction")} in this window ${input.saved.uncategorizedCount === 1 ? "has" : "have"} no category, so ${input.saved.uncategorizedCount === 1 ? "it counts" : "they count"} toward neither what you earned nor what you spent.`,
    magnitude: input.saved.uncategorizedVolume,
    href: "/analysis/review",
  };
}

/**
 * Transfer legs with no counterparty.
 *
 * Labelled for what it is rather than for how it feels (ADR-040 consequence 2):
 * money moved to an account the app does not track. Calling this "unexplained"
 * would use the residual as its own explanation, which is the one thing P17-18
 * forbids.
 */
function unpairedTransferDiagnostic(input: DiagnosticsInput): ResidualDiagnostic | null {
  if (input.unpairedTransferCount === 0) return null;

  return {
    code: "unpaired_transfers",
    label: "Transfers to accounts this app doesn't track",
    detail: `${countPhrase(input.unpairedTransferCount, "transfer")} in this window had no matching leg in another tracked account, so the money is treated as having left the household even if it did not.`,
    magnitude: input.saved.unpairedTransferVolume,
    href: "/accounts",
  };
}

/**
 * Money arriving in a brokerage from somewhere the app cannot see.
 *
 * When a deposit's cash leg *is* tracked, the two cancel: the cash account falls,
 * the brokerage rises, and `investment_return` correctly excludes the flow. When
 * it is not, tracked net worth genuinely rose and no rung claims it — the
 * residual is right, and this names why.
 *
 * Payroll-direct contributions are exempt by construction (ADR-041 §3): they
 * have their own rung precisely because no cash leg exists.
 */
function unmatchedDepositDiagnostic(
  input: DiagnosticsInput,
  currency: string,
): ResidualDiagnostic | null {
  const tolerances = input.pairing ?? DEFAULT_PAIRING;
  const outflows = input.classified
    .map((c) => c.txn)
    .filter((t) => Money.fromString(t.amount, currency).isNegative());
  const claimed = new Set<string>();
  let magnitude = Money.zero(currency);
  let count = 0;

  for (const deposit of externalInflows(input, currency)) {
    const match = outflows.find(
      (t) =>
        !claimed.has(t.id) &&
        t.accountId !== deposit.accountId &&
        withinDays(t.postedAt, deposit.date, tolerances.windowDays) &&
        withinAmount(t.amount, deposit.amount, tolerances.amountAbs, currency),
    );
    if (match !== undefined) {
      claimed.add(match.id);
      continue;
    }
    magnitude = magnitude.add(Money.fromString(deposit.amount, currency).abs());
    count += 1;
  }

  if (count === 0) return null;
  return {
    code: "unmatched_investment_deposits",
    label: "Investment deposits from an untracked source",
    detail: `${countPhrase(count, "deposit")} into an investment account ${count === 1 ? "has" : "have"} no matching withdrawal from a tracked cash account, so the money looks like it arrived from outside the book. Payroll contributions are already accounted for separately and are not counted here.`,
    magnitude: magnitude.toString(),
    href: "/accounts",
  };
}

/**
 * The ADR-039 §2 wart, made visible (P17-17).
 *
 * `computeNetWorth` prices every historical date at **today's** share count, so
 * a position bought, sold, or added to inside the window makes the opening
 * endpoint a figure the household never actually had. The delta is affected, and
 * with it the `investment_return` rung — which is exactly why a documented wart
 * is not good enough on this page: the person reading it is reading it *because*
 * a number surprised them.
 *
 * A holding with no opening record is counted separately and adds nothing to the
 * magnitude. `holding_snapshots` only began in Phase 9 and its backfill was
 * best-effort, so an absent row means the share count is **unknown**, not zero,
 * and inventing a magnitude from it would be the guess this phase exists to
 * avoid.
 */
function quantityDriftDiagnostic(
  input: DiagnosticsInput,
  currency: string,
): ResidualDiagnostic | null {
  let magnitude = Money.zero(currency);
  const drifted: string[] = [];
  let unknown = 0;

  for (const h of input.holdings) {
    if (h.openingQuantity === null || h.openingValue === null) {
      unknown += 1;
      continue;
    }
    const opening = new Decimal(h.openingQuantity);
    const drift = new Decimal(h.currentQuantity).minus(opening).abs();
    if (drift.isZero()) continue;
    drifted.push(h.symbol);
    // Scale the recorded opening VALUE by the share-count error rather than
    // deriving a unit price: a crypto price rounded to cents is zero.
    if (opening.isZero()) continue;
    const ratio = drift.dividedBy(opening.abs());
    magnitude = magnitude.add(
      Money.fromString(h.openingValue, currency).abs().mul(ratio.toFixed(8)),
    );
  }

  if (drifted.length === 0 && unknown === 0) return null;
  return {
    code: "quantity_drift",
    label: "Historical values use today's share counts",
    detail: driftDetail(drifted, unknown),
    magnitude: magnitude.toString(),
    href: "/investments",
  };
}

function driftDetail(drifted: readonly string[], unknown: number): string {
  const parts: string[] = [];
  if (drifted.length > 0) {
    parts.push(
      `${countPhrase(drifted.length, "position")} changed share count during this window (${listOf(drifted)})`,
    );
  }
  if (unknown > 0) {
    parts.push(`${countPhrase(unknown, "position")} had no share count recorded at the start`);
  }
  return `${parts.join(", and ")}. Historical net worth prices every date at today's share counts, so the opening figure and the market-return rung are both affected.`;
}

/** External inflows into an investment account, excluding payroll-direct ones. */
function externalInflows(
  input: DiagnosticsInput,
  currency: string,
): { accountId: string; date: string; amount: string }[] {
  const inflows: { accountId: string; date: string; amount: string }[] = [];
  for (const txn of input.investmentTxns) {
    if (txn.source === "income") continue;
    if (!withinWindow(txn.date, input.from, input.to)) continue;
    const flow = externalFlow(txn);
    if (flow === null) continue;
    const amount = Money.fromString(flow.amount, currency);
    if (amount.isNegative() || amount.isZero()) continue;
    inflows.push({ accountId: txn.accountId, date: flow.date, amount: flow.amount });
  }
  return inflows;
}

/** `null` (no snapshot at all) or older than {@link STALE_SNAPSHOT_DAYS}. */
function isGap(snapshotDate: string | null, endpoint: string): boolean {
  if (snapshotDate === null) return true;
  return !withinDays(snapshotDate, endpoint, STALE_SNAPSHOT_DAYS);
}

function withinDays(a: string, b: string, days: number): boolean {
  const gap = Math.abs(parseIsoDate(a, "date") - parseIsoDate(b, "date")) / MS_PER_DAY;
  return gap <= days;
}

function withinAmount(a: string, b: string, tolerance: string, currency: string): boolean {
  const diff = Money.fromString(a, currency).abs().sub(Money.fromString(b, currency).abs()).abs();
  return diff.compare(Money.fromString(tolerance, currency)) <= 0;
}

/** The larger of the two endpoint magnitudes, or zero when the account has none. */
function largerEndpoint(endpoint: AccountEndpoint | undefined, currency: string): Money {
  if (endpoint === undefined) return Money.zero(currency);
  const opening = Money.fromString(endpoint.opening, currency).abs();
  const closing = Money.fromString(endpoint.closing, currency).abs();
  return opening.compare(closing) >= 0 ? opening : closing;
}

/** `/accounts/[id]` when exactly one account is implicated, the list otherwise. */
function accountHref(accounts: readonly DiagnosticAccount[]): string {
  return accounts.length === 1 && accounts[0] !== undefined
    ? `/accounts/${accounts[0].accountId}`
    : "/accounts";
}

function namesOf(accounts: readonly DiagnosticAccount[]): string {
  return listOf(accounts.map((a) => a.accountName));
}

/** Up to two names, then a count. A diagnostic is a sentence, not a report. */
function listOf(names: readonly string[]): string {
  if (names.length <= 2) return names.join(" and ");
  return `${names.slice(0, 2).join(", ")} and ${names.length - 2} more`;
}

function countPhrase(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function compareCodes(a: ResidualDiagnosticCode, b: ResidualDiagnosticCode): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}
