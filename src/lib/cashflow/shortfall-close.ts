import { Money } from "@/lib/money/money.ts";

/**
 * classifyShortfall: what closes a projected shortfall, if anything does
 * (CF-B1, ADR-048).
 *
 * Pure and I/O-free. The caller reads the balances; this decides what sentence
 * the household should be shown.
 *
 * ── The defect this exists to fix ──────────────────────────────────────────
 * `/plan/cashflow` computed a shortfall, printed it in red, and closed with
 * static copy — *"Moving a bill, or moving money in before then, is what closes
 * it"* — that named the fix **without checking whether the household could
 * perform it**. That is the difference between advice and a slogan. For a family
 * with a funded emergency fund it over-alarms; for one without, the same red
 * number under-states a real solvency problem. One display serving two opposite
 * situations was the whole bug.
 *
 * ── The valuable output is the CLASSIFICATION, not the suggestion ──────────
 * A shortfall the reserve covers is a **timing** problem. One it does not cover
 * is a **solvency** problem. Those are different sentences, different next
 * actions, and — per CF-B4 — different alert severities. A union rather than a
 * boolean plus a nullable amount, because the four cases have four different
 * sentences and a boolean would let a caller render three of them wrong.
 *
 * ── What this deliberately does NOT do ─────────────────────────────────────
 * **It does not touch the projection.** No reserve balance enters the walk, the
 * low-water mark, or safe-to-spend, and ADR-038 §6 stands exactly as written: a
 * line that quietly absorbed savings could never tell a household it is
 * overspending — it would run flat until the savings ran out and then fall off a
 * cliff with no warning. This adds a **second sentence about the same number**,
 * never a second number.
 *
 * **It suggests no transfer.** `transferAmount` is a description of the gap, not
 * an instruction and not a button. Money movement is permanently out of scope
 * (CLAUDE.md §Domain Scope).
 *
 * **It states no emergency-fund target.** Whether what remains is still *enough*
 * is `/plan`'s question, answered there by `reserveMonthsFor()` against a full
 * `AdviceInput`. Two implementations of "how many months" is two numbers that
 * can disagree on one screen (ADR-048 §5).
 *
 * ── Unclassified cash is never counted ─────────────────────────────────────
 * ADR-033 §1's rule, restated here because this is precisely where someone would
 * be tempted to break it. An account with a `NULL` subtype might be a savings
 * account — and might be a CD, or a second checking account already inside the
 * projection. Counting it would let the app tell a household their shortfall is
 * covered by money that is either committed or already spent.
 *
 * Money discipline (CLAUDE.md §Money): every figure is a `numeric(18,2)` string
 * combined through {@link Money}. No value is ever converted with `Number(...)`,
 * `parseFloat` or `parseInt` — the only `Number` reference is `Number.isInteger`
 * validating an account count, and the only `number`s are those counts. CF-B2
 * asserts that by scanning this file's source, because a single float conversion
 * on the way to a comparison is how "your savings covers this" becomes wrong by
 * a cent in the direction that matters.
 */

const CURRENCY = "USD";

/** The balances the classification reads. Every one of them is a fact. */
export interface ShortfallCloseInput {
  /**
   * How far below the floor the projection dips, a positive magnitude — the
   * `shortfall` `safeToSpend` already computed. Never re-derived here.
   */
  readonly shortfall: string;
  /** Total across `savings` / `money_market` accounts (ADR-033 §1). */
  readonly reserveTotal: string;
  /** How many reserve accounts that total came from. Zero is meaningful. */
  readonly reserveAccountCount: number;
  /** Open cash accounts whose subtype is `NULL`, so their tier is unknown. */
  readonly unclassifiedCount: number;
}

/**
 * What would close the shortfall.
 *
 * Four members, four sentences:
 *
 *   - `covered` — a timing problem. Moving `transferAmount` in before the
 *     low-water date keeps the household above its floor, and
 *     `remainingAfterTransfer` still sits in reserve afterwards.
 *   - `partly_covered` — the reserve helps but does not finish the job.
 *     `stillShort` is what remains, and it is the number that matters.
 *   - `uncovered` — a solvency problem. The app knows where the cash is and
 *     there is not enough of it.
 *   - `reserve_unknown` — the app does not know where the cash sits, so it
 *     refuses to say. The fix is one screen away.
 */
