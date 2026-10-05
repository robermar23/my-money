import type {
  ObligationAmountMode,
  ObligationDirection,
  ObligationOccurrenceStatus,
  ObligationSource,
} from "@/db/schema/index.ts";
import type {
  CashFlowDirection,
  CashFlowEvent,
  DailyProjectionPoint,
  ProjectionStatus,
} from "@/lib/cashflow/types.ts";
import { SINKING_HORIZON_MONTHS } from "@/lib/sinking/constants.ts";
import type { SinkingRequirement } from "@/lib/sinking/types.ts";

/**
 * The shapes and derivations behind `/plan/cashflow` (P16-31, P16-33, P16-34).
 *
 * Same contract `/plan/cashflow/review` established in its own
 * [view-models.ts](./review/view-models.ts): plain data crosses to the client,
 * no Drizzle values, no `Money`, and **every figure is formatted on the server**
 * — the browser never does arithmetic on a dollar amount (CLAUDE.md §Money).
 * The one exception is the chart island, which converts the signed closing
 * balance to a `number` because that is what Recharts plots; it is the final
 * display step and nothing is read back out of it.
 *
 * The functions here are pure and take their formatter as a parameter, so the
 * week bucketing and the tooltip's event filter are unit-testable without a
 * database, a clock, or a DOM.
 */

/** A `numeric` string in, a display string out. The page passes `Money.format`. */
export type MoneyFormatter = (amount: string) => string;

/** The occurrence columns this page reads. A structural subset of `UpcomingOccurrence`. */
export interface OccurrenceInput {
  readonly id: string;
  readonly obligationId: string;
  readonly label: string;
  readonly dueDate: string;
  readonly expectedAmount: string;
  readonly direction: ObligationDirection;
  readonly amountMode: ObligationAmountMode;
  readonly status: ObligationOccurrenceStatus;
  /** What actually posted, when the sweep matched one. Signed as stored. */
  readonly matchedAmount: string | null;
  /** Which door the obligation came through (ADR-047 §3). */
  readonly source: ObligationSource;
}

/** One bill or receipt as the upcoming list renders it. */
export interface OccurrenceView {
  readonly id: string;
  readonly obligationId: string;
  readonly label: string;
  readonly dueDate: string;
  /** Day of month, for the compact date column. */
  readonly dayLabel: string;
  readonly amountDisplay: string;
  readonly direction: ObligationDirection;
  readonly amountMode: ObligationAmountMode;
  readonly status: ObligationOccurrenceStatus;
  /** True when the amount shown is what posted rather than what was expected. */
  readonly actual: boolean;
  /**
   * True when this bill came from stated loan terms rather than from bank text
   * or a typed-in form (CF-A7).
   *
   * The list says so, because a household that never entered this bill by hand
   * will otherwise wonder where it came from — and "you told us the loan terms"
   * is a better answer than silence. It is also the row whose amount is most
   * worth a second look, since escrow moves it.
   */
  readonly fromLoanTerms: boolean;
}

/** A week's worth of occurrences under one heading. */
export interface WeekGroupView {
  /** Monday of the week, `YYYY-MM-DD`. Stable key. */
  readonly weekStart: string;
  readonly heading: string;
  readonly items: readonly OccurrenceView[];
}

/** The grouped list plus what the cap left out — never silently dropped. */
export interface GroupedOccurrences {
  readonly groups: readonly WeekGroupView[];
  readonly hiddenCount: number;
}

/** One dated event on a projected day, for the chart tooltip. */
export interface ChartEventView {
  readonly label: string;
  readonly amountDisplay: string;
  readonly direction: CashFlowDirection;
  /**
   * Which kind of event this is, carried so the tooltip can mark a one-off cost
   * (P18-29).
   *
   * The compiler does **not** force this: a `planned_expense` event satisfies
   * every field above, so the chart happily rendered a $4,000 roof looking
   * exactly like a recurring bill. That is the one thing a household must be
   * able to tell apart here — a cliff in the line that is a new roof is a
   * decision they already made, and a cliff that is the mortgage is not.
   */
  readonly kind: Exclude<CashFlowEvent["kind"], "discretionary">;
}

