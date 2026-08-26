import type { ObligationOccurrenceStatus } from "@/db/schema/obligation-occurrences.ts";
import type {
  ObligationAmountMode,
  ObligationDirection,
} from "@/db/schema/scheduled-obligations.ts";
import { Money } from "@/lib/money/money.ts";
import { parseIsoDate } from "@/lib/schedule/occurrences.ts";

/**
 * Occurrence matching — reconciling the calendar against what actually posted
 * (P16-22, ADR-037 §6).
 *
 * Pure and I/O-free. The caller reads the rows, this decides, the caller writes.
 *
 * ── This is a DATA CONTRACT, not a convenience ─────────────────────────────
 * Matched occurrences are what makes the residual subtraction EXACT (ADR-038
 * §2). The residual rate is `(observed expense − expense attributable to
 * confirmed obligations) ÷ days`, and "attributable" means *matched*. So:
 *
 *   - A **missed** match leaves a real bill inside observed spend with nothing
 *     subtracting it, and the flat run-rate charges the household for it a
 *     second time. That is the double-count the entire phase exists to prevent.
 *   - A **wrong** match attributes spending that never happened, over-subtracts,
 *     and pushes the residual toward zero — which INFLATES safe-to-spend. That
 *     is the dangerous direction (ADR-038 §5).
 *
 * Both errors move a number a family makes a spending decision on, which is why
 * the expectations live in [match.test.ts](./match.test.ts) as executable cases
 * organised by quality dimension rather than as prose here
 * (`data-quality-frameworks`).
 *
 * ── The three outcomes, and why "pending" is one of them ───────────────────
 * A scheduled occurrence resolves to exactly one of `matched`, `missed`, or
 * `pending`. `pending` is not a non-answer: it is "the window is still open, ask
 * again tomorrow". Collapsing it into `missed` would alert the household that
 * the mortgage did not post on the morning it is due, which is the fastest way
 * to teach someone to ignore an alert.
 *
 * ── Terminal states are never re-decided ───────────────────────────────────
 * `matched`, `missed` and `skipped` occurrences are skipped entirely. A skip is
 * user intent (ADR-037) and must not be resurrected; a recorded match is a fact
 * with a timestamp and must not be silently repointed at a different
 * transaction when an import adds one. Only `scheduled` rows are decided here,
 * and the sweep is therefore idempotent: running it twice over the same data
 * decides the same rows the same way, then decides nothing.
 *
 * ── Two passes: certain evidence claims first ──────────────────────────────
 * A detected obligation carries a `detection_key` — the `payeeKey` of the series
 * that produced it — so its occurrences match on `(account, payee, window,
 * amount)`. A MANUAL obligation has no such key (that is exactly why the unique
 * index in ADR-037 §1 is partial), and nothing identifies its payee. Two bad
 * options and one acceptable one:
 *
 *   - Refuse to match it → every hand-entered bill reports as missed, and the
 *     household gets an alert a month for bills they paid.
 *   - Match it on `(account, direction, window, amount)` silently → weaker
 *     evidence wearing the same clothes as strong evidence.
 *   - Match it on those terms and SAY SO. `basis: 'amount'` travels with the
 *     match so the UI and the audit trail can show what it rested on.
 *
 * The third is what happens here, and keyed occurrences run in a FIRST pass so a
 * loose amount-only match can never steal a transaction its keyed sibling would
 * have claimed.
 *
 * ── One transaction, one occurrence ────────────────────────────────────────
 * A claimed transaction leaves the pool. Without that, a household with the same
 * bill entered twice would attribute one $2,150 payment twice, over-subtract,
 * and inflate safe-to-spend.
 *
 * ── Determinism ────────────────────────────────────────────────────────────
 * The pick among several candidates is total and documented: closest date, then
 * smallest amount difference, then transaction id. Occurrences are processed in
 * `(due date, id)` order and the outputs are sorted the same way, so the result
 * is byte-identical across runs and independent of row order. A matcher whose
 * answer depended on which rows Postgres returned first would make the residual
 * rate — and therefore safe-to-spend — change between two identical runs.
 *
 * Money discipline (CLAUDE.md §Money): every comparison goes through
 * {@link Money}. The only `number`s here are day counts.
 */

