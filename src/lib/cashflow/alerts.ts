import type { ObligationAmountMode, ObligationDirection } from "@/db/schema/index.ts";
import { type DetectedAlert, dedupHash } from "@/lib/alerts/rules.ts";
import { Money } from "@/lib/money/money.ts";
import type { ShortfallClose } from "./shortfall-close.ts";
import { STATED_FIGURE_STATUSES } from "./status.ts";
import type { LowWaterMark, ProjectionStatus, SafeToSpend } from "./types.ts";

/**
 * Cash-flow alerts (Phase 16, P16-28, ADR-015 / ADR-026).
 *
 * A pure map from an already-computed projection and an already-run match sweep
 * to `alerts` rows. No I/O, no clock — the daily `project-cashflow-daily` job
 * does the reading and the writing; every judgement about what is worth
 * interrupting a household for lives here, where it is unit-testable. Same split
 * as [advice/alerts.ts](../advice/alerts.ts), and for the same reason.
 *
 * ── Three types, two very different lifecycles ─────────────────────────────
 * `projected_shortfall` is a STANDING condition: it is true for as long as the
 * projection dips below the floor, and it genuinely clears when the projection
 * recovers. It is therefore resolve-swept — by the cash-flow job itself, not by
 * the anomaly detector, for the reason spelled out on
 * `CASHFLOW_SWEPT_ALERT_TYPES`.
 *
 * `obligation_missed` and `obligation_amount_changed` are ONE-SHOT events about
 * a specific occurrence, exactly like `price_target` and `backup_failure`. The
 * mortgage either posted in its window or it did not, and that fact does not
 * un-happen. They are never swept; the user dismisses them.
 *
 * ── Never re-nagging is the whole design (ADR-026) ─────────────────────────
 * A household projected short in March is projected short again tomorrow, and
 * the day after. An alert every night is precisely how you teach someone to
 * ignore the alerts page — which would cost them the one night it mattered. The
 * shortfall's dedup key is therefore `(type, 'operating-cash', YYYY-MM of the
 * low-water date)`:
 *
 *   - It excludes the AMOUNT, so a few dollars of balance drift is not "new".
 *   - It excludes the exact DAY, because the low-water date jitters by a day
 *     whenever a transaction posts, and hashing it would fire on that jitter.
 *   - It keeps the MONTH, so a shortfall that appears in a later month is
 *     genuinely new information and does fire.
 *
 * One consequence is worth stating plainly rather than discovering later: the
 * `dedup_hash` column is globally UNIQUE, so a shortfall that clears and then
 * recurs *within the same month* will not raise a second alert. That is the
 * behaviour every resolve-swept type in this codebase already has
 * (`item_login_required` keys on the item's status the same way), and given the
 * choice between one missed re-fire and a nightly nag, the nightly nag is the
 * one that destroys the feature.
 *
 * ── No figure reaches `title` (ADR-015) ────────────────────────────────────
 * Every amount lives in `detail`, which is rendered only in the authenticated
 * UI and never emailed — the notification is a count and a date and nothing
 * else. Obligation LABELS do appear in titles: a label is user-authored text
 * naming a bill they need to recognize in a list, not a figure the app
 * computed, and ADR-015's concern is the second. There is a test asserting no
 * title this module produces contains a digit.
 */

/** Where the shortfall alert sends the user. */
const PROJECTION_HREF = "/plan/cashflow";
/** Where an occurrence alert sends the user — the schedule that produced it. */
const REVIEW_HREF = "/plan/cashflow/review";

/** The single household-level subject for a projection that covers all operating cash. */
const SHORTFALL_SUBJECT = "operating-cash";

/**
 * How far a matched amount must move before it is worth telling anyone.
 *
 * The matcher's own tolerance (±15% on a fixed bill) already bounds what could
 * have matched at all, so this threshold sits *inside* it: the alertable band
 * is "more than 5% but still recognizably the same bill". The absolute floor
 * exists because 5% of a $14 subscription is 70 cents, and a 70-cent
 * interruption is worse than no feature.
 */
export const AMOUNT_CHANGE_THRESHOLD = {
  /** Fraction of the expected amount. */
  pct: "0.05",
  /** Minimum absolute move, whatever the percentage says. */
  abs: "5.00",
} as const;

const CURRENCY = "USD";

/**
 * Statuses honest enough to alert from.
 *
 * Imported rather than declared here so this module, `/plan/cashflow` and the
 * dashboard card cannot drift apart on what counts as a stateable figure — see
 * {@link STATED_FIGURE_STATUSES}.
 */
const ALERTABLE_STATUSES: ReadonlySet<ProjectionStatus> = new Set(STATED_FIGURE_STATUSES);

