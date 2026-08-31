import type { ObligationAmountMode } from "@/db/schema/scheduled-obligations.ts";
import { Money } from "@/lib/money/money.ts";
import { monthlyPayment } from "@/lib/mortgage/amortization.ts";
import { parseIsoDate } from "@/lib/schedule/occurrences.ts";
import { amountStability } from "./amount-stability.ts";

/**
 * liabilityCandidates: propose the schedule the household already stated
 * (CF-A2, ADR-047).
 *
 * Pure and I/O-free, exactly like [detect.ts](./detect.ts) — it reads the rows
 * it is handed and nothing else, and `today` is an explicit input so a proposal
 * can be reproduced when the user asks why it was proposed.
 *
 * ── Why this module exists at all ──────────────────────────────────────────
 * Before it, the cash-flow calendar had two doors. **Detection** needs three
 * payments imported, a servicer descriptor that normalizes stably, and the user
 * finding the proposal in a list ranked against everything else. **Manual
 * entry** asks the household to hand-copy figures the app is holding one table
 * away: a `loan` account carries a `liabilities` row with the principal, the
 * rate, the term and the start date, and
 * [`monthlyPayment()`](../mortgage/amortization.ts) turns those into the payment
 * in closed form — the advice layer has called it for the minimum payment since
 * Phase 15. So the one bill whose schedule the user *stated* was the only bill
 * the calendar could learn about solely by *guessing from bank text*.
 *
 * ── It proposes; it never commits (ADR-036 §2 is unchanged) ────────────────
 * Nothing here writes anything, and confirming is still a click. ADR-036 §2 is
 * not weakened by this module — it is satisfied more cheaply, because the
 * proposal arrives pre-filled and correct rather than reverse-engineered. A
 * liability candidate therefore carries **no confidence grade**: nothing was
 * guessed, so there is nothing to grade.
 *
 * ── The one decision that keeps the money from being counted twice ─────────
 * A confirmed liability obligation gets `detection_key = NULL` (ADR-047 §4).
 * That is not an omission — it is the mechanism. The matcher matches an
 * occurrence to a posted transaction ON `detection_key`; a synthetic key would
 * match no transaction that will ever exist, the occurrence would stay
 * unmatched, and [residual.ts](./residual.ts) would keep the payment inside the
 * flat daily rate **while the calendar also dated it**. That is ADR-038 §2's
 * double-count. Left NULL, the matcher falls back to
 * `(account, direction, window, amount)` and pairs the occurrence to the real
 * payment, so confirming a mortgage **re-dates** spend the projection already
 * contained rather than adding any.
 *
 * ── Observed beats computed, and that is a correctness rule (ADR-047 §6) ───
 * `monthlyPayment()` returns principal-and-interest. A real escrowed payment is
 * materially larger — taxes and insurance ride along — and the matcher's
 * tolerance on a `fixed` obligation is ±15%. A P&I expectation against an
 * escrow-inflated actual can clear that band, and when it does the occurrence is
 * marked **missed**: a false *"A bill did not post"* alert on a mortgage that
 * was paid, plus the payment left in the residual while the calendar dates it.
 * So when the household's own payments are visible they set the amount, and P&I
 * is the fallback — carried alongside either way, because the gap between the
 * two IS the escrow and is worth seeing once.
 *
 * ── Privacy ────────────────────────────────────────────────────────────────
 * Every string here names a real servicer. There is no directory, no lookup and
 * no outbound call of any kind — by construction, since this module is pure.
 * `monthlyPayment()` is arithmetic over terms the user typed in.
 */

const CURRENCY = "USD";
const MS_PER_DAY = 86_400_000;

/**
 * How far back observed payments are read.
 *
 * Six months rather than the detector's twenty-four. Two reasons, both about
 * escrow: a median over two years lags an annual escrow re-analysis by up to a
 * year, and the `start_date` derived below (see {@link LiabilityCandidate}) is
 * bounded by the same window — so a household that has never imported a
 * mortgage payment cannot have eighty historical occurrences materialized on
 * confirm, every one of which would sweep to `missed` and raise an alert.
 */
