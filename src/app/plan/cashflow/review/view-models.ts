import type { ObligationAmountMode, ObligationDirection } from "@/db/schema/index.ts";
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
  /** `'detected'` still means the user confirmed it (ADR-036 §2). */
  readonly source: "detected" | "manual";
  readonly confidence: "high" | "medium" | "low" | null;
  readonly notes: string | null;
}