/** One day of the projection, as the chart island consumes it. */
export interface ProjectionPointView {
  readonly date: string;
  /** Signed `numeric` string. The island converts at the plotting edge. */
  readonly closing: string;
  /** Dated events only — see {@link toProjectionPoints}. */
  readonly events: readonly ChartEventView[];
}

/** A named gap in the inputs, with the screen that fills it (P16-33). */
export interface CashFlowNotice {
  /** `blocking` = there is no projection at all; `degraded` = there is one, qualified. */
  readonly tone: "blocking" | "degraded";
  readonly title: string;
  readonly body: string;
  readonly href: string;
  readonly linkLabel: string;
}

const MS_PER_DAY = 86_400_000;

/** Parse a calendar date as UTC midnight. Never `new Date(iso)` on a bare date. */
function utc(iso: string): Date {
  return new Date(`${iso}T00:00:00Z`);
}

const LONG_DATE = new Intl.DateTimeFormat("en-US", {
  month: "long",
  day: "numeric",
  timeZone: "UTC",
});

/**
 * Render a calendar date as a sentence fragment — `"March 14"`.
 *
 * Formatted in UTC deliberately. A `date` column is a calendar date, not an
 * instant; letting the server's local zone interpret it renders the 14th as the
 * 13th anywhere west of Greenwich, and the low-water date is the single figure
 * on this page a family plans around.
 *
 * @param iso - `YYYY-MM-DD`.
 * @returns The month and day, e.g. `"March 14"`.
 */
export function longDate(iso: string): string {
  return LONG_DATE.format(utc(iso));
}

/**
 * The Monday of the week a date falls in.
 *
 * Monday rather than Sunday because a household reads a bill calendar as a
 * working week, and because it puts the weekend — where discretionary spend
 * clusters — at the end of a row rather than split across two.
 *
 * @param iso - `YYYY-MM-DD`.
 * @returns `YYYY-MM-DD` of that week's Monday, possibly in the previous month.
 */
export function startOfWeek(iso: string): string {
  const date = utc(iso);
  // getUTCDay: 0 = Sunday. Shift so Monday is 0 and Sunday is 6.
  const offset = (date.getUTCDay() + 6) % 7;
  return new Date(date.getTime() - offset * MS_PER_DAY).toISOString().slice(0, 10);
}

export interface GroupOptions {
  /** How many weeks to render before collapsing the rest into a count. */
  readonly maxWeeks: number;
  readonly format: MoneyFormatter;
}

/**
 * Bucket occurrences into calendar weeks, newest first, with a stated cap.
 *
 * A year-long horizon produces fifty-two headings, which is a scrollbar rather
 * than a plan. The first few weeks are the ones a household can still act on, so
 * the rest are collapsed into a count that links to the full schedule — visible
 * as an omission rather than silently truncated.
 *
 * A MATCHED occurrence is displayed at what actually posted, not at its
 * snapshotted expectation (ADR-037 §5). Showing the expectation for a bill that
 * already cleared for a different amount would contradict the transactions page,
 * and the amount that left the account is the true one.
 *
 * @param rows - Occurrences inside the horizon, in any order.
 * @param today - `YYYY-MM-DD`, for the "This week" / "Next week" headings.
 * @param options - The week cap and the server-side money formatter.
 * @returns The rendered groups and the number of occurrences the cap hid.
 */
export function groupOccurrencesByWeek(
  rows: readonly OccurrenceInput[],
  today: string,
  options: GroupOptions,
): GroupedOccurrences {
  const sorted = [...rows].sort(
    (a, b) => a.dueDate.localeCompare(b.dueDate) || a.label.localeCompare(b.label),
  );

  const buckets = new Map<string, OccurrenceView[]>();
  for (const row of sorted) {
    const week = startOfWeek(row.dueDate);
    const bucket = buckets.get(week);
    const view = toOccurrenceView(row, options.format);
    if (bucket) bucket.push(view);
    else buckets.set(week, [view]);
  }

  const thisWeek = startOfWeek(today);
  const nextWeek = new Date(utc(thisWeek).getTime() + 7 * MS_PER_DAY).toISOString().slice(0, 10);

  const all = [...buckets.entries()].map(([weekStart, items]) => ({
    weekStart,
    heading:
      weekStart === thisWeek
        ? "This week"
        : weekStart === nextWeek
          ? "Next week"
          : `Week of ${longDate(weekStart)}`,
    items,
  }));

  const groups = all.slice(0, options.maxWeeks);
  const hiddenCount = all
    .slice(options.maxWeeks)
    .reduce((total, group) => total + group.items.length, 0);

  return { groups, hiddenCount };
}

