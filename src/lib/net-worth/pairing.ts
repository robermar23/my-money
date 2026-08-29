import { Money } from "@/lib/money/money.ts";
import { parseIsoDate } from "@/lib/schedule/occurrences.ts";
import type { FlowTxn, PairedTransfer } from "./flow-types.ts";

/**
 * Transfer pairing — establishing which `kind='transfer'` rows actually stayed
 * inside the household (P17-04, ADR-040 §2).
 *
 * Pure and I/O-free. Structurally the same problem
 * [cashflow/match.ts](../cashflow/match.ts) solved for occurrences — match a
 * row against candidates inside a date window and an amount tolerance, one
 * claim per row, deterministic pick — and the implementation deliberately
 * follows its shape rather than inventing a second vocabulary for the same job.
 *
 * ── What a pair asserts ────────────────────────────────────────────────────
 * That two rows are the two legs of ONE move between two accounts this app
 * tracks. The evidence is structural: opposite signs, another account, equal
 * magnitude within tolerance, inside a ±N-day window. Nothing is inferred from
 * the descriptor text — a substring like "XFER TO SAVINGS" is not checkable,
 * and ADR-040 rejected it for the same reason ADR-036 §2 rejected payee-text
 * inference for obligations.
 *
 * ── Both failure modes move money between rungs ────────────────────────────
 * A **missed** pair reports an internal move as money leaving the household:
 * `saved` falls by the full amount and `unexplained` absorbs it. A **wrong**
 * pair reports a real external payment as internal, so `saved` never sees money
 * the household actually sent away — the flattering direction, and therefore
 * the dangerous one. Neither changes `delta`, which is why the tests assert the
 * pairs themselves rather than any downstream total.
 *
 * ── Determinism ────────────────────────────────────────────────────────────
 * The pick among several candidates is total and documented: nearest date, then
 * smallest amount difference, then lowest id. Outflow legs are processed in
 * `(postedAt, id)` order and the outputs are sorted the same way, so the result
 * is byte-identical across runs and independent of the order Postgres returned
 * the rows in. A pairer whose answer depended on row order would make a
 * household's `saved` figure change between two identical page loads.
 *
 * Money discipline (CLAUDE.md §Money): every comparison goes through
 * {@link Money}. The only `number`s here are day counts.
 */

const CURRENCY = "USD";
const MS_PER_DAY = 86_400_000;

/** How far apart two legs of one move may sit and still be the same move. */
export interface PairingOptions {
  /** Days either side. A leg may post before or after its counterparty. */
  readonly windowDays: number;
  /** Absolute magnitude tolerance, e.g. `"0.01"`. Deliberately tiny — see below. */
  readonly amountAbs: string;
}

/**
 * The default tolerance. Stated constants with a rationale, per ADR-040
 * consequence 2 — **not values tuned until the residual looked small**. Tuning
 * a tolerance to shrink a residual is fitting the measurement to the answer,
 * and it would quietly convert real external payments into internal moves.
 *
 * `windowDays: 5` — the same figure as `DEFAULT_MATCH_TOLERANCE.days`, for the
 * same reason: standard ACH settles in one to three business days, and a
 * transfer initiated on a Friday can land the following Wednesday. A tighter
 * window would report ordinary between-institution moves as money that left the
 * household.
 *
 * `amountAbs: "0.01"` — a single cent, which absorbs an importer reporting one
 * leg as `100.00` against the other's `99.99` and NOTHING ELSE. It is
 * deliberately too small to absorb a wire fee or an FX spread, because those
 * are real money that really left, and pairing them away would hide a genuine
 * outflow inside an "internal" verdict. ADR-040 accepts the resulting false
 * negative — a fee'd wire stays unpaired and shows up in the unpaired-transfer
 * diagnostic, which is a visible, investigable outcome rather than a silent
 * misattribution.
 */
export const DEFAULT_PAIRING: PairingOptions = {
  windowDays: 5,
  amountAbs: "0.01",
};

export interface PairingResult {
  /** Established internal moves, in `(outflow postedAt, outflow id)` order. */
  readonly pairs: readonly PairedTransfer[];
  /**
   * Transfer rows with no counterparty, ascending by id.
   *
   * These are **not** guessed either way (ADR-040 §3). They are excluded from
   * `saved` and reported by volume as *"transfers to accounts this app doesn't
   * track"* — never as "unexplained", which would teach the user nothing.
   *
   * Rows that are not transfers never appear here. A household's ordinary
   * spending is not an unpaired transfer, and counting it as one would swamp
   * the diagnostic with noise.
   */
  readonly unpairedIds: readonly string[];
}

/** A candidate inflow leg with the distances that rank it. */
interface Candidate {
  readonly txn: FlowTxn;
  readonly dayGap: number;
  readonly absDelta: Money;
}

