import type { FlowTxn } from "./flow-types.ts";

/**
 * The household boundary (P17-03, ADR-040).
 *
 * One question, asked of one transaction: **did this money cross the boundary
 * of the household?** Not "was it discretionary", not "was it planned income" —
 * only whether net worth could have moved. Pure and I/O-free; every read lives
 * in the loader (P17-19).
 *
 * ── Why `categories.kind` alone is not enough (ADR-040 §1) ──────────────────
 * `kind ∈ {income, expense, transfer}` (ADR-018) already keeps card payments
 * and internal moves out of spend totals, and it is tempting to stop there. But
 * `kind='transfer'` covers three materially different events:
 *
 *   1. a move between two accounts this app tracks — genuinely internal, and it
 *      nets to zero in net worth;
 *   2. a move to an account this app does NOT track — genuinely external, and
 *      net worth really fell;
 *   3. a person-to-person payment — also external.
 *
 * Treating all three as internal understates outflows. Treating all three as
 * external double-counts every card payment. Neither is acceptable, and no
 * amount of care applied to `kind` can tell them apart, because `kind` states
 * the user's *intent* and the difference here is about *what happened*.
 *
 * So the verdict for a transfer is not read off the row at all: it is decided
 * by whether {@link pairTransfers} found the counterparty leg in another
 * tracked account. `pairedIds` is that answer, computed once by the caller and
 * passed in. The same row, unchanged, classifies as `'internal'` or
 * `'unpaired_transfer'` depending on it.
 *
 * ── `excluded_from_baseline` is deliberately NOT applied (ADR-040 §4) ───────
 * ADR-034 §1 excludes flagged income categories — "Reimbursements", "Refunds" —
 * from *take-home*, because take-home answers "what can this household plan
 * against" and a reimbursement is not recurring.
 *
 * Attribution asks a different question, and gets the opposite answer: a
 * reimbursement is real money that really arrived and really moved net worth.
 * Excluding it here would manufacture a residual out of money the household
 * actually received, and send the user hunting for a data problem that does not
 * exist.
 *
 * **This is a deliberate divergence, not an oversight, and the two must not be
 * "fixed" to match each other.** Consistency between two different questions is
 * not a virtue. The guarantee is structural: {@link FlowTxn} carries no
 * `excludedFromBaseline` field, so this layer cannot read the flag even by
 * accident, and a compile-time guard in `boundary.test.ts` fails if one is ever
 * added. Also stated in `docs/ATTRIBUTION.md` for a reader who arrives from the
 * advice engine.
 *
 * ── A `NULL` category is reported, never assumed (ADR-040 §5) ───────────────
 * An uncategorized row gets its own verdict and contributes to no rung. It is
 * not guessed into `expense` on the strength of a negative sign, because a
 * guess here silently moves real money into a rung the user would then read as
 * measured. Its volume is reported instead (P17-05) and surfaces as a named
 * residual contributor with somewhere to go and fix it (P17-16) — the same
 * posture `spendingSummary` already takes.
 */

/**
 * Which side of the household boundary a row sits on.
 *
 * Three of the five are "this did not cross the boundary", kept apart because
 * they mean different things to the user: `'internal'` is *known* not to have
 * crossed, `'unpaired_transfer'` is *unknown* and worth investigating, and
 * `'uncategorized'` is *unclassified* and worth fixing. Collapsing them into
 * one "excluded" bucket would throw away the only information that makes the
 * residual actionable.
 */
export type FlowVerdict = "inflow" | "outflow" | "internal" | "unpaired_transfer" | "uncategorized";

/** A row paired with its verdict, ready for {@link savedFromFlows}. */
export interface ClassifiedFlow {
  readonly txn: FlowTxn;
  readonly verdict: FlowVerdict;
}

/**
 * Decide which side of the household boundary one transaction sits on.
 *
 * The verdict is about the row's *side*, never its sign. A refund posted
 * against an expense category is still an `'outflow'` row; it is the signed
 * amount, read later by {@link savedFromFlows}, that nets it back out. Folding
 * sign into the verdict would classify a refund as income.
 *
 * @param txn - The transaction, with `categoryKind` joined in by the loader.
 * @param pairedIds - Ids of transfer legs {@link pairTransfers} matched to a
 *   counterparty in another tracked account. A transfer absent from this set is
 *   reported as unpaired, never guessed either way (ADR-040 §3).
 * @returns Exactly one {@link FlowVerdict}.
 */
export function classifyFlow(txn: FlowTxn, pairedIds: ReadonlySet<string>): FlowVerdict {
  if (txn.categoryKind === null) return "uncategorized";
  if (txn.categoryKind === "income") return "inflow";
  if (txn.categoryKind === "expense") return "outflow";
  return pairedIds.has(txn.id) ? "internal" : "unpaired_transfer";
}

/**
 * {@link classifyFlow} over a window's worth of rows.
 *
 * @param txns - Every transaction in the window, from every tracked account.
 * @param pairedIds - As {@link classifyFlow}.
 * @returns One {@link ClassifiedFlow} per input row, in input order. Nothing is
 *   dropped: a row that contributes to no rung still has to be counted, or the
 *   diagnostics cannot say how much went unclassified.
 */
export function classifyFlows(
  txns: readonly FlowTxn[],
  pairedIds: ReadonlySet<string>,
): ClassifiedFlow[] {
  return txns.map((txn) => ({ txn, verdict: classifyFlow(txn, pairedIds) }));
}