export const OBSERVED_PAYMENT_WINDOW_MONTHS = 6;

/** Payments needed before observed amounts outrank the computed schedule. */
export const MIN_OBSERVED_PAYMENTS = 2;

/**
 * The band a payment series must fall in to be this loan's.
 *
 * Escrow only ever ADDS to principal-and-interest, so the floor sits just below
 * 1 to absorb cent rounding and a servicer that applies a small credit, while
 * the ceiling has to cover taxes and insurance on a low-rate loan in a
 * high-tax county. Wider than 1.75× starts admitting an unrelated bill that
 * happens to be about twice the size, which would attach the household's
 * largest schedule to the wrong payee — so the band deliberately fails to the
 * safe side: no match means P&I with the escrow caveat stated, which the user
 * can correct in the field, rather than a confident wrong number.
 */
export const PAYMENT_FLOOR_MULTIPLE = "0.90";
export const PAYMENT_CEILING_MULTIPLE = "1.75";

/** The gap between consecutive payments a monthly series must keep, in days. */
export const MIN_PAYMENT_GAP_DAYS = 20;
export const MAX_PAYMENT_GAP_DAYS = 45;

/** A fixed-rate loan's stated terms, as this module reads them. */
export interface LiabilityTerms {
  readonly id: string;
  /** The LOAN account. Never the account the payment leaves — see §8. */
  readonly accountId: string;
  readonly name: string;
  readonly principalAtOrigination: string;
  /** Decimal fraction, e.g. `"0.065"`. */
  readonly annualRate: string;
  readonly termMonths: number;
  readonly startDate: string;
}

/** An operating-cash account a payment could leave from. */
export interface PayingAccount {
  readonly accountId: string;
  readonly name: string;
  readonly institution: string;
}

/**
 * One outflow already observed on an operating account.
 *
 * The caller hands over the whole trailing window and this module decides which
 * series belongs to which loan. That split is deliberate: the decision is the
 * part worth testing, and it is untestable if it lives in a query.
 */
export interface ObservedOutflow {
  readonly accountId: string;
  /** `payeeKey(name)` — the one normalization (ADR-036 §4). */
  readonly payeeKey: string;
  /** A raw description, so the review UI can show what was recognized. */
  readonly name: string;
  readonly postedAt: string;
  /** Signed as stored. Positive rows are ignored. */
  readonly amount: string;
}

/** One observed payment, kept as the candidate's evidence. */
export interface LiabilityPaymentEvidence {
  readonly date: string;
  /** Positive magnitude. */
  readonly amount: string;
}

/**
 * A schedule proposed from stated loan terms, awaiting the user's confirmation.
 *
 * Deliberately NOT an `ObligationCandidate`: that shape carries a `payeeKey`
 * and a `confidence`, and this proposal has neither. Two similar-looking types
 * are cheaper than one type with two fields that are meaningless half the time
 * — the review page renders them as two sections for exactly that reason.
 */