/** The projection figures the shortfall rule reads. Nothing else is needed. */
export interface ShortfallInput {
  readonly status: ProjectionStatus;
  readonly safeToSpend: SafeToSpend;
  readonly lowWaterMark: LowWaterMark | null;
  readonly horizonDays: number;
  /** Share of trailing spend attributable to confirmed bills; `null` = nothing to measure. */
  readonly coverage: string | null;
  /**
   * What would close the shortfall, when the loader could work it out
   * (ADR-048 §4). `null` means the question was not asked — an older caller, or
   * a projection that is not short — and grades exactly as it did before.
   *
   * Optional on purpose: this rule's job is to decide how loudly to speak, and a
   * missing classification must fall back to the louder answer rather than
   * silently downgrading an alert nobody classified.
   */
  readonly close?: ShortfallClose | null;
}

/** One occurrence whose match window closed with nothing found. */
export interface MissedOccurrenceInput {
  readonly occurrenceId: string;
  readonly obligationId: string;
  readonly label: string;
  readonly dueDate: string;
  /** The snapshotted expectation, a positive magnitude. */
  readonly expectedAmount: string;
  readonly direction: ObligationDirection;
}

/** One occurrence that matched, but for a materially different amount. */
export interface AmountChangeInput {
  readonly occurrenceId: string;
  readonly obligationId: string;
  readonly label: string;
  readonly dueDate: string;
  /** Positive magnitude, snapshotted at materialization. */
  readonly expectedAmount: string;
  /** The transaction's amount, signed as stored. */
  readonly matchedAmount: string;
  /** Actual magnitude minus expected magnitude; positive means bigger than expected. */
  readonly amountDelta: string;
  readonly amountMode: ObligationAmountMode;
}

/** Everything the composed mapper reads in one run. */
export interface CashFlowAlertInput {
  /** `null` when there is no projection to judge at all. */
  readonly shortfall: ShortfallInput | null;
  readonly missed: readonly MissedOccurrenceInput[];
  readonly amountChanges: readonly AmountChangeInput[];
}

/**
 * The dedup key for a projected shortfall.
 *
 * @param lowWaterDate - The date the projection bottoms out, `YYYY-MM-DD`.
 * @returns The sha256 dedup hash, stable for the whole calendar month.
 */
export function shortfallDedupHash(lowWaterDate: string): string {
  return dedupHash("projected_shortfall", SHORTFALL_SUBJECT, lowWaterDate.slice(0, 7));
}

/**
 * Raise an alert when the projection dips below the household's own floor.
 *
 * Silent on `no_operating_account` (there is no projection) and on
 * `insufficient_history` (the app itself labels that projection as not yet
 * trustworthy, and alerting on it would turn the honest-degradation path into a
 * nag — the same call `adviceAlerts` makes for `unknown_input`). A
 * `run_rate_only` projection DOES alert: it is thin, but a household with no
 * confirmed bills that is still projected short is short for reasons the
 * run-rate already sees.
 *
 * ── Graded by the reserve, never silenced by it (ADR-048 §4) ──────────────
 * A household with a funded emergency fund and a $300 timing gap is not in the
 * same situation as one that cannot cover the month, and a red interruption for
 * the first teaches them to ignore the second. So a `covered` shortfall drops to
 * `info` — **and is still written**. A monthly raid on the emergency fund is a
 * real finding, and the monthly repetition of an `info` alert is exactly how
 * that pattern becomes visible. Suppressing it entirely would hide the one thing
 * worth noticing about a household that is technically fine every single month.
 *
 * `partly_covered` keeps the full severity: the reserve helps, and the household
 * is still short afterwards. `reserve_unknown` keeps it too — not knowing where
 * the cash sits is not a reason to be quieter about running out of it.
 *
 * @param input - The projection's status, safe-to-spend, low-water mark, and —
 *   when the loader worked it out — what would close the gap.
 * @returns At most one alert. `critical` when the balance itself goes negative
 *   — below your own buffer and actually overdrawn are different sentences.
 */
export function projectedShortfallAlerts(input: ShortfallInput): DetectedAlert[] {
  if (!ALERTABLE_STATUSES.has(input.status)) return [];
  if (!input.safeToSpend.clampedAtZero) return [];
  if (input.lowWaterMark === null) return [];

  const overdrawn = Money.fromString(input.lowWaterMark.balance, CURRENCY).isNegative();
  const covered = input.close?.kind === "covered";

  return [
    {
      type: "projected_shortfall",
      // The dedup key is deliberately untouched by the grading: a shortfall that
      // becomes covered is the same standing condition, not a new one, and
      // re-firing on the grade would be the nightly nag ADR-026 rejects.
      severity: covered ? "info" : overdrawn ? "critical" : "warning",
      dedupHash: shortfallDedupHash(input.lowWaterMark.date),
      // Figure-free by construction — see the module header. A covered
      // shortfall gets its own sentence rather than the alarming one: the
      // household is not about to run out, they are about to have to move
      // money, and those read very differently at 07:00.
      title: covered
        ? "Your savings will need to cover a gap this month"
        : overdrawn
          ? "Your checking balance is projected to go negative"
          : "Your projected balance dips below your cash floor",
      detail: {
        lowWaterDate: input.lowWaterMark.date,
        lowWaterBalance: input.lowWaterMark.balance,
        shortfall: input.safeToSpend.shortfall,
        cashFloor: input.safeToSpend.floor,
        horizonDays: input.horizonDays,
        coverage: input.coverage,
        status: input.status,
        // The classification travels as a flat string, not as the union
        // itself: the alerts page renders `detail` with `String(v)` per key, so
        // a nested object would land on screen as "[object Object]". The
        // amounts it would have carried are already here.
        shortfallClose: input.close?.kind ?? null,
        href: PROJECTION_HREF,
      },
    },
  ];
}