export type ShortfallClose =
  | {
      readonly kind: "covered";
      readonly shortfall: string;
      readonly reserveTotal: string;
      /** Exactly the shortfall — enough to reach the floor, and no more. */
      readonly transferAmount: string;
      /** What is still in reserve afterwards. Non-negative. */
      readonly remainingAfterTransfer: string;
      readonly reserveAccountCount: number;
    }
  | {
      readonly kind: "partly_covered";
      readonly shortfall: string;
      readonly reserveTotal: string;
      /** The whole reserve — everything there is to move. */
      readonly transferAmount: string;
      /** Clamped at zero: moving the whole reserve leaves none of it. */
      readonly remainingAfterTransfer: string;
      /** `shortfall − reserveTotal`, a positive magnitude. */
      readonly stillShort: string;
      readonly reserveAccountCount: number;
    }
  | {
      readonly kind: "uncovered";
      readonly shortfall: string;
      readonly reserveTotal: string;
      readonly reserveAccountCount: number;
    }
  | {
      readonly kind: "reserve_unknown";
      readonly shortfall: string;
      readonly unclassifiedCount: number;
    };

/**
 * Decide what, if anything, closes the projected shortfall.
 *
 * @param input - The shortfall and the reserve behind it. Both money values are
 *   positive magnitudes.
 * @returns The classification, with only the figures its own sentence needs.
 * @throws If a money value is negative or a count is negative. A negative
 *   reserve is an upstream bug, and classifying nonsense would hide it behind a
 *   plausible screen — the same posture `projectionStatus` takes.
 */
export function classifyShortfall(input: ShortfallCloseInput): ShortfallClose {
  const shortfall = Money.fromString(input.shortfall, CURRENCY);
  const reserve = Money.fromString(input.reserveTotal, CURRENCY);

  if (shortfall.isNegative()) {
    throw new Error("classifyShortfall: shortfall is a positive magnitude");
  }
  if (reserve.isNegative()) {
    throw new Error("classifyShortfall: reserveTotal cannot be negative");
  }
  assertCount("reserveAccountCount", input.reserveAccountCount);
  assertCount("unclassifiedCount", input.unclassifiedCount);

  // Checked FIRST, and the order is the point. A household with no classified
  // reserve account but some un-triaged cash has not been told "you have no
  // savings" — it has been told "we do not know", which is a different and
  // honest answer with a different fix (ADR-033 §1, ADR-038 §7).
  if (input.reserveAccountCount === 0 && input.unclassifiedCount > 0) {
    return {
      kind: "reserve_unknown",
      shortfall: shortfall.toString(),
      unclassifiedCount: input.unclassifiedCount,
    };
  }

  // Landing exactly ON the shortfall is covered, not partly — the same
  // boundary safe-to-spend draws when the projection lands exactly on the
  // floor, and drawn the same way so the two surfaces cannot disagree about a
  // household sitting on the line.
  if (reserve.compare(shortfall) >= 0) {
    return {
      kind: "covered",
      shortfall: shortfall.toString(),
      reserveTotal: reserve.toString(),
      transferAmount: shortfall.toString(),
      remainingAfterTransfer: reserve.sub(shortfall).toString(),
      reserveAccountCount: input.reserveAccountCount,
    };
  }

  if (reserve.isZero()) {
    return {
      kind: "uncovered",
      shortfall: shortfall.toString(),
      reserveTotal: reserve.toString(),
      reserveAccountCount: input.reserveAccountCount,
    };
  }

  return {
    kind: "partly_covered",
    shortfall: shortfall.toString(),
    reserveTotal: reserve.toString(),
    transferAmount: reserve.toString(),
    // Clamped rather than allowed to go negative: "you would have −$400 in
    // savings" is not a fact about anything. What remains unsolved is
    // `stillShort`, and that is where the size of the problem lives.
    remainingAfterTransfer: Money.zero(CURRENCY).toString(),
    stillShort: shortfall.sub(reserve).toString(),
    reserveAccountCount: input.reserveAccountCount,
  };
}

function assertCount(field: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`classifyShortfall: ${field} must be a non-negative integer, got ${value}`);
  }
}
