import type { CategoryKind } from "@/db/schema/categories.ts";
import type {
  ObligationAmountMode,
  ObligationConfidence,
  ObligationDirection,
} from "@/db/schema/scheduled-obligations.ts";
import { Money } from "@/lib/money/money.ts";
import type { ObligationCadence } from "@/lib/schedule/cadence.ts";
import { parseIsoDate } from "@/lib/schedule/occurrences.ts";
import { amountStability } from "./amount-stability.ts";
import { payeeKey } from "./payee-key.ts";
import { detectPeriodicity, nominalGapDays } from "./periodicity.ts";

/**
 * detectObligations: propose recurring bills and receipts from transaction
 * history (P16-11, ADR-036 §2/§4).
 *
 * Pure and I/O-free — it reads the rows it is handed and nothing else. That is
 * not incidental: this is the function whose output the user is asked to
 * confirm, and a proposal that depended on ambient state (a clock, a database,
 * a network lookup) could not be reproduced when the user asked why it was
 * proposed. `today` is an explicit input for the same reason.
 *
 * ── It proposes; it never commits ──────────────────────────────────────────
 * Nothing here writes anything. A candidate is a GUESS with its evidence
 * attached — the occurrences it was derived from, the spread of their amounts,
 * a confidence grade — and it becomes a `scheduled_obligation` only when the
 * user clicks confirm (ADR-036 §2). A detected series that entered the
 * projection unconfirmed would move a number the household makes a spending
 * decision on, on the strength of a heuristic.
 *
 * ── The composition ────────────────────────────────────────────────────────
 * Group by `(accountId, payeeKey, direction)`, then ask three separate
 * questions of each group:
 *
 *   - [payee-key.ts](./payee-key.ts) — is this the same merchant? (The same
 *     notion of "same" the categorization engine uses; there is only one.)
 *   - [periodicity.ts](./periodicity.ts) — do the dates have a rhythm?
 *   - [amount-stability.ts](./amount-stability.ts) — is the amount fixed?
 *
 * `direction` is part of the grouping key rather than something derived at the
 * end. A payee that runs both ways — Venmo, a P2P app, an employer who also
 * takes a deduction — is two series, and averaging them would describe a bill
 * that nets to nothing. It also guarantees `amountStability` never sees mixed
 * signs, which it refuses outright.
 *
 * ── What is deliberately excluded ──────────────────────────────────────────
 *   - **`kind='transfer'` categories.** A card payment or a savings sweep is
 *     the same money seen twice. Proposing it would double-count it in the
 *     projection, and treating both legs as real is the first step toward the
 *     double-entry ledger this app explicitly is not (CLAUDE.md §Domain Scope;
 *     `kind` exists for exactly this).
 *   - **Series that have stopped.** A membership cancelled three months ago is
 *     still a perfectly detectable monthly series; projecting it forward would
 *     invent an outflow the household will never see. A candidate is suppressed
 *     once its last occurrence is more than `stalePeriods` nominal periods old,
 *     measured against the same periods the detector matched on. One period
 *     late is NOT stale — that is the case the miss alert exists for.
 *
 * ── Privacy ────────────────────────────────────────────────────────────────
 * Every string here names a real vendor, and in the P2P cases a real person.
 * There is no enrichment step, no biller directory, no merchant lookup, and no
 * outbound call of any kind — by construction, since this module is pure. That
 * property is asserted by the Batch-8 egress test (P16-36), and it is the
 * reason detection is a local heuristic rather than a service.
 */

/** Category kinds excluded from detection outright. See the header. */
const EXCLUDED_CATEGORY_KINDS: ReadonlySet<CategoryKind> = new Set(["transfer"]);

/** Nominal periods of silence after which a series counts as stopped. */
const DEFAULT_STALE_PERIODS = 2;

const MS_PER_DAY = 86_400_000;

/**
 * One transaction, reduced to what detection actually reads.
 *
 * Deliberately not the Drizzle row type: this module is pure, and typing it
 * against the table would drag schema code into a function that must stay
 * trivially testable. The loader (P16-30) maps rows onto this.
 */
