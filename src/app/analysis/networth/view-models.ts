import { Money } from "@/lib/money/money.ts";
import type {
  AttributionResult,
  AttributionRungId,
  AttributionStatus,
} from "@/lib/net-worth/types.ts";

/**
 * The shapes and derivations behind `/analysis/networth` (P17-20, P17-21,
 * P17-22).
 *
 * Same contract `/plan/cashflow` established in its own
 * [view-models.ts](../../plan/cashflow/view-models.ts): plain data crosses to
 * the client, no Drizzle values, no `Money`, and the browser never does
 * arithmetic on a dollar amount (CLAUDE.md §Money). The waterfall's cumulative
 * positions are computed **here**, with `Money`, and handed across as strings;
 * the island's only job is `Number()` at the plotting call.
 *
 * Pure and I/O-free, so the bar geometry, the ordering rule, and every degraded
 * state are unit-testable without a database or a DOM.
 */

/** A `numeric` string in, a display string out. The page passes `Money.format`. */
export type MoneyFormatter = (amount: string) => string;

/**
 * How a bar reads, which is not the same question as which way it points.
 *
 * `unknown` exists because `unexplained` is neither good nor bad (ADR-039 §4).
 * Colouring it with the gain palette would tell a household that money they
 * cannot account for is money they made.
 */
export type BarTone = "anchor" | "up" | "down" | "unknown";

/** One bar of the waterfall, positioned but not yet plotted. */
export interface WaterfallBar {
  /** Stable React key. `"opening"`, `"closing"`, or the rung id. */
  readonly key: string;
  /** Axis label. Short — it has to survive a phone's width. */
  readonly label: string;
  /** Bar's lower edge as a `numeric` string. Signed; may be negative. */
  readonly start: string;
  /** Bar's upper edge as a `numeric` string. Signed; may be negative. */
  readonly end: string;
  /** The rung's own signed amount, or the anchor's total. Pre-formatted. */
  readonly amountDisplay: string;
  readonly tone: BarTone;
}

/** The page-level notice, above the figure it qualifies. */
export interface AttributionNotice {
  /** `blocking` suppresses the chart and the rung table entirely. */
  readonly tone: "blocking" | "degraded";
  readonly title: string;
  readonly body: string;
  readonly href: string;
  readonly linkLabel: string;
}

/**
 * Statuses that may state a decomposition at all.
 *
 * The `STATED_FIGURE_STATUSES` shape from
 * [cashflow/status.ts](../../../lib/cashflow/status.ts), for the same reason:
 * the page asks "may I draw this?" in one place rather than re-deriving the
 * answer beside every element that depends on it.
 */
export const STATED_ATTRIBUTION_STATUSES: readonly AttributionStatus[] = [
  "ok",
  "insufficient_history",
] as const;

/** The half of the `insufficient_history` sentence that carries no date. */
const INSUFFICIENT_HISTORY_TAIL =
  "The starting figure is measured against an empty book, so the change below reads as a much " +
  "larger gain than anything that actually happened. Shorten the window, or import older statements.";

/** Short axis labels. The rung's own label is the long form, shown in the table. */
const SHORT_LABELS: Readonly<Record<AttributionRungId, string>> = {
  saved: "Saved",
  retirement: "Retirement",
  debt_principal: "Debt paid",
  investment_return: "Market",
  asset_revaluation: "Property",
  unexplained: "Unexplained",
};

/**
 * Turn a decomposition into positioned waterfall bars.
 *
 * Each rung's bar spans from the running total before it to the running total
 * after it, so the bars physically chain: the household can see the closing
 * anchor land exactly where the last rung left off. That is only true because
 * the identity holds exactly (`decompose.invariant.test.ts`) — a float anywhere
 * in this walk would show up as a visible gap, which is the honest failure mode
 * and the reason the walk is done with `Money` here rather than with `Number`
 * inside the chart.
 *
 * A zero rung still gets a bar. It renders as a hairline and its row in the
 * table carries the audit trail: "we checked and it was nothing" and "we did
 * not look" must stay distinguishable (ADR-039 §5).
 *
 * @param result - A decomposition from `decomposeNetWorth`.
 * @param format - Money formatter, normally `Money.format`.
 * @param currency - Currency the amounts are in. Single-currency app; USD.
 * @returns Opening anchor, the six rungs in narrative order, closing anchor.
 */
export function waterfallBars(
  result: AttributionResult,
  format: MoneyFormatter,
  currency = "USD",
): WaterfallBar[] {
  const zero = Money.zero(currency);
  const opening = Money.fromString(result.opening, currency);

  const bars: WaterfallBar[] = [
    {
      key: "opening",
      label: "Start",
      start: zero.toString(),
      end: opening.toString(),
      amountDisplay: format(result.opening),
      tone: "anchor",
    },
  ];

  let running = opening;
  for (const rung of result.rungs) {
    const amount = Money.fromString(rung.amount, currency);
    const next = running.add(amount);
    bars.push({
      key: rung.id,
      label: SHORT_LABELS[rung.id],
      start: running.toString(),
      end: next.toString(),
      amountDisplay: format(rung.amount),
      tone: barTone(rung.id, amount),
    });
    running = next;
  }

  bars.push({
    key: "closing",
    label: "End",
    start: zero.toString(),
    // `running`, not `result.closing`: they are equal by the identity, and
    // plotting the walk's own endpoint means a broken identity would be VISIBLE
    // as a bar that misses the axis rather than silently corrected here.
    end: running.toString(),
    amountDisplay: format(running.toString()),
    tone: "anchor",
  });

  return bars;
}

function barTone(id: AttributionRungId, amount: Money): BarTone {
  if (id === "unexplained") return "unknown";
  if (amount.isZero()) return "up";
  return amount.isNegative() ? "down" : "up";
}

/**
 * The named gap, above the figure it qualifies (P17-22, P16-33's rule).
 *
 * Only `no_snapshots` blocks. `insufficient_history` renders everything with
 * its rung named, because the arithmetic is still correct — what is wrong is
 * the *opening endpoint*, and saying so is far more useful than hiding a page
 * the household came to specifically to ask a question.
 *
 * @param status - The ladder's verdict (P17-14).
 * @param from - Window start, for the sentence.
 * @returns The notice, or `null` when nothing needs qualifying.
 */
export function attributionNotice(
  status: AttributionStatus,
  from: string,
): AttributionNotice | null {
  switch (status) {
    case "no_snapshots":
      return {
        tone: "blocking",
        title: "No balances recorded yet",
        body:
          "Explaining a change in net worth needs a figure at each end of the window, and no " +
          "account balance has been recorded on or before this one closes. Nothing here is " +
          "broken — the app simply has not been told what anything is worth yet.",
        href: "/accounts",
        linkLabel: "Enter a balance",
      };
    case "insufficient_history":
      return {
        tone: "degraded",
        title: "This window starts before your records do",
        body: `The app has no balance on or before ${longDate(from)}. ${INSUFFICIENT_HISTORY_TAIL}`,
        href: "/accounts",
        linkLabel: "Import older statements",
      };
    default:
      return null;
  }
}

/**
 * `"2026-03-14"` → `"March 14, 2026"`, in UTC so a stored date never shifts.
 *
 * Duplicated from the cash-flow surface rather than shared, deliberately: it is
 * four lines, and a `dates.ts` that every page imports is how one screen's
 * formatting choice quietly becomes every screen's.
 */
export function longDate(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}
