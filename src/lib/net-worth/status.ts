import type { InputUsed } from "@/lib/advice/types.ts";
import { assertWindow } from "./endpoints.ts";
import type { AttributionStatus } from "./types.ts";

/**
 * The attribution degradation ladder (P17-14, ADR-039).
 *
 * Pure. Decides how much of the decomposition can be stated honestly and, when
 * the answer is "less than all of it", NAMES the missing input and links to
 * where the user supplies it — the [cashflow/status.ts](../cashflow/status.ts)
 * shape (ADR-038 §7), reused rather than reinvented.
 *
 * ── Degrading is the normal path, not the error path ───────────────────────
 * On a fresh install `'no_snapshots'` is the *correct* answer, and the surface
 * renders it as plainly as it renders a waterfall. What is not acceptable is a
 * page that fills a missing endpoint with a zero and calls the difference a
 * gain — which is exactly what an undegraded decomposition would do, because
 * `computeNetWorth` contributes nothing at all for an account with no snapshot
 * on or before the date (compute.ts rules 2 and 5).
 *
 * ── One signal, and why the plan's literal phrasing could not be used ──────
 * P17-14 describes `'no_snapshots'` as "no snapshot on or before **either**
 * endpoint". Read strictly — "the opening endpoint has none" — that condition
 * is exactly `firstSnapshotDate > from`, which is also the definition of
 * `'insufficient_history'`, and the stricter rung would swallow the softer one
 * whole: `'insufficient_history'` would be unreachable and the ladder would
 * have three levels on paper and two in fact. So the two are separated by
 * *which* endpoint is unserved, which is the distinction that actually changes
 * what the app can say:
 *
 *     nothing recorded on or before `to`    →  no_snapshots
 *       (there is no closing figure at all; nothing can be decomposed)
 *     nothing recorded on or before `from`  →  insufficient_history
 *       (there IS a closing figure, but the opening is against an empty book,
 *        so the delta reads as an enormous fabricated gain)
 *     otherwise                             →  ok
 *
 * That collapses the ladder's input to a single fact — the earliest snapshot in
 * the book — which is worth more than it looks: two counts that could disagree
 * are two counts that eventually will.
 *
 * ── What this ladder deliberately does NOT gate on ─────────────────────────
 * A *large residual* is not a status. It is the feature (ADR-039 §4): the
 * decomposition is fully stated and the diagnostics name the causes. Demoting
 * it to a degraded rung would hide the one signal the phase exists to produce.
 * P17-15 decides whether the residual leads the sentence; P17-22 decides
 * whether it leads the page. Neither is this function's business.
 *
 * Nor does it gate on an account that opened mid-window. A genuinely new
 * account legitimately has no opening snapshot, and treating that as missing
 * history would leave a growing household permanently degraded.
 */

/** The facts the ladder reads. Both are dates or a null, never a judgement. */
export interface AttributionStatusInput {
  /** Inclusive window start, `YYYY-MM-DD`. */
  readonly from: string;
  /** Inclusive window end, `YYYY-MM-DD`. */
  readonly to: string;
  /**
   * The earliest `account_snapshots.date` in the whole book, or `null` when the
   * book holds none.
   *
   * Book-wide rather than per-account on purpose: the endpoints are net-worth
   * *totals*, and a total is stateable as soon as any account can be valued.
   */
  readonly firstSnapshotDate: string | null;
}

/** The status and, unless `ok`, the one input that is blocking it. */
export interface AttributionStatusResult {
  readonly status: AttributionStatus;
  /** `null` only when `status === 'ok'`. */
  readonly missing: InputUsed | null;
}

/**
 * Decide how honestly the decomposition can be stated.
 *
 * @param input - The window and the book's earliest snapshot date.
 * @returns The status, plus the named and linked missing input when not `ok`.
 * @throws If the window runs backwards — the same guard every rung applies, so
 *   an inverted range fails identically everywhere instead of degrading here
 *   into a plausible-looking screen.
 */
export function attributionStatus(input: AttributionStatusInput): AttributionStatusResult {
  assertWindow(input.from, input.to, "attributionStatus");

  if (input.firstSnapshotDate === null || input.firstSnapshotDate > input.to) {
    return {
      status: "no_snapshots",
      missing: {
        label: "Recorded account balances",
        // null, not "0": NOT RECORDED. The household may well have the money —
        // the app has simply never been told a balance.
        value: null,
        kind: "date",
        source:
          input.firstSnapshotDate === null
            ? "No account balance has been recorded yet"
            : `The earliest recorded balance is ${input.firstSnapshotDate}, after this window ends`,
        missing: true,
        href: "/accounts",
      },
    };
  }

  if (input.firstSnapshotDate > input.from) {
    return {
      status: "insufficient_history",
      missing: {
        label: "Balance history at the start of this window",
        value: input.firstSnapshotDate,
        kind: "date",
        source: `Records begin ${input.firstSnapshotDate}, inside the window — the opening figure would be measured against an empty book`,
        missing: true,
        href: "/accounts",
      },
    };
  }

  return { status: "ok", missing: null };
}