export interface DetectionTransaction {
  readonly id: string;
  readonly accountId: string;
  /** `YYYY-MM-DD` posted date. */
  readonly postedAt: string;
  /** Signed amount, as stored — the sign decides `direction`. */
  readonly amount: string;
  /** Raw bank description. */
  readonly name: string;
  readonly categoryId: string | null;
  /** The resolved category's kind, or null when uncategorized. */
  readonly categoryKind: CategoryKind | null;
}

/** One transaction that supports a candidate, kept as its evidence. */
export interface CandidateOccurrence {
  /** `YYYY-MM-DD`. */
  readonly date: string;
  /** The signed amount as it posted, not the magnitude. */
  readonly amount: string;
  readonly transactionId: string;
}

/** A proposed obligation, awaiting the user's confirmation. */
export interface ObligationCandidate {
  readonly accountId: string;
  /** The grouping key, and the value that becomes `detection_key` on confirm. */
  readonly payeeKey: string;
  /** A raw description to show beside the label, so the user recognizes it. */
  readonly sampleName: string;
  /** A suggested, editable label. */
  readonly label: string;
  readonly direction: ObligationDirection;
  /** The majority category of the occurrences, or null when uncategorized. */
  readonly categoryId: string | null;
  readonly cadence: ObligationCadence;
  readonly anchorDate: string;
  /** A positive magnitude — the sign lives in `direction`. */
  readonly expectedAmount: string;
  /** Median absolute deviation of the observed amounts, for the review UI. */
  readonly amountSpread: string;
  readonly amountMode: ObligationAmountMode;
  /** How well the DATES corroborate the schedule — see the note below. */
  readonly confidence: ObligationConfidence;
  /** The evidence, ascending by date. */
  readonly occurrences: readonly CandidateOccurrence[];
  /** `YYYY-MM-DD` of the first and last occurrence seen. */
  readonly firstSeen: string;
  readonly lastSeen: string;
}

export interface DetectOptions {
  /**
   * `YYYY-MM-DD` the detection is being run for. Explicit rather than read from
   * the clock, so a run is reproducible and so tests need no fake timers.
   */
  readonly today: string;
  /** Currency the amounts are denominated in. Defaults to USD. */
  readonly currency?: string;
  /** Nominal periods of silence before a series is treated as stopped. */
  readonly stalePeriods?: number;
}

/** Working set for one `(account, payee, direction)` group. */
interface Group {
  readonly accountId: string;
  readonly payeeKey: string;
  readonly direction: ObligationDirection;
  readonly transactions: DetectionTransaction[];
}

/** Rank used to order candidates; the most credible proposals come first. */
const CONFIDENCE_RANK: Record<ObligationConfidence, number> = { high: 0, medium: 1, low: 2 };

