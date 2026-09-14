import type {
  ObligationAmountMode,
  ObligationDirection,
  ObligationSource,
} from "@/db/schema/index.ts";
import type { ObligationCadence } from "@/lib/schedule/cadence.ts";

/**
 * The shapes the server page hands the client components (P16-24, P16-25).
 *
 * Same contract `/settings/income` established in
 * [view-models.ts](../../../settings/income/view-models.ts): plain data, no
 * Drizzle types, no `Money`. Every figure crosses the boundary PRE-FORMATTED
 * (`expectedDisplay`, `spreadDisplay`, …) because formatting is a
 * `Money.format()` call and money math belongs on the server — the browser never
 * does arithmetic on a dollar figure (CLAUDE.md §Money).
 *
 * Raw `numeric` strings still travel alongside, but only for the fields a form
 * has to round-trip unchanged.
 */

/** An account a bill can be paid from. */
export interface AccountView {
  readonly id: string;
  readonly name: string;
  readonly institution: string;
}

/** One occurrence of a detected series, as evidence the user can check. */
export interface EvidenceView {
  readonly date: string;
  readonly amountDisplay: string;
}

/** A proposal from the detector, awaiting an answer. */
export interface CandidateView {
  readonly accountId: string;
  readonly accountName: string;
  /** The `detection_key` on confirm; also the identity a dismissal is stored under. */
  readonly detectionKey: string;
  /** A raw bank description, so the user recognizes the series. */
  readonly sampleName: string;
  readonly label: string;
  readonly direction: ObligationDirection;
  readonly categoryId: string | null;
  readonly cadence: ObligationCadence;
  readonly anchorDate: string;
  readonly startDate: string;
  /** Raw, for the editable field. */
  readonly expectedAmount: string;
  readonly expectedDisplay: string;
  /** Median absolute deviation of the observed amounts. */
  readonly spreadDisplay: string;
  readonly amountMode: ObligationAmountMode;
  readonly confidence: "high" | "medium" | "low";
  readonly firstSeen: string;
  readonly lastSeen: string;
  readonly evidence: readonly EvidenceView[];
}

/**
 * A schedule proposed from stated loan terms, as the review list renders it
 * (CF-A5, ADR-047).
 *
 * A separate shape from {@link CandidateView} rather than a widening of it, for
 * the same reason the two are rendered as two sections: one is a guess with a
 * confidence grade attached, the other is a fact the household already told the
 * app. Merging them would produce a type whose `confidence` and `detectionKey`
 * are meaningless half the time, and a list that asks the user to grade a fact
 * as if it were a heuristic.
 */
export interface LiabilityCandidateView {
  readonly liabilityId: string;
  /** `null` when the app cannot tell which account pays it — see `accountOptions`. */
  readonly accountId: string | null;
  /** Every everyday account, so the row can offer a selector. */
  readonly accountOptions: readonly AccountView[];
  readonly label: string;
  /** Raw, for the editable field. */
  readonly expectedAmount: string;
  readonly expectedDisplay: string;
  /** Computed principal-and-interest, always shown beside the proposal. */
  readonly scheduledDisplay: string;
  /** Median of the household's own payments; `null` when too few were seen. */
  readonly observedDisplay: string | null;
  /** Median absolute deviation of those payments; `null` with none. */
  readonly spreadDisplay: string | null;
  readonly observedCount: number;
  /** True when the figure is P&I alone, so escrow and PMI are NOT in it. */
  readonly escrowCaveat: boolean;
  readonly amountMode: ObligationAmountMode;
  readonly anchorDate: string;
  readonly startDate: string;
  /** A raw bank description of the recognized payments, or `null`. */
  readonly sampleName: string | null;
  readonly evidence: readonly EvidenceView[];
  /**
   * A sentence naming a detected suggestion that looks like the same payment,
   * or `null`.
   *
   * ADR-047 cannot prevent this by structure — a detected series and a stated
   * loan schedule are two legitimately different rows — so it is handled by
   * DISCLOSURE. Confirming both would put the same money on the calendar twice.
   */
  readonly collision: string | null;
}

/** A confirmed obligation, as the management list renders it. */
export interface ObligationView {
  readonly id: string;
  readonly accountId: string;
  readonly accountName: string;
  readonly categoryId: string | null;
  readonly categoryName: string | null;
  readonly label: string;
  /** Raw, for the editable field. */
  readonly expectedAmount: string;
  readonly expectedDisplay: string;
  readonly direction: ObligationDirection;
  readonly currency: string;
  readonly cadence: ObligationCadence;
  readonly anchorDate: string;
  readonly startDate: string;
  readonly endDate: string | null;
  readonly active: boolean;
  readonly amountMode: ObligationAmountMode;
  /**
   * Which door the proposal came through. **Every value still means the user
   * confirmed it** (ADR-036 §2) — `'liability'` says the schedule was pre-filled
   * from loan terms the household had already stated (ADR-047 §3).
   */
  readonly source: ObligationSource;
  /** Set only on a `'liability'` row. Drives the "from your loan terms" note. */
  readonly liabilityId: string | null;
  readonly confidence: "high" | "medium" | "low" | null;
  readonly notes: string | null;
}