/** One occurrence row, priced at reality when reality is known. */
function toOccurrenceView(row: OccurrenceInput, format: MoneyFormatter): OccurrenceView {
  const actual = row.status === "matched" && row.matchedAmount !== null;
  return {
    id: row.id,
    obligationId: row.obligationId,
    label: row.label,
    dueDate: row.dueDate,
    dayLabel: String(Number(row.dueDate.slice(8, 10))),
    // Non-null inside the branch by the `actual` guard above.
    amountDisplay: format(actual ? (row.matchedAmount as string) : row.expectedAmount),
    direction: row.direction,
    amountMode: row.amountMode,
    status: row.status,
    actual,
    fromLoanTerms: row.source === "liability",
  };
}

/**
 * Reduce the projection to what the chart island needs.
 *
 * **Discretionary events are dropped.** The residual is on every single day by
 * construction (ADR-038 §2), so listing it in a tooltip beside the mortgage
 * would read as a second bill and bury the dated events under sixty identical
 * rows. The chart states it once, in prose, beneath the axis instead — which is
 * also the honest description of what it is: a rate, not an event.
 *
 * **Every other kind is kept, including the one P18-28 added.** A recorded cost
 * inside the horizon is the single largest thing the projection is likely to
 * show, and it arrives with `kind` so the tooltip can mark it as a one-off
 * rather than let it read as a bill that will be back next month.
 *
 * @param points - The projection's daily points, in order.
 * @param format - Server-side money formatter.
 * @returns One view per day, with only the dated events.
 */
export function toProjectionPoints(
  points: readonly DailyProjectionPoint[],
  format: MoneyFormatter,
): ProjectionPointView[] {
  const out: ProjectionPointView[] = [];
  for (const point of points) {
    const events: ChartEventView[] = [];
    for (const event of point.events) {
      if (event.kind === "discretionary") continue;
      events.push({
        label: event.label,
        amountDisplay: format(event.amount),
        direction: event.direction,
        kind: event.kind,
      });
    }
    out.push({ date: point.date, closing: point.closing, events });
  }
  return out;
}

/**
 * The sinking-fund sentence at the foot of the bill list (P18-27, P18-29).
 *
 * Here rather than in the page for one reason: **it had a bug that markup
 * review did not catch.** P18-27 wrote it as *"Beyond this window, N known
 * costs…"*, which was true until P18-29 put the costs inside the window onto
 * the projection — and then the page counted the same roof twice while telling
 * the reader the second one was somewhere else. A sentence with two branches
 * and four pluralizations is logic, and logic that states a money figure
 * belongs where a test can read it back.
 *
 * It states the requirement and **nothing downstream of it**: no
 * emergency-fund target, no available figure (ADR-046 §9, ADR-048 §5). That is
 * enforced structurally by the page, which never computes either — this
 * function could not state them if it wanted to, because they are not in its
 * arguments.
 *
 * @param requirement - The sinking requirement over its own 12-month horizon.
 * @param horizonTo - The PROJECTION's inclusive far edge, `YYYY-MM-DD`. The
 *   comparison against it is a plain string compare, which is the same edge the
 *   projection's own window uses and so cannot drift from it by a timezone.
 * @param format - Server-side money formatter (CLAUDE.md §Money).
 * @returns The sentence, or `null` when nothing is recorded — a household with
 *   no costs gets no sentence rather than a `$0.00` that reads as a verdict.
 *   `/plan` is where an unrecorded cost list is named as a missing input.
 */