const CURRENCY = "USD";
const MS_PER_DAY = 86_400_000;

/** How far a real payment may sit from its schedule and still be the same event. */
export interface MatchTolerance {
  /** Days either side of the due date. */
  readonly days: number;
  /** Fractional amount tolerance for a `fixed` obligation, e.g. `"0.15"`. */
  readonly amountPct: string;
  /**
   * Absolute floor on the amount tolerance. Without it a percentage is
   * meaningless on small bills: 15% of a $9.99 subscription is $1.50, so a
   * routine price rise would read as a different charge and the subscription
   * would report missed every month after the increase.
   */
  readonly amountAbs: string;
  /**
   * Fractional tolerance for an `amount_mode='trailing_median'` obligation. A
   * utility bill priced from a trailing median moves with the season; the schema
   * models that explicitly, so the matcher honours it rather than reporting a
   * July electric bill as missed.
   */
  readonly variableAmountPct: string;
}

/**
 * The default tolerance.
 *
 * ±5 days covers a weekend plus a bank holiday, which is the realistic spread
 * between a due date and a posting date. 15% covers a routine rate change on a
 * fixed bill without admitting a different charge from the same merchant; 50%
 * covers a seasonal utility swing. These are stated numbers rather than tuned
 * ones — there is no real-world series to tune against yet, and they are a
 * parameter precisely so they can be moved when there is.
 */
export const DEFAULT_MATCH_TOLERANCE: MatchTolerance = {
  days: 5,
  amountPct: "0.15",
  amountAbs: "5.00",
  variableAmountPct: "0.50",
};

export interface MatchOptions {
  readonly tolerance: MatchTolerance;
  /**
   * `YYYY-MM-DD` the sweep is being run for. Explicit rather than read from the
   * clock: "past its window" is not decidable without a reference date, and a
   * function that read `Date.now()` would be neither reproducible nor testable
   * without fake timers. Same posture as `detectObligations(today)`.
   *
   * This is why the plan's third parameter (`tolerance`) is widened to an
   * options object — the deviation is deliberate and is the whole reason for it.
   */
  readonly today: string;
}

/** A materialized occurrence, joined to the few obligation columns matching needs. */
export interface MatchableOccurrence {
  readonly id: string;
  readonly obligationId: string;
  readonly accountId: string;
  /** The obligation's `detection_key`. `null` for a manual obligation. */
  readonly payeeKey: string | null;
  readonly dueDate: string;
  /** Positive magnitude — the sign lives in `direction`. */
  readonly expectedAmount: string;
  readonly direction: ObligationDirection;
  readonly amountMode: ObligationAmountMode;
  readonly status: ObligationOccurrenceStatus;
}

/** A posted transaction, as the matcher reads it. */
export interface MatchableTransaction {
  readonly id: string;
  readonly accountId: string;
  /** `payeeKey(name)` — the same normalization detection grouped by (ADR-036 §4). */
  readonly payeeKey: string;
  readonly postedAt: string;
  /** Signed amount, as stored. Negative is an outflow. */
  readonly amount: string;
}

/** What the match rested on. `'amount'` is the weaker evidence — see the header. */
export type MatchBasis = "payee" | "amount";

export interface OccurrenceMatch {
  readonly occurrenceId: string;
  readonly transactionId: string;
  /** The transaction's amount, signed as stored — copied to `matched_amount`. */
  readonly matchedAmount: string;
  /**
   * Actual magnitude minus expected magnitude. Positive always means "bigger
   * than expected", whichever way the money moved. This is what the
   * `obligation_amount_changed` alert reads (P16-28).
   */
  readonly amountDelta: string;
  /** Posted date minus due date, in whole days. Negative means it posted early. */
  readonly dayOffset: number;
  readonly basis: MatchBasis;
}

