import type { PlannedExpenseStatus } from "@/db/schema/planned-expenses.ts";
import { Money } from "@/lib/money/money.ts";
import { SINKING_HORIZON_MONTHS } from "@/lib/sinking/constants.ts";
import type { PlannedExpenseRecord } from "@/lib/sinking/queries.ts";
import type { CostSource, SinkingAvailability, SinkingRequirement } from "@/lib/sinking/types.ts";

/**
 * The shapes and derivations behind `/plan/sinking` (P18-23).
 *
 * Same contract the other two planning surfaces established in their own
 * `view-models.ts`: plain data crosses to the client, no Drizzle values, no
 * `Money`, and **every figure is formatted on the server** — the browser never
 * does arithmetic on a dollar amount (CLAUDE.md §Money). The one raw string that
 * travels is the editable `amount` on a planned expense, and nothing parses it
 * on the way.
 *
 * ── What is deliberately not here ─────────────────────────────────────────
 * **No per-cost funding state.** No `funded`, no `unfunded`, no "on track", no
 * percentage, no progress bar. `personal-tool-builder`'s pushback at P18-00 is
 * the reason and it is a modelling point, not a copy preference: the gap and the
 * surplus are **household-level** aggregates over one undivided reserve, and
 * there is no fact about an individual cost's funding to render. A per-row
 * progress indicator would have to invent an allocation the app does not make
 * and the bank does not honour — the envelope system rebuilt in copy rather than
 * in schema (CLAUDE.md §Domain Scope).
 *
 * What a row does carry is what is *true* of it: what it costs, when it is due,
 * how long is left, and what share of the household requirement it contributes.
 */

/** A date rendered as a sentence fragment — `"March 14, 2027"`. */
const LONG_DATE = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "long",
  day: "numeric",
  timeZone: "UTC",
});

/**
 * Render a calendar date.
 *
 * UTC deliberately, the same reason `/plan/cashflow` states: a `date` column is
 * a calendar date, not an instant, and letting the server's zone interpret it
 * renders the 14th as the 13th anywhere west of Greenwich.
 *
 * @param iso - `YYYY-MM-DD`.
 * @returns e.g. `"March 14, 2027"`.
 */
export function longDate(iso: string): string {
  return LONG_DATE.format(new Date(`${iso}T00:00:00Z`));
}

/**
 * Why a row the household may not remember typing is on the list (ADR-045 §1).
 *
 * Named by where it came from, not by what it is: a reader who sees a premium
 * they never entered on this page needs to know it came off their bill calendar.
 */
export function sourceLabel(source: CostSource): string {
  return source === "planned_expense" ? "Recorded here" : "From your bill calendar";
}

/** One itemized cost, formatted. */
export interface SinkingCostRow {
  /** Stable React key. The source id, which is never displayed. */
  readonly key: string;
  readonly label: string;
  readonly sourceLabel: string;
  /** True for the rows the two one-click actions apply to. */
  readonly editable: boolean;
  /** `planned_expenses.id`, for those rows' actions. */
  readonly sourceId: string;
  readonly dueDateDisplay: string;
  readonly amountDisplay: string;
  /** Whole months left before it lands. `0` on the due month. */
  readonly monthsRemaining: number;
  readonly perMonthDisplay: string;
  readonly requiredTodayDisplay: string;
  /** Still `planned`, and its due date has passed (ADR-043 §6). */
  readonly pastDue: boolean;
}

/**
 * Format the requirement's itemization for the table.
 *
 * @param requirement - The loader's requirement, already in stream order.
 * @param currency - The household's currency, for formatting only.
 * @returns One row per accrued cost, in the same order, so the table adds up to
 *   its own header.
 */
export function costRows(
  requirement: SinkingRequirement,
  currency: string,
): readonly SinkingCostRow[] {
  return requirement.costs.map((accrued) => ({
    key: accrued.cost.sourceId,
    label: accrued.cost.label,
    sourceLabel: sourceLabel(accrued.cost.source),
    editable: accrued.cost.source === "planned_expense",
    sourceId: accrued.cost.sourceId,
    dueDateDisplay: longDate(accrued.cost.dueDate),
    amountDisplay: Money.fromString(accrued.cost.amount, currency).format(),
    // A count, not money — subtraction on two integers the accrual already
    // clamped to `[0, totalMonths]`, so this cannot go negative.
    monthsRemaining: accrued.totalMonths - accrued.elapsedMonths,
    perMonthDisplay: Money.fromString(accrued.perMonth, currency).format(),
    requiredTodayDisplay: Money.fromString(accrued.requiredToday, currency).format(),
    pastDue: accrued.pastDue,
  }));
}

/**
 * The sentence PLAN18 states as the deliverable.
 *
 * > *"You should be holding $2,180 against the 4 known costs in the next 12
 * > months. Your reserve above your emergency-fund target is $600."*
 *
 * Both halves, in that order, and **nothing between them**. The requirement
 * comes first because it is the figure the household cannot get anywhere else;
 * the position comes second because it is only meaningful against the first.
 *
 * @param requirement - The loader's requirement.
 * @param availability - The loader's availability. `available` must be non-null
 *   — a caller with an unknown target renders the degradation instead.
 * @param currency - The household's currency.
 * @returns The two-sentence headline.
 */