export interface LiabilityCandidate {
  readonly liabilityId: string;
  /** The `loan` account the terms hang off. */
  readonly loanAccountId: string;
  /**
   * The operating account the money LEAVES, or `null` when observed payments do
   * not identify exactly one (ADR-047 §8). Never guessed: attaching a
   * household's largest bill to the wrong balance moves the low-water date,
   * which is the whole number this page exists to state.
   */
  readonly accountId: string | null;
  /** Every operating account, so the UI can offer a selector. */
  readonly accountOptions: readonly PayingAccount[];
  /** A suggested, editable label — the liability's own name. */
  readonly label: string;
  readonly direction: "outflow";
  readonly cadence: "monthly";
  /** Phases the schedule. The last observed payment, else the loan's start. */
  readonly anchorDate: string;
  /**
   * First date occurrences may be materialized from.
   *
   * The first observed payment when there is one — matching the detector's use
   * of `firstSeen`, and every month in that range has a real transaction to
   * match against. With no observed payments it is `today`, NOT the loan's
   * origination: back-dating a schedule to 2019 would materialize eighty
   * occurrences the app holds no evidence for, sweep every one of them to
   * `missed`, and bury the household in alerts for a mortgage they have paid
   * every month for six years.
   */
  readonly startDate: string;
  /** The proposed amount, a positive magnitude. */
  readonly expectedAmount: string;
  readonly amountMode: ObligationAmountMode;
  /** Computed principal-and-interest. Always present, always shown. */
  readonly scheduledPayment: string;
  /** Median of the observed payments, or `null` when there were too few. */
  readonly observedMedian: string | null;
  /** Median absolute deviation of the observed payments; `null` with none. */
  readonly observedSpread: string | null;
  readonly observedCount: number;
  /**
   * True when the proposal rests on P&I alone, so escrow and PMI are NOT
   * included. The review UI says so in words — a mortgage figure that is
   * quietly a few hundred dollars light is worse than no figure.
   */
  readonly escrowCaveat: boolean;
  /** The observed payments, ascending by date. Empty when none were found. */
  readonly evidence: readonly LiabilityPaymentEvidence[];
  /** A raw description of the recognized series, or `null`. */
  readonly sampleName: string | null;
  /**
   * The `payeeKey` of the payments this proposal was priced from, or `null`
   * when none were recognized.
   *
   * Carried for ONE purpose: the review page compares it against the detector's
   * proposals to warn when both describe the same series (ADR-047 consequence
   * 4). It is deliberately NOT what gets stored — a confirmed liability
   * obligation writes `detection_key = NULL`, because the matcher matches on
   * that column and a key here would leave the occurrence unmatchable.
   */
  readonly payeeKey: string | null;
}

export interface LiabilityCandidateInput {
  readonly liabilities: readonly LiabilityTerms[];
  /** Open `checking` / `cash_management` accounts (ADR-033 §1). */
  readonly operatingAccounts: readonly PayingAccount[];
  /** Trailing outflows on those accounts. See {@link ObservedOutflow}. */
  readonly observedOutflows: readonly ObservedOutflow[];
  /** `YYYY-MM-DD`. Explicit rather than read from the clock. */
  readonly today: string;
}

/** One `(account, payee)` series of outflows, as the matcher below reads it. */
interface PaymentSeries {
  readonly key: string;
  readonly accountId: string;
  readonly payeeKey: string;
  readonly name: string;
  readonly payments: readonly LiabilityPaymentEvidence[];
  readonly median: Money;
  readonly spread: string;
}

/**
 * Propose one schedule per loan whose terms the household has stated.
 *
 * @param input - The liabilities, the operating accounts money could leave
 *   from, the trailing outflows on those accounts, and the reference date.
 * @returns Candidates ordered by `(label, liabilityId)` — stable across runs, so
 *   the review list does not reshuffle between page loads. A paid-off loan, a
 *   zero-payment loan, and a loan with no operating account to pay from all
 *   propose nothing.
 * @throws If a stated date is not a real `YYYY-MM-DD`, or the terms are
 *   arithmetically impossible (a negative rate, a non-positive term). A bad row
 *   stops the run loudly rather than quietly dropping the household's largest
 *   bill out of a number they spend against.
 */
