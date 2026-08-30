import { Money } from "@/lib/money/money.ts";
import type { AttributionResult, AttributionRungId, AttributionStatus } from "./types.ts";

/**
 * The plain-language summary (P17-15).
 *
 * Pure. Turns a decomposition into the one sentence Round 11 asks for — "your
 * net worth rose $18,796 this quarter, mostly from the market and what you
 * saved" — and returns it as **structured parts rather than a formatted
 * string**, so the component owns wording, currency formatting and markup while
 * this function stays a testable decision about *what to say*.
 *
 * ── The whole job is deciding what to leave out ────────────────────────────
 * Six rungs read aloud is not a sentence, it is the table again. So a rung is
 * named only when it is *materially* nonzero — at least
 * {@link MATERIAL_SHARE} of the size of the change — and the rest stay in the
 * table below where they remain visible without competing for the headline.
 *
 * ── The residual gets the opposite treatment, deliberately ─────────────────
 * Every other rung must earn its place in the sentence. `unexplained` must earn
 * its *absence*: it is stated whenever it reaches {@link RESIDUAL_SHARE}, and
 * when it reaches {@link RESIDUAL_DOMINANT_SHARE} the caller is told to lead
 * with it. A summary that says "you gained $18,000, mostly from the market"
 * while a third of the change is unaccounted for is not a summary, it is a
 * claim the data does not support — and it is precisely the failure that would
 * make a household trust a number it should be checking (ADR-039 §4).
 *
 * ── Thresholds are ratios of |delta|, tested against zero explicitly ───────
 * Every comparison is `|amount| ≥ |delta| × share`, never a division, so the
 * flat-window case needs no special branch: when `delta` is `"0.00"` every
 * threshold collapses to zero and the `isZero()` guard alone decides. That
 * matters more than it looks — a quarter where a market fall exactly cancels
 * what a household saved is a real and interesting window, and dividing by its
 * delta would throw or produce nonsense on the one book that most deserves a
 * sentence.
 *
 * ── Money discipline ───────────────────────────────────────────────────────
 * Shares are applied with `Money.mul`, never native arithmetic, and no
 * percentage is emitted at all: the parts carry amounts, and the component
 * formats. `Number()` does not appear here.
 */

const CURRENCY = "USD";

/** A rung reaching this share of `|delta|` is worth naming in the sentence. */
export const MATERIAL_SHARE = "0.05";

/** `unexplained` reaching this share of `|delta|` must be stated, always. */
export const RESIDUAL_SHARE = "0.10";

/** At this share, the residual is the more truthful half of the page. */
export const RESIDUAL_DOMINANT_SHARE = "0.50";

/** Which way the window went. `flat` is exact equality, not a band. */
export type SummaryDirection = "up" | "down" | "flat";

/** One rung the sentence names. */
export interface SummaryDriver {
  readonly rungId: AttributionRungId;
  /** The rung's own label, carried through so the copy cannot drift from the table. */
  readonly label: string;
  /** Signed money string, exactly as the rung reported it. */
  readonly amount: string;
  /** Whether this rung pushed net worth up or down. Never `flat` — zero rungs are not drivers. */
  readonly direction: "up" | "down";
}

/** The sentence, as decisions rather than prose. */
export interface AttributionSummary {
  readonly from: string;
  readonly to: string;
  readonly direction: SummaryDirection;
  /** `closing − opening`, signed. */
  readonly delta: string;
  /** `|delta|`, for copy that reads better without a sign. */
  readonly magnitude: string;
  /**
   * The material rungs, largest magnitude first, `unexplained` never among
   * them. Empty when nothing reached the threshold — a real outcome for a
   * window that barely moved, and the component says so rather than reaching
   * for the largest of several trivial rungs.
   */
  readonly drivers: readonly SummaryDriver[];
  /** The residual, present only when it must be stated. */
  readonly residual: SummaryDriver | null;
  /** True when the residual is large enough that the rungs are the less true half. */
  readonly residualDominant: boolean;
  /** How many causes the residual could name. Zero with a large residual is itself a finding. */
  readonly diagnosticCount: number;
  /** Carried through so a caller needs only this object to render the surface. */
  readonly status: AttributionStatus;
}

/**
 * Decide what the summary sentence should say.
 *
 * @param result - A decomposition from `decomposeNetWorth`.
 * @param currency - Currency the amounts are in. Single-currency app; USD.
 * @returns The structured sentence. Never throws: every degraded status still
 *   produces a well-formed object, because the surface must be able to render
 *   *something* honest on a fresh install.
 */
export function summarySentence(
  result: AttributionResult,
  currency: string = CURRENCY,
): AttributionSummary {
  const delta = Money.fromString(result.delta, currency);
  const magnitude = delta.abs();

  const materialFloor = magnitude.mul(MATERIAL_SHARE);
  const residualFloor = magnitude.mul(RESIDUAL_SHARE);
  const dominantFloor = magnitude.mul(RESIDUAL_DOMINANT_SHARE);

  const drivers: SummaryDriver[] = [];
  let residual: SummaryDriver | null = null;
  let residualDominant = false;

  for (const rung of result.rungs) {
    const amount = Money.fromString(rung.amount, currency);
    if (amount.isZero()) continue;
    const part: SummaryDriver = {
      rungId: rung.id,
      label: rung.label,
      amount: rung.amount,
      direction: amount.isNegative() ? "down" : "up",
    };

    if (rung.id === "unexplained") {
      if (amount.abs().compare(residualFloor) >= 0) residual = part;
      residualDominant = amount.abs().compare(dominantFloor) >= 0;
      continue;
    }

    if (amount.abs().compare(materialFloor) >= 0) drivers.push(part);
  }

  drivers.sort((a, b) => {
    const bySize = Money.fromString(b.amount, currency)
      .abs()
      .compare(Money.fromString(a.amount, currency).abs());
    // No tie-break, and that is deliberate rather than an omission. Drivers are
    // pushed in `result.rungs` order — the narrative order — and `Array#sort`
    // has been stable since ES2019, so two equal magnitudes already read in the
    // order the table shows them. A comparator branch nothing can reach is a
    // comment that looks like code; the property is pinned by a test instead.
    return bySize;
  });

  return {
    from: result.from,
    to: result.to,
    direction: delta.isZero() ? "flat" : delta.isNegative() ? "down" : "up",
    delta: result.delta,
    magnitude: magnitude.toString(),
    drivers,
    residual,
    residualDominant,
    diagnosticCount: result.diagnostics.length,
    status: result.status,
  };
}
