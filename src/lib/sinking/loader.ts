import "server-only";

import { baselineConfidence } from "@/lib/advice/rules/shared.ts";
import { loadFinancialSnapshot } from "@/lib/advice/snapshot.ts";
import type { Confidence } from "@/lib/advice/types.ts";
import { sinkingAvailability } from "./availability.ts";
import { sinkingInputsUsed } from "./inputs.ts";
import type { PlannedExpenseRecord } from "./queries.ts";
import { listPlannedExpenses } from "./queries.ts";
import { type SinkingHorizon, sinkingHorizon, sinkingRequirement } from "./requirement.ts";
import { sinkingStatus } from "./status.ts";
import type { InputUsed, SinkingAvailability, SinkingRequirement, SinkingStatus } from "./types.ts";

/**
 * The sinking fund's one assembly function (P18-22, ADR-032 §1, ADR-046).
 *
 * Mirrors [advice/snapshot.ts](../advice/snapshot.ts) and
 * [cashflow/loader.ts](../cashflow/loader.ts): this reads, everything
 * downstream is pure. [accrual](./accrual.ts), [costs](./costs.ts),
 * [requirement](./requirement.ts), [availability](./availability.ts),
 * [status](./status.ts) and [inputs](./inputs.ts) take values and give values
 * back, and the only modules in this directory that know Postgres exists are
 * [queries.ts](./queries.ts) and this one.
 *
 * ── Why this composes the snapshot instead of querying for itself ─────────
 * ADR-046 consequence 1: `/plan/sinking` and the `sinking_fund` guidance card
 * **cannot** disagree. The way to guarantee that is not a convention — it is for
 * both to call the same four pure functions over the same `AdviceInput`. The
 * rule gets its input from `loadFinancialSnapshot`; so does this. A narrower
 * loader that read only the reserve tier and the essential baseline would be
 * cheaper and would be a **second** derivation of both, free to drift by a
 * subtype classification or a window length — and the first symptom would be a
 * page and a card quoting different dollars, which is the one failure that makes
 * a household stop believing either.
 *
 * ── The read cost ADR-046 accepted, stated plainly ────────────────────────
 * `loadFinancialSnapshot` is the advice phase's full snapshot: accounts,
 * balances, categories, trailing spend, contribution rules. `/plan/sinking`
 * needs a fraction of it. That is a real cost and ADR-046 took it knowingly —
 * the snapshot is already paid for on every `/plan` load, the queries are
 * indexed, and correctness between two surfaces was judged worth more than one
 * page's millisecond. P18-35 measures it. **If it is slow, the recorded answer
 * is a narrower loader that composes the same pure functions — never a second
 * computation of the requirement.**
 *
 * ── What is here that the rule does not need ─────────────────────────────
 * One extra query: {@link listPlannedExpenses}, the full list including `paid`
 * and `cancelled` rows. The requirement does not read it and cannot be changed
 * by it — it exists because the manager has to show a household what became of
 * a cost it recorded last year (ADR-043 §3, deactivate never delete). It is the
 * only place in the phase that selects `notes`.
 *
 * Nothing here is stored (ADR-032 §3). Nothing reaches the network, and no
 * figure or label is logged (CLAUDE.md §Privacy).
 */

export interface LoadSinkingOptions {
  /** `YYYY-MM-DD`. Explicit so a run is reproducible; defaults to today, UTC. */
  readonly today?: string;
}

/** Everything `/plan/sinking` renders. */
export interface SinkingSnapshot {
  /** Reference date every figure is stated as of. */
  readonly today: string;
  /** The household's currency, from the snapshot. */
  readonly currency: string;
  /** The 12-month window the requirement covers (ADR-045 §5). */
  readonly horizon: SinkingHorizon;
  /** The itemized requirement — its `costs` are the table's rows. */
  readonly requirement: SinkingRequirement;
  /** The reserve, the emergency-fund target, and the gap or surplus. */
  readonly availability: SinkingAvailability;
  /** Why a figure is or is not available (ADR-046 §4/§5). */
  readonly status: SinkingStatus;
  /**
   * Every recorded planned expense, `paid` and `cancelled` included.
   *
   * Not the requirement's inputs — {@link SinkingRequirement.costs} is that, and
   * it also holds the obligation-sourced costs this list cannot contain.
   */
  readonly plannedExpenses: readonly PlannedExpenseRecord[];
  /** The audit trail, the same list the guidance card cites (ADR-032 §2). */
  readonly inputsUsed: readonly InputUsed[];
  /**
   * How much to trust the figure, graded by the shipped baseline grader
   * (ADR-046 §7).
   *
   * Beside the number, never instead of it: a `low` here still renders the
   * requirement, because a household with four months of history still has the
   * same premium due in March.
   */
  readonly confidence: Confidence;
}

/**
 * Assemble the sinking-fund picture.
 *
 * @param options - The reference date, injected for tests and reproducibility.
 * @returns The requirement, the position against it, the status, the full
 *   planned-expense list and the audit trail.
 * @throws If a recorded cost is in a currency other than the household's —
 *   `sinkingRequirement` refuses to add two currencies without an `fx_rates`
 *   lookup (CLAUDE.md §Money), and a loud failure beats a wrong total. Every
 *   money column in the phase defaults to the household's currency and nothing
 *   in the app writes a second one; if that changes, the conversion belongs
 *   here, not in a relabelled string downstream.
 */
export async function loadSinkingFund(options: LoadSinkingOptions = {}): Promise<SinkingSnapshot> {
  const today = options.today ?? new Date().toISOString().slice(0, 10);

  // The snapshot already carries `knownFutureCosts` (P18-18), so this is two
  // concurrent reads rather than three sequential ones.
  const [input, recorded] = await Promise.all([
    loadFinancialSnapshot({ today }),
    listPlannedExpenses(),
  ]);

  const horizon = sinkingHorizon(input.today, input.currency);
  const requirement = sinkingRequirement(input.knownFutureCosts, input.today, horizon);
  const availability = sinkingAvailability(input, requirement);

  return {
    // `input.today` rather than the local `today`: the snapshot is the clock, so
    // a page cannot date its own heading differently from the figure on it.
    // The two are provably equal today — `loadFinancialSnapshot` sets its
    // `today` from the same `options.today` this passes it — so a mutation
    // swapping them survives the suite, and that is recorded rather than
    // chased. It is kept because the equality is a property of the OTHER
    // module's contract, not of this one: if the snapshot ever normalizes or
    // clamps the date it is given, reading it back is what keeps this honest.
    today: input.today,
    currency: input.currency,
    horizon,
    requirement,
    availability,
    status: sinkingStatus(requirement, availability),
    plannedExpenses: recorded,
    inputsUsed: sinkingInputsUsed(input, requirement, availability),
    confidence: baselineConfidence(input),
  };
}