export function liabilityCandidates(input: LiabilityCandidateInput): LiabilityCandidate[] {
  // Validate the reference date before anything derives a schedule from it.
  parseIsoDate(input.today, "today");
  const series = buildSeries(input.observedOutflows, input.operatingAccounts);
  const claimed = new Set<string>();
  const out: LiabilityCandidate[] = [];

  // Loans are considered in a stable order so that two loans whose bands
  // overlap always claim the same series as each other, run after run.
  const ordered = [...input.liabilities].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  for (const liability of ordered) {
    if (isPaidOff(liability, input.today)) continue;

    const scheduled = monthlyPayment(
      Money.fromString(liability.principalAtOrigination, CURRENCY),
      liability.annualRate,
      liability.termMonths,
    );
    // A zero payment is not a bill. It happens only on a zero-principal row,
    // which is a data-entry artefact rather than a loan the household pays.
    if (scheduled.isZero()) continue;

    const qualifying = qualifyingSeries(series, scheduled, claimed);
    const match = qualifying[0];
    if (match !== undefined) claimed.add(match.key);

    // ADR-047 §8, read literally: the account is inferred only when observed
    // payments identify EXACTLY ONE. Two qualifying series on two accounts is a
    // household that could be paying from either, and attaching the largest bill
    // in the month to the wrong balance moves the low-water date — the one thing
    // this page exists to state. The amount still comes from the best-fitting
    // series, because the household's own payments are the better figure
    // whichever account they left, and the review UI shows the charges it used.
    const accounts = new Set(qualifying.map((candidate) => candidate.accountId));
    const accountId = accounts.size === 1 ? (match?.accountId ?? null) : null;

    const evidence = match?.payments ?? [];
    const hasObserved = evidence.length >= MIN_OBSERVED_PAYMENTS;
    const last = evidence[evidence.length - 1];
    const first = evidence[0];

    out.push({
      liabilityId: liability.id,
      loanAccountId: liability.accountId,
      accountId,
      accountOptions: input.operatingAccounts,
      label: liability.name,
      direction: "outflow",
      cadence: "monthly",
      // The observed phase beats the stated one: a payment that posts on the 3rd
      // is what the household's balance actually does, whatever the note says.
      anchorDate: last?.date ?? liability.startDate,
      startDate: first?.date ?? input.today,
      // ADR-047 §6. `amountStability`'s own verdict is deliberately NOT consulted
      // for the mode: a mortgage's amount moves at every escrow re-analysis, and
      // `trailing_median` is what stops that annual step from reporting as a
      // bill that did not post.
      expectedAmount: hasObserved && match ? match.median.toString() : scheduled.toString(),
      amountMode: hasObserved ? "trailing_median" : "fixed",
      scheduledPayment: scheduled.toString(),
      observedMedian: hasObserved && match ? match.median.toString() : null,
      observedSpread: hasObserved && match ? match.spread : null,
      observedCount: evidence.length,
      escrowCaveat: !hasObserved,
      evidence,
      sampleName: match?.name ?? null,
      payeeKey: match?.payeeKey ?? null,
    });
  }

  return out.sort((a, b) =>
    a.label !== b.label
      ? a.label < b.label
        ? -1
        : 1
      : a.liabilityId < b.liabilityId
        ? -1
        : a.liabilityId > b.liabilityId
          ? 1
          : 0,
  );
}

/**
 * Group trailing outflows into `(account, payee)` series that look monthly.
 *
 * A series qualifies on shape alone — enough payments, roughly a month apart —
 * without reference to any loan. Which loan it belongs to is decided afterwards,
 * by amount, so one series can never be silently reshaped to fit a loan.
 */
function buildSeries(
  outflows: readonly ObservedOutflow[],
  operating: readonly PayingAccount[],
): PaymentSeries[] {
  const allowed = new Set(operating.map((account) => account.accountId));
  const groups = new Map<
    string,
    { accountId: string; payeeKey: string; name: string; rows: ObservedOutflow[] }
  >();

  for (const row of outflows) {
    if (!allowed.has(row.accountId)) continue;
    const amount = Money.fromString(row.amount, CURRENCY);
    if (!amount.isNegative()) continue;
    // NUL as the separator, for the reason `detect.ts` states: it is the one
    // character `payeeKey` can never emit, so no payee name can forge a
    // collision across accounts. Written as the ESCAPE, never as a raw byte — a
    // literal NUL makes `grep` classify this file as binary and skip it, which
    // would silently exclude this module from every text-based audit in the
    // repo, the privacy sweep included.
    const key = `${row.accountId}\u0000${row.payeeKey}`;
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, {
        accountId: row.accountId,
        payeeKey: row.payeeKey,
        name: row.name,
        rows: [row],
      });
    } else {
      group.rows.push(row);
    }
  }

  const out: PaymentSeries[] = [];
  for (const [key, group] of groups) {
    const payments = group.rows
      .map((row) => ({
        date: row.postedAt,
        amount: Money.fromString(row.amount, CURRENCY).abs().toString(),
      }))
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    if (payments.length < MIN_OBSERVED_PAYMENTS) continue;
    if (!isMonthly(payments)) continue;

    const stability = amountStability(
      payments.map((payment) => payment.amount),
      CURRENCY,
    );
    out.push({
      key,
      accountId: group.accountId,
      payeeKey: group.payeeKey,
      name: group.name,
      payments,
      median: Money.fromString(stability.median, CURRENCY),
      spread: stability.spread,
    });
  }
  // Stable order so the claim loop is deterministic regardless of Map ordering.
  return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** Every consecutive gap sits inside the monthly band. */