/**
 * Raise one alert per occurrence whose window closed with nothing matching it.
 *
 * Fires for receipts as well as payments: a rent cheque that never arrived
 * leaves the projection wrong in the optimistic direction, which is the
 * dangerous one (ADR-038 §5).
 *
 * @param rows - Occurrences the sweep marked `missed` on THIS run.
 * @returns One alert each, keyed on the occurrence so it fires exactly once.
 */
export function obligationMissedAlerts(rows: readonly MissedOccurrenceInput[]): DetectedAlert[] {
  return rows.map((row) => ({
    type: "obligation_missed" as const,
    severity: "warning" as const,
    dedupHash: dedupHash("obligation_missed", row.occurrenceId, row.dueDate),
    title:
      row.direction === "outflow"
        ? `A bill did not post: ${row.label}`
        : `An expected payment did not arrive: ${row.label}`,
    detail: {
      obligationId: row.obligationId,
      occurrenceId: row.occurrenceId,
      label: row.label,
      dueDate: row.dueDate,
      expectedAmount: row.expectedAmount,
      direction: row.direction,
      href: REVIEW_HREF,
    },
  }));
}

/**
 * Raise one alert per matched occurrence whose amount moved materially.
 *
 * Two exclusions carry the rule:
 *
 *   - **`trailing_median` obligations never fire.** A utility bill varying is
 *     what that mode *means*; alerting on it would produce a monthly
 *     interruption carrying no information, and the projection already prices
 *     the obligation at its median precisely because the amount moves.
 *   - **Moves under `max(5%, $5)` never fire.** See
 *     {@link AMOUNT_CHANGE_THRESHOLD}.
 *
 * A DECREASE alerts too. A mortgage that posted five hundred dollars instead of
 * two thousand is not good news, and treating "smaller" as "fine" would miss
 * the partial payment that is about to become a late fee.
 *
 * @param rows - Occurrences matched on THIS run, with their deltas.
 * @returns One alert per material change, keyed on the occurrence.
 */
export function obligationAmountChangedAlerts(rows: readonly AmountChangeInput[]): DetectedAlert[] {
  const out: DetectedAlert[] = [];
  for (const row of rows) {
    if (row.amountMode === "trailing_median") continue;

    const delta = Money.fromString(row.amountDelta, CURRENCY).abs();
    const expected = Money.fromString(row.expectedAmount, CURRENCY).abs();
    const proportional = expected.mul(AMOUNT_CHANGE_THRESHOLD.pct);
    const floor = Money.fromString(AMOUNT_CHANGE_THRESHOLD.abs, CURRENCY);
    const threshold = proportional.compare(floor) >= 0 ? proportional : floor;
    // Strictly greater: a move exactly at the threshold is the threshold, not
    // past it, and this is the quiet direction.
    if (delta.compare(threshold) <= 0) continue;

    const increased = !Money.fromString(row.amountDelta, CURRENCY).isNegative();
    out.push({
      type: "obligation_amount_changed",
      severity: "warning",
      dedupHash: dedupHash("obligation_amount_changed", row.occurrenceId, row.dueDate),
      title: increased
        ? `A recurring bill went up: ${row.label}`
        : `A recurring bill posted for less than expected: ${row.label}`,
      detail: {
        obligationId: row.obligationId,
        occurrenceId: row.occurrenceId,
        label: row.label,
        dueDate: row.dueDate,
        expectedAmount: row.expectedAmount,
        matchedAmount: row.matchedAmount,
        amountDelta: row.amountDelta,
        increased,
        href: REVIEW_HREF,
      },
    });
  }
  return out;
}

/**
 * Every cash-flow alert for one run of the daily job.
 *
 * @param input - The projection to judge (or `null`), plus the sweep's newly
 *   missed and newly matched occurrences.
 * @returns The alerts to persist, in a stable order: the standing condition
 *   first, then the occurrence events. Empty on a household with nothing urgent
 *   — which is the normal case, not an error.
 */
export function cashFlowAlerts(input: CashFlowAlertInput): DetectedAlert[] {
  return [
    ...(input.shortfall === null ? [] : projectedShortfallAlerts(input.shortfall)),
    ...obligationMissedAlerts(input.missed),
    ...obligationAmountChangedAlerts(input.amountChanges),
  ];
}