/** Title-case a normalized payee key into a suggested label. */
function toLabel(key: string): string {
  return key
    .split(" ")
    .filter((word) => word.length > 0)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/** The most frequent value in a list, ties broken by first appearance. */
function majority<T>(values: readonly T[]): T | null {
  const counts = new Map<T, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  let best: T | null = null;
  let bestCount = 0;
  for (const [value, count] of counts) {
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

/** Whole days from `from` to `to`, both `YYYY-MM-DD`. Negative when `to` is earlier. */
function daysBetween(from: string, to: string): number {
  return (parseIsoDate(to, "today") - parseIsoDate(from, "occurrence date")) / MS_PER_DAY;
}

/**
 * Bucket transactions into `(account, payee, direction)` groups, dropping the
 * kinds that are excluded outright.
 */
function groupTransactions(
  transactions: readonly DetectionTransaction[],
  currency: string,
): Group[] {
  const groups = new Map<string, Group>();
  for (const transaction of transactions) {
    if (
      transaction.categoryKind !== null &&
      EXCLUDED_CATEGORY_KINDS.has(transaction.categoryKind)
    ) {
      continue;
    }
    const key = payeeKey(transaction.name);
    // Sign and zero-ness through Money, not through `Number` or a string
    // prefix: "-0.00" is a real value a bank feed emits, and it belongs to
    // neither direction (CLAUDE.md §Money — no native math on money values).
    const amount = Money.fromString(transaction.amount, currency);
    if (amount.isZero()) continue;
    const direction: ObligationDirection = amount.isNegative() ? "outflow" : "inflow";
    const groupKey = `${transaction.accountId} ${key} ${direction}`;
    const existing = groups.get(groupKey);
    if (existing) {
      existing.transactions.push(transaction);
    } else {
      groups.set(groupKey, {
        accountId: transaction.accountId,
        payeeKey: key,
        direction,
        transactions: [transaction],
      });
    }
  }
  return [...groups.values()];
}

/**
 * Turn one group into a candidate, or `null` when it is not a series.
 *
 * Confidence here grades the SCHEDULE, not the amount. The two are reported
 * separately on purpose: a seasonal utility bill can arrive on a perfectly
 * reliable date while its amount swings 40%, and collapsing both facts into one
 * grade would hide exactly the distinction the review page needs to show.
 * Amount variability is carried by `amountMode` and `amountSpread`.
 */
function candidateFrom(group: Group, options: DetectOptions): ObligationCandidate | null {
  const occurrences: CandidateOccurrence[] = group.transactions
    .map((transaction) => ({
      date: transaction.postedAt,
      amount: transaction.amount,
      transactionId: transaction.id,
    }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const periodicity = detectPeriodicity(occurrences.map((occurrence) => occurrence.date));
  if (!periodicity) return null;

  const lastSeen = occurrences[occurrences.length - 1]?.date as string;
  const stalePeriods = options.stalePeriods ?? DEFAULT_STALE_PERIODS;
  if (daysBetween(lastSeen, options.today) > stalePeriods * nominalGapDays(periodicity.cadence)) {
    return null;
  }

  const stability = amountStability(
    occurrences.map((occurrence) => occurrence.amount),
    options.currency ?? "USD",
  );

  return {
    accountId: group.accountId,
    payeeKey: group.payeeKey,
    sampleName: majority(group.transactions.map((transaction) => transaction.name)) ?? "",
    label: toLabel(group.payeeKey),
    direction: group.direction,
    categoryId: majority(
      group.transactions
        .map((transaction) => transaction.categoryId)
        .filter((categoryId): categoryId is string => categoryId !== null),
    ),
    cadence: periodicity.cadence,
    anchorDate: periodicity.anchorDate,
    expectedAmount: stability.median,
    amountSpread: stability.spread,
    amountMode: stability.mode,
    confidence: periodicity.confidence,
    occurrences,
    firstSeen: occurrences[0]?.date as string,
    lastSeen,
  };
}

/**
 * Propose recurring obligations from transaction history.
 *
 * @param transactions - The rows to consider, in any order. Not mutated.
 * @param options - `today` (required, injected rather than read from the
 *   clock), the currency, and the staleness window.
 * @returns Candidates ordered most-credible first: by confidence, then by
 *   expected amount descending, then by payee — a total order, so the review
 *   page renders the same list every time it is loaded.
 * @throws If any `postedAt` is not a real `YYYY-MM-DD` date, or if a group's
 *   amounts are unparseable. Both are loader bugs and should be loud.
 */
export function detectObligations(
  transactions: readonly DetectionTransaction[],
  options: DetectOptions,
): ObligationCandidate[] {
  const currency = options.currency ?? "USD";
  const candidates: ObligationCandidate[] = [];
  for (const group of groupTransactions(transactions, currency)) {
    const candidate = candidateFrom(group, options);
    if (candidate) candidates.push(candidate);
  }

  return candidates.sort((a, b) => {
    const byConfidence = CONFIDENCE_RANK[a.confidence] - CONFIDENCE_RANK[b.confidence];
    if (byConfidence !== 0) return byConfidence;
    // Bigger commitments first — a $2,000 mortgage matters more to the
    // projection than a $9 subscription. Ordered through `Money.compare`, which
    // goes via Decimal, so two amounts a float would tie never tie here.
    const byAmount = Money.fromString(b.expectedAmount, currency).compare(
      Money.fromString(a.expectedAmount, currency),
    );
    if (byAmount !== 0) return byAmount;
    if (a.payeeKey !== b.payeeKey) return a.payeeKey < b.payeeKey ? -1 : 1;
    if (a.accountId !== b.accountId) return a.accountId < b.accountId ? -1 : 1;
    return a.direction < b.direction ? -1 : a.direction > b.direction ? 1 : 0;
  });
}