export interface OccurrenceMiss {
  readonly occurrenceId: string;
  readonly dueDate: string;
}

export interface MatchResult {
  readonly matched: readonly OccurrenceMatch[];
  readonly missed: readonly OccurrenceMiss[];
  /** Ids of occurrences whose window is still open. Left `scheduled`. */
  readonly pending: readonly string[];
}

/** A candidate transaction with the distances that rank it. */
interface Candidate {
  readonly transaction: MatchableTransaction;
  readonly dayOffset: number;
  readonly absDays: number;
  readonly delta: Money;
  readonly absDelta: Money;
}

/**
 * Reconcile scheduled occurrences against posted transactions.
 *
 * @param occurrences - Materialized occurrences joined to their obligation.
 *   Non-`scheduled` rows are ignored (see the header on terminal states).
 * @param transactions - Posted transactions from the same accounts, over at
 *   least the window `[earliest due − tolerance.days, latest due + tolerance.days]`.
 * @param options - Tolerance and the reference date.
 * @returns The three outcome lists, each in `(due date, id)` order. Inputs are
 *   never mutated.
 * @throws If the tolerance is negative or a date is not a real `YYYY-MM-DD`. A
 *   negative tolerance would match nothing and report every bill missed, which
 *   is indistinguishable from a household that stopped paying.
 */
export function matchOccurrences(
  occurrences: readonly MatchableOccurrence[],
  transactions: readonly MatchableTransaction[],
  options: MatchOptions,
): MatchResult {
  assertTolerance(options.tolerance);
  const todayMs = parseIsoDate(options.today, "today");

  // Sort once; both passes and all three outputs inherit this order.
  const scheduled = occurrences
    .filter((o) => o.status === "scheduled")
    .sort((a, b) =>
      a.dueDate !== b.dueDate
        ? a.dueDate < b.dueDate
          ? -1
          : 1
        : a.id < b.id
          ? -1
          : a.id > b.id
            ? 1
            : 0,
    );

  const claimed = new Set<string>();
  const matched: OccurrenceMatch[] = [];
  const undecided: MatchableOccurrence[] = [];

  // Pass 1: payee-keyed occurrences. Pass 2: manual ones, on amount alone.
  for (const pass of ["payee", "amount"] as const) {
    for (const occurrence of scheduled) {
      if (matched.some((m) => m.occurrenceId === occurrence.id)) continue;
      const basis: MatchBasis = occurrence.payeeKey === null ? "amount" : "payee";
      if (basis !== pass) continue;

      const best = bestCandidate(occurrence, transactions, options.tolerance, claimed);
      if (best === undefined) {
        undecided.push(occurrence);
        continue;
      }
      claimed.add(best.transaction.id);
      matched.push({
        occurrenceId: occurrence.id,
        transactionId: best.transaction.id,
        matchedAmount: Money.fromString(best.transaction.amount, CURRENCY).toString(),
        amountDelta: best.delta.toString(),
        dayOffset: best.dayOffset,
        basis,
      });
    }
  }

  const missed: OccurrenceMiss[] = [];
  const pending: string[] = [];
  for (const occurrence of undecided) {
    // The window closes at `due + tolerance.days`, INCLUSIVE — on its last day
    // the payment can still post, so `missed` needs `today` strictly past it.
    const windowEndMs =
      parseIsoDate(occurrence.dueDate, "dueDate") + options.tolerance.days * MS_PER_DAY;
    if (todayMs > windowEndMs) {
      missed.push({ occurrenceId: occurrence.id, dueDate: occurrence.dueDate });
    } else {
      pending.push(occurrence.id);
    }
  }

  // Restore the `(due date, id)` order the two passes broke.
  const rank = new Map(scheduled.map((o, index) => [o.id, index]));
  const byRank = (a: string, b: string): number => (rank.get(a) ?? 0) - (rank.get(b) ?? 0);

  return {
    matched: matched.sort((a, b) => byRank(a.occurrenceId, b.occurrenceId)),
    missed: missed.sort((a, b) => byRank(a.occurrenceId, b.occurrenceId)),
    pending: pending.sort(byRank),
  };
}