export function sinkingHeadline(
  requirement: SinkingRequirement,
  availability: SinkingAvailability,
  currency: string,
): string {
  const required = Money.fromString(requirement.requiredToday, currency).format();
  const available = Money.fromString(availability.available ?? "0.00", currency).format();
  const costs = `${requirement.costCount} known ${requirement.costCount === 1 ? "cost" : "costs"}`;

  return `You should be holding ${required} against the ${costs} in the next ${SINKING_HORIZON_MONTHS} months. Your reserve above your emergency-fund target is ${available}.`;
}

/** Which way the household's position runs, so the page can lead with it. */
export type SinkingPosition = "gap" | "surplus" | "level";

/** The gap or the surplus, as one answer rather than two fields to compare. */
export interface SinkingVerdict {
  readonly position: SinkingPosition;
  /** The non-zero side's magnitude, formatted. `"$0.00"` when level. */
  readonly amountDisplay: string;
  /** One sentence naming what the figure means and what to do about it. */
  readonly sentence: string;
}

/**
 * Resolve the gap-or-surplus the page leads with.
 *
 * `gap` and `surplus` are mutually exclusive non-negative fields (see
 * {@link SinkingAvailability}), so this reads which one is non-zero rather than
 * inspecting a sign — the reason they were modelled that way.
 *
 * ── The surplus sentence does not say "spend it" ──────────────────────────
 * A surplus means the reserve covers both the emergency fund and every known
 * cost *as accrued so far*. It does not mean the money is spare: the costs are
 * still coming, and the per-month figure is what keeps the position true. The
 * copy says that rather than congratulating.
 *
 * @param requirement - The loader's requirement, for the per-month figure.
 * @param availability - The loader's availability.
 * @param currency - The household's currency.
 * @returns The position, its magnitude, and the sentence that qualifies it.
 */
export function sinkingVerdict(
  requirement: SinkingRequirement,
  availability: SinkingAvailability,
  currency: string,
): SinkingVerdict {
  const gap = Money.fromString(availability.gap ?? "0.00", currency);
  const surplus = Money.fromString(availability.surplus ?? "0.00", currency);
  const perMonth = Money.fromString(requirement.perMonth, currency).format();

  if (!gap.isZero()) {
    return {
      position: "gap",
      amountDisplay: gap.format(),
      sentence: `You are ${gap.format()} short of what these costs have already accrued. Setting aside ${perMonth} a month keeps the shortfall from growing.`,
    };
  }

  if (!surplus.isZero()) {
    return {
      position: "surplus",
      amountDisplay: surplus.format(),
      sentence: `Your reserve covers these costs and your emergency fund, with ${surplus.format()} to spare. The costs are still coming — ${perMonth} a month is what keeps that true.`,
    };
  }

  return {
    position: "level",
    amountDisplay: gap.format(),
    sentence: `Your reserve covers these costs exactly. ${perMonth} a month is what keeps it level as they come due.`,
  };
}

/** One recorded planned expense, as the manager renders and edits it. */
export interface PlannedExpenseView {
  readonly id: string;
  readonly label: string;
  /** Formatted for reading. */
  readonly amountDisplay: string;
  /**
   * The raw `numeric` string, for the edit field's `defaultValue`.
   *
   * The one unformatted money value that crosses to the client, and nothing
   * there parses it: it goes into an input and comes back as form data
   * (CLAUDE.md §Money).
   */
  readonly amount: string;
  readonly currency: string;
  /** `YYYY-MM-DD`, for the date input. */
  readonly dueDate: string;
  readonly dueDateDisplay: string;
  readonly accrualStartDate: string;
  readonly categoryId: string | null;
  readonly status: PlannedExpenseStatus;
  /** Free text the household wrote about itself. PII — never logged. */
  readonly notes: string | null;
  /** Still `planned` with its due date behind us (ADR-043 §6). */
  readonly pastDue: boolean;
}

/**
 * Map stored rows to the manager's view model.
 *
 * @param records - Every recorded cost, from the loader.
 * @param currency - The household's currency, for formatting only.
 * @param today - `YYYY-MM-DD`, for the past-due test. Passed in rather than
 *   read from the clock, so the page's "overdue" agrees with the figure's.
 * @returns One view per row, in the loader's order.
 */
export function plannedExpenseViews(
  records: readonly PlannedExpenseRecord[],
  currency: string,
  today: string,
): readonly PlannedExpenseView[] {
  return records.map((row) => ({
    id: row.id,
    label: row.label,
    amountDisplay: Money.fromString(row.amount, row.currency || currency).format(),
    amount: row.amount,
    currency: row.currency,
    dueDate: row.dueDate,
    dueDateDisplay: longDate(row.dueDate),
    accrualStartDate: row.accrualStartDate,
    categoryId: row.categoryId,
    status: row.status,
    notes: row.notes,
    // ISO dates compare correctly as strings, so no `Date` and no timezone.
    pastDue: row.status === "planned" && row.dueDate < today,
  }));
}