export function sinkingNoteSentence(
  requirement: SinkingRequirement,
  horizonTo: string,
  format: MoneyFormatter,
): string | null {
  if (requirement.costCount === 0) return null;

  const total = requirement.costCount;
  // Inclusive, and a plain string comparison: both sides are `YYYY-MM-DD`
  // (CLAUDE.md §Database), so this is the same edge the projection's own window
  // uses and cannot drift from it by a timezone.
  const inside = requirement.costs.filter((accrued) => accrued.cost.dueDate <= horizonTo).length;

  const lead =
    total === 1
      ? `Over the next ${SINKING_HORIZON_MONTHS} months, 1 known cost means you should already be holding ${format(requirement.requiredToday)} for it.`
      : `Over the next ${SINKING_HORIZON_MONTHS} months, ${total} known costs mean you should already be holding ${format(requirement.requiredToday)} for them.`;

  return `${lead} ${tail(total, inside)}`;
}

/**
 * Which of those costs the projection above has already charged.
 *
 * Four cases rather than interpolated plurals, because the one-cost household
 * is the common first case and *"All lands inside the window"* is the kind of
 * sentence that makes a reader distrust the figure beside it.
 */
function tail(total: number, inside: number): string {
  if (total === 1) {
    return inside === 1
      ? "It lands inside the window above and is already on the line."
      : "It falls beyond the window above.";
  }
  if (inside === 0) return "None of them land inside the window above.";
  if (inside === total) {
    return "All of them land inside the window above and are already on the line.";
  }
  const verb = inside === 1 ? "lands" : "land";
  const is = inside === 1 ? "is" : "are";
  return `${inside} of them ${verb} inside the window above and ${is} already on the line.`;
}

/** The half of the thin-history notice that never varies. */
const THIN_HISTORY_TAIL =
  "The bills you have confirmed still show below, so this is a schedule rather than a " +
  "forecast — it does not yet subtract what you spend day to day.";

/** The half of the run-rate notice that never varies. */
const RUN_RATE_LEAD =
  "No recurring bills are confirmed yet, so the line below carries your everyday spending " +
  "rate and nothing else — no rent, mortgage or subscriptions on the dates they actually land.";

export interface NoticeInput {
  readonly candidateCount: number;
  readonly historyMonths: number;
}

/**
 * The named gap for a degraded projection, or `null` when there is none.
 *
 * P16-33's standard, set by P15-37: an empty state names the missing input and
 * links to where to supply it. "No data available" is not a state this app
 * ships — it tells the user nothing they can act on and reads as a fault.
 *
 * `blocking` and `degraded` are a real distinction rather than styling. Without
 * an operating account there is no balance to walk forward from, so there is no
 * projection and the page must not draw one. The other two rungs produce a real
 * line that is simply narrower than it will be later, and hiding it would be
 * less useful than qualifying it.
 *
 * @param status - The ladder rung the loader landed on (ADR-038 §7).
 * @param input - The counts the copy quotes.
 * @returns The notice, or `null` at `ok`.
 */
export function cashFlowNotice(
  status: ProjectionStatus,
  input: NoticeInput,
): CashFlowNotice | null {
  switch (status) {
    case "no_operating_account":
      return {
        tone: "blocking",
        title: "No everyday account to project from",
        body:
          "A projection starts from the money you actually pay bills out of. No account is " +
          "marked as checking or cash management yet, so there is nothing to walk forward. " +
          "Savings is deliberately left out — spending your emergency fund is not headroom.",
        href: "/accounts",
        linkLabel: "Set an account subtype",
      };
    case "insufficient_history":
      return {
        tone: "degraded",
        title: "Not enough history for a spending rate yet",
        body: `You have ${input.historyMonths} ${
          input.historyMonths === 1 ? "month" : "months"
        } of transactions, and an everyday-spending rate needs three. ${THIN_HISTORY_TAIL}`,
        href: "/accounts",
        linkLabel: "Import older statements",
      };
    case "run_rate_only":
      return {
        tone: "degraded",
        title: "This is your spending pace, with no bills on the calendar",
        body: `${RUN_RATE_LEAD} ${
          input.candidateCount > 0
            ? `${input.candidateCount} ${
                input.candidateCount === 1 ? "suggestion is" : "suggestions are"
              } waiting for you to confirm.`
            : "Confirming a few is what turns this into a calendar."
        }`,
        href: "/plan/cashflow/review",
        linkLabel: "Review recurring bills",
      };
    default:
      return null;
  }
}