function isMonthly(payments: readonly LiabilityPaymentEvidence[]): boolean {
  for (let i = 1; i < payments.length; i += 1) {
    const previous = payments[i - 1] as LiabilityPaymentEvidence;
    const current = payments[i] as LiabilityPaymentEvidence;
    const gap = Math.round(
      (parseIsoDate(current.date, "postedAt") - parseIsoDate(previous.date, "postedAt")) /
        MS_PER_DAY,
    );
    if (gap < MIN_PAYMENT_GAP_DAYS || gap > MAX_PAYMENT_GAP_DAYS) return false;
  }
  return true;
}

/**
 * Every unclaimed series whose median could be this loan's payment, best first.
 *
 * Ranked by absolute distance from principal-and-interest, tie-broken by the
 * series key — total, so the answer cannot depend on row order. Comparing
 * distances rather than ratios avoids materializing a `Money.div` that would
 * round to cents, and is equivalent when every candidate is scored against the
 * same P&I.
 *
 * The whole list is returned rather than only the winner because the CALLER has
 * a second question to ask of it: how many distinct accounts the qualifying
 * series span, which is what decides whether the paying account can be inferred
 * at all (ADR-047 §8).
 */
function qualifyingSeries(
  series: readonly PaymentSeries[],
  scheduled: Money,
  claimed: ReadonlySet<string>,
): PaymentSeries[] {
  const floor = scheduled.mul(PAYMENT_FLOOR_MULTIPLE);
  const ceiling = scheduled.mul(PAYMENT_CEILING_MULTIPLE);

  return series
    .filter(
      (candidate) =>
        !claimed.has(candidate.key) &&
        candidate.median.compare(floor) >= 0 &&
        candidate.median.compare(ceiling) <= 0,
    )
    .sort((a, b) => {
      const byDistance = a.median.sub(scheduled).abs().compare(b.median.sub(scheduled).abs());
      return byDistance !== 0 ? byDistance : a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
    });
}

/**
 * Whether the loan's scheduled term has run out.
 *
 * A paid-off loan proposes nothing: the `liabilities` row is history the payoff
 * simulator still reads, but the calendar must not date a payment that will
 * never leave. Overpayment is deliberately not modelled here — the app holds no
 * payoff date, and guessing one would silence a schedule the household is still
 * paying.
 */
function isPaidOff(liability: LiabilityTerms, today: string): boolean {
  return monthsElapsed(liability.startDate, today) >= liability.termMonths;
}

/** Whole months from `start` to `today`, floored, never negative. */
function monthsElapsed(start: string, today: string): number {
  const from = new Date(parseIsoDate(start, "startDate"));
  const to = new Date(parseIsoDate(today, "today"));
  let months =
    (to.getUTCFullYear() - from.getUTCFullYear()) * 12 + (to.getUTCMonth() - from.getUTCMonth());
  // A payment due on the 15th has not been made on the 3rd of the next month.
  if (to.getUTCDate() < from.getUTCDate()) months -= 1;
  return months < 0 ? 0 : months;
}
