import { reserveMonthsFor } from "@/lib/advice/rules/emergency-fund.ts";
import type { AdviceInput } from "@/lib/advice/snapshot.ts";
import { Money } from "@/lib/money/money.ts";
import type { SinkingAvailability, SinkingRequirement } from "./types.ts";

/**
 * What the household actually has against the requirement (P18-15, ADR-046
 * §1/§2).
 *
 * The arithmetic is two subtractions. Everything that can be got wrong here is a
 * judgement call, and all three are ADR-046's:
 *
 * ── 1. The reserve tier, above the emergency-fund target ──────────────────
 *     available = max(0, cash.reserve.total − reserveMonthsFor(input) × essentials.baseline)
 *
 * **The reserve tier only** (§2), through the one
 * [`classifyCashTiers`](../advice/cash-tiers.ts) that already produced
 * `input.cash`. Not total cash: operating money is committed to this month's
 * bills. Not medium-term: breaking a CD costs a penalty. Counting either would
 * report a fund the household cannot spend on the day the premium lands, which
 * is the one circumstance the figure exists for — the argument the
 * emergency-fund rule already makes, unchanged and not re-litigated.
 *
 * And **above the target**, because one pot cannot do two jobs and be called
 * funded twice. Money already standing in for three months of lost income is not
 * also available for next March's insurance.
 *
 * ── 2. `reserveMonthsFor`, not a second implementation ───────────────────
 * This is its **fourth** caller — the emergency-fund rule, the waterfall rung
 * and the cash-drag rule got there first (and P18-00 corrected the plan, which
 * had said third). A household that set a 4-month target sees $12,000 here and
 * $12,000 on the emergency-fund card because it is the same exported function
 * reading the same snapshot, which is the entire reason it is exported.
 *
 * ── 3. `null` is not `"0.00"` ────────────────────────────────────────────
 * With no essential baseline there is no target, and with no target there is no
 * available figure and no position to report. `"0.00"` would read as *"you have
 * nothing spare"* and a full-requirement gap — a confident claim about a
 * household whose spending is simply unclassified. `null` reads as the named
 * degradation with a link to fix it ([status.ts](./status.ts) turns it into the
 * word, ADR-046 §4 into the rule's `unknown_input`). This is the `null` ≠
 * `"0.00"` rule [advice/statistics.ts](../advice/statistics.ts) carries the whole
 * advice phase on.
 *
 * `reserveTotal` is **not** null in that case, deliberately: declining to answer
 * a question we cannot answer is not the same as declining to show a balance
 * that is sitting in an account.
 *
 * ── `gap` and `surplus` ──────────────────────────────────────────────────
 * Both non-negative, at most one non-zero, and which one it is is the answer the
 * page leads with. The alternative — one signed field — makes every consumer
 * read a sign correctly to render a sentence, and a rule that gets it backwards
 * tells a household it is ahead when it is behind. Exactly equal is **both
 * zero**, not a $0 surplus dressed up as good news; the status says whether that
 * is on track.
 *
 * Pure and I/O-free (ADR-032 §1): the snapshot arrives assembled. Nothing is
 * stored (ADR-032 §3) and nothing here records where money *is* — `available`
 * is a comparison against an unpartitioned balance, computed on read, which is
 * what keeps this phase on the stated side of CLAUDE.md §Domain Scope's
 * no-envelopes line. Deleting every planned expense leaves this figure's inputs
 * untouched.
 *
 * ── A note on the clamp ──────────────────────────────────────────────────
 * [advice/amounts.ts](../advice/amounts.ts)'s `clampAtZero` does the same job in
 * one call, but its zero is hardcoded USD. These figures are stated in
 * `input.currency`, so the clamp is written out here against the household's own
 * currency rather than imported from a helper that would relabel a non-USD
 * figure. Three lines, and no new arithmetic (CLAUDE.md §Money: still Decimal).
 */

/**
 * Compare the reserve tier to the requirement.
 *
 * @param input - The assembled financial snapshot. Read for `cash.reserve.total`,
 *   `essentials.baseline`, `currency`, and whatever `reserveMonthsFor` consults.
 *   Never mutated.
 * @param requirement - The output of {@link ./requirement.ts sinkingRequirement},
 *   taken whole rather than as a bare string so a caller cannot pass `perMonth`
 *   where `requiredToday` belongs. Its totals are stated in `input.currency` by
 *   construction: the one loader builds the stream's horizon from the same
 *   snapshot.
 * @returns The reserve balance, the emergency-fund target, what is available
 *   above it, and the gap or surplus against the requirement. Every field but
 *   `reserveTotal` is `null` when the essential baseline is missing.
 */
export function sinkingAvailability(
  input: AdviceInput,
  requirement: SinkingRequirement,
): SinkingAvailability {
  const currency = input.currency;
  const zero = Money.zero(currency);
  const reserveTotal = Money.fromString(input.cash.reserve.total, currency);
  const baseline = input.essentials.baseline;

  // ADR-046 §4. No baseline, no target; no target, no position — and the three
  // nulls travel together rather than one of them becoming a zero on the way
  // out.
  if (baseline === null) {
    return {
      reserveTotal: reserveTotal.toString(),
      emergencyTarget: null,
      available: null,
      gap: null,
      surplus: null,
    };
  }

  const emergencyTarget = Money.fromString(baseline, currency).mul(reserveMonthsFor(input).months);
  const spare = reserveTotal.sub(emergencyTarget);
  // "Nothing spare" rather than a negative availability: the reserve shortfall
  // is the emergency-fund rule's report to make, and ADR-046 §3 keeps this one
  // from re-stating it as a second alarm about the same dollars.
  const available = spare.isNegative() ? zero : spare;

  // Written as two clamped subtractions rather than one signed figure negated,
  // so neither branch can emit a signed zero and the symmetry is visible in the
  // code the way it is in the output: equal means both are "0.00".
  const required = Money.fromString(requirement.requiredToday, currency);
  const shortfall = required.sub(available);
  const excess = available.sub(required);

  return {
    reserveTotal: reserveTotal.toString(),
    emergencyTarget: emergencyTarget.toString(),
    available: available.toString(),
    gap: (shortfall.isNegative() ? zero : shortfall).toString(),
    surplus: (excess.isNegative() ? zero : excess).toString(),
  };
}