/**
 * The best unclaimed transaction for one occurrence, or `undefined`.
 *
 * The ranking is total: closest date, then smallest amount difference, then
 * transaction id. See the header on why it has to be.
 */
function bestCandidate(
  occurrence: MatchableOccurrence,
  transactions: readonly MatchableTransaction[],
  tolerance: MatchTolerance,
  claimed: ReadonlySet<string>,
): Candidate | undefined {
  const dueMs = parseIsoDate(occurrence.dueDate, "dueDate");
  const expected = Money.fromString(occurrence.expectedAmount, CURRENCY).abs();
  const allowance = amountAllowance(expected, occurrence.amountMode, tolerance);

  let best: Candidate | undefined;

  for (const transaction of transactions) {
    if (claimed.has(transaction.id)) continue;
    if (transaction.accountId !== occurrence.accountId) continue;
    if (occurrence.payeeKey !== null && transaction.payeeKey !== occurrence.payeeKey) continue;

    const amount = Money.fromString(transaction.amount, CURRENCY);
    // A payment can never satisfy a receipt: matching across directions would
    // invert the sign of a projected event.
    const direction: ObligationDirection = amount.isNegative() ? "outflow" : "inflow";
    if (direction !== occurrence.direction) continue;

    const dayOffset = Math.round(
      (parseIsoDate(transaction.postedAt, "postedAt") - dueMs) / MS_PER_DAY,
    );
    const absDays = Math.abs(dayOffset);
    if (absDays > tolerance.days) continue;

    const delta = amount.abs().sub(expected);
    const absDelta = delta.abs();
    if (absDelta.compare(allowance) > 0) continue;

    const candidate: Candidate = { transaction, dayOffset, absDays, delta, absDelta };
    if (best === undefined || ranksBefore(candidate, best)) best = candidate;
  }

  return best;
}

/** The documented total order over candidates: date, then amount, then id. */
function ranksBefore(a: Candidate, b: Candidate): boolean {
  if (a.absDays !== b.absDays) return a.absDays < b.absDays;
  const byAmount = a.absDelta.compare(b.absDelta);
  if (byAmount !== 0) return byAmount < 0;
  return a.transaction.id < b.transaction.id;
}

/** `max(absolute floor, magnitude × the mode's percentage)`. */
function amountAllowance(
  expected: Money,
  amountMode: ObligationAmountMode,
  tolerance: MatchTolerance,
): Money {
  const pct = amountMode === "trailing_median" ? tolerance.variableAmountPct : tolerance.amountPct;
  const proportional = expected.mul(pct);
  const floor = Money.fromString(tolerance.amountAbs, CURRENCY);
  return proportional.compare(floor) > 0 ? proportional : floor;
}

function assertTolerance(tolerance: MatchTolerance): void {
  if (!Number.isInteger(tolerance.days) || tolerance.days < 0) {
    throw new Error(
      `matchOccurrences: tolerance.days must be a non-negative whole number of days, got ${tolerance.days}`,
    );
  }
  for (const [field, value] of [
    ["amountPct", tolerance.amountPct],
    ["amountAbs", tolerance.amountAbs],
    ["variableAmountPct", tolerance.variableAmountPct],
  ] as const) {
    if (Money.fromString(value, CURRENCY).isNegative()) {
      throw new Error(`matchOccurrences: tolerance.${field} cannot be negative`);
    }
  }
}