/**
 * Pair transfer legs against their counterparties in other tracked accounts.
 *
 * @param txns - Every transaction in the window, from every tracked account.
 *   Non-transfer rows are ignored entirely and never reported as unpaired.
 * @param options - Window and amount tolerance. Defaults to
 *   {@link DEFAULT_PAIRING}.
 * @returns The established pairs and the ids of transfer rows left over. Inputs
 *   are never mutated.
 * @throws If `windowDays` or `amountAbs` is negative. A negative tolerance
 *   pairs nothing, which would report every internal move as money leaving the
 *   household — indistinguishable from a family that emptied its accounts, and
 *   far too quiet a failure to allow.
 */
export function pairTransfers(
  txns: readonly FlowTxn[],
  options: PairingOptions = DEFAULT_PAIRING,
): PairingResult {
  assertOptions(options);

  const transfers = txns.filter((t) => t.categoryKind === "transfer").sort(byDateThenId);
  const outflows = transfers.filter((t) => Money.fromString(t.amount, CURRENCY).isNegative());
  const inflows = transfers.filter((t) => !Money.fromString(t.amount, CURRENCY).isNegative());

  const claimed = new Set<string>();
  const pairs: PairedTransfer[] = [];

  for (const outflow of outflows) {
    const best = bestCounterparty(outflow, inflows, options, claimed);
    if (best === undefined) continue;
    claimed.add(best.txn.id);
    pairs.push({
      fromId: outflow.id,
      toId: best.txn.id,
      amount: Money.fromString(outflow.amount, CURRENCY).abs().toString(),
      dayGap: best.dayGap,
    });
  }

  const pairedIds = new Set<string>();
  for (const pair of pairs) {
    pairedIds.add(pair.fromId);
    pairedIds.add(pair.toId);
  }

  return {
    pairs,
    unpairedIds: transfers
      .filter((t) => !pairedIds.has(t.id))
      .map((t) => t.id)
      .sort(compareStrings),
  };
}

/**
 * The best unclaimed inflow leg for one outflow leg, or `undefined`.
 *
 * The ranking is total: nearest date, then smallest amount difference, then
 * lowest id. See the header on why it has to be.
 */
function bestCounterparty(
  outflow: FlowTxn,
  inflows: readonly FlowTxn[],
  options: PairingOptions,
  claimed: ReadonlySet<string>,
): Candidate | undefined {
  const outMs = parseIsoDate(outflow.postedAt, "postedAt");
  const magnitude = Money.fromString(outflow.amount, CURRENCY).abs();
  const allowance = Money.fromString(options.amountAbs, CURRENCY);

  let best: Candidate | undefined;

  for (const inflow of inflows) {
    if (claimed.has(inflow.id)) continue;
    // The counterparty has to be somewhere ELSE. Two rows in one account are
    // not a move between accounts, and pairing them would erase a real outflow
    // and a real inflow from `saved` in a single step.
    if (inflow.accountId === outflow.accountId) continue;

    const gapMs = Math.abs(parseIsoDate(inflow.postedAt, "postedAt") - outMs);
    const dayGap = Math.round(gapMs / MS_PER_DAY);
    if (dayGap > options.windowDays) continue;

    const absDelta = Money.fromString(inflow.amount, CURRENCY).abs().sub(magnitude).abs();
    if (absDelta.compare(allowance) > 0) continue;

    const candidate: Candidate = { txn: inflow, dayGap, absDelta };
    if (best === undefined || ranksBetter(candidate, best)) best = candidate;
  }

  return best;
}

/** Nearest date, then smallest amount difference, then lowest id. Total. */
function ranksBetter(candidate: Candidate, incumbent: Candidate): boolean {
  if (candidate.dayGap !== incumbent.dayGap) return candidate.dayGap < incumbent.dayGap;
  const byAmount = candidate.absDelta.compare(incumbent.absDelta);
  if (byAmount !== 0) return byAmount < 0;
  return candidate.txn.id < incumbent.txn.id;
}

function byDateThenId(a: FlowTxn, b: FlowTxn): number {
  if (a.postedAt !== b.postedAt) return a.postedAt < b.postedAt ? -1 : 1;
  return compareStrings(a.id, b.id);
}

function compareStrings(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function assertOptions(options: PairingOptions): void {
  if (!Number.isFinite(options.windowDays) || options.windowDays < 0) {
    throw new Error(`pairTransfers: windowDays must be >= 0, got ${options.windowDays}`);
  }
  if (Money.fromString(options.amountAbs, CURRENCY).isNegative()) {
    throw new Error(`pairTransfers: amountAbs must be >= 0, got ${options.amountAbs}`);
  }
}
