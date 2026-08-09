import type { OverBudgetLine, SpendingCard as SpendingCardData } from "@/lib/dashboard/loader.ts";
import type { Money } from "@/lib/money/money.ts";
import Link from "next/link";
import { DashboardCard } from "./card.tsx";

/**
 * Spending-vs-budget card (Phase 13, P13-09, ADR-029).
 *
 * This month's total spend against this month's total budget as a progress bar,
 * the run-rate end-of-month projection (`runRateToMonthEnd` via `budgetVsActual`
 * — ADR-029 §4: no new math here), and the top over-budget categories. Pure
 * presentation: every figure arrives pre-computed as {@link Money} from
 * `loadDashboard`, so the card's numbers are identical by construction to
 * `/analysis/budgets`. Degrades in two steps (ADR-029 §5): no spend *and* no
 * budgets ⇒ the calm empty state; spend but no budgets ⇒ the total plus a
 * "Set budgets" nudge rather than a meaningless 0%-of-0 bar.
 */

interface Props {
  readonly data: SpendingCardData;
  /** Grid column span assigned by the dashboard layout (P13-14). */
  readonly className?: string;
}

const CARD_TITLE = "Spending";
const DEEP_LINK = "/analysis";
const BUDGETS_LINK = "/analysis/budgets";

/** "2026-08" → "August 2026" (UTC — the month key carries no time zone). */
function monthLabel(month: string): string {
  const parsed = new Date(`${month}-01T00:00:00Z`);
  return parsed.toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

/**
 * Ratio of a money value to the budget, as a display percent.
 *
 * Money math already happened upstream; a bar width is display-only geometry, so
 * `Number()` at this edge is the documented exception (§Money & Numeric
 * Precision).
 *
 * @param value - The figure to measure.
 * @param budget - The month's total budget.
 * @returns The percent, or null when the budget is zero (nothing to measure against).
 */
function percentOf(value: Money, budget: Money): number | null {
  const denominator = Number(budget.toString());
  if (!(denominator > 0)) return null;
  return (Number(value.toString()) / denominator) * 100;
}

/** Spend-vs-budget progress bar with a run-rate projection tick. */
function BudgetBar({
  spend,
  budget,
  projected,
}: {
  readonly spend: Money;
  readonly budget: Money;
  readonly projected: Money | null;
}): React.JSX.Element {
  const spentPct = percentOf(spend, budget) ?? 0;
  const over = spend.sub(budget);
  const isOver = !over.isNegative() && !over.isZero();
  const projectedPct = projected === null ? null : percentOf(projected, budget);
  const projectedOver = projected === null ? false : !projected.sub(budget).isNegative();

  return (
    <>
      {/* Visual only — the figures below carry the meaning for screen readers
          (same posture as the budget rows on /analysis/budgets). */}
      <div
        className="relative mt-3 h-2 w-full overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800"
        aria-hidden
      >
        <div
          className={`h-full ${isOver ? "bg-red-500" : "bg-emerald-500"}`}
          style={{ width: `${Math.min(spentPct, 100)}%` }}
        />
        {projectedPct !== null && (
          <div
            className={`absolute top-[-1px] bottom-[-1px] w-0.5 ${
              projectedOver ? "bg-red-700" : "bg-zinc-500"
            }`}
            style={{ left: `calc(${Math.min(projectedPct, 100)}% - 1px)` }}
            aria-hidden
          />
        )}
      </div>
      <p className="mt-2 text-xs text-zinc-500">
        {spend.format()} of {budget.format()} budgeted
        <span
          className={
            isOver
              ? "ml-2 text-red-600 dark:text-red-400"
              : "ml-2 text-emerald-600 dark:text-emerald-400"
          }
        >
          {isOver ? `${over.format()} over` : `${over.negate().format()} left`}
        </span>
      </p>
    </>
  );
}

/** The top over-budget categories, largest overage first. */
function OverBudgetList({
  lines,
}: { readonly lines: readonly OverBudgetLine[] }): React.JSX.Element {
  return (
    <ul className="mt-3 space-y-1 border-zinc-100 border-t pt-3 text-sm dark:border-zinc-900">
      {lines.map((line) => (
        <li key={line.categoryId} className="flex items-baseline justify-between gap-2">
          <span className="truncate text-zinc-600 dark:text-zinc-400">{line.name}</span>
          <span className="shrink-0 font-mono text-red-600 text-xs tabular-nums dark:text-red-400">
            {line.over.format()} over
          </span>
        </li>
      ))}
    </ul>
  );
}

export function SpendCard({ data, className }: Props): React.JSX.Element {
  if (data.status === "empty") {
    return (
      <DashboardCard
        title={CARD_TITLE}
        href={DEEP_LINK}
        linkLabel="Analysis →"
        className={className}
      >
        <DashboardCard.Empty
          message="No spending recorded yet."
          href={BUDGETS_LINK}
          linkLabel="Set budgets"
        />
      </DashboardCard>
    );
  }

  return (
    <DashboardCard title={CARD_TITLE} href={DEEP_LINK} linkLabel="Analysis →" className={className}>
      <div className="flex items-baseline justify-between gap-3">
        <div className="font-mono text-2xl tabular-nums">{data.totalSpend.format()}</div>
        <div className="text-right text-xs text-zinc-500">{monthLabel(data.month)}</div>
      </div>

      {data.hasBudgets ? (
        <BudgetBar spend={data.totalSpend} budget={data.totalBudget} projected={data.projected} />
      ) : (
        <p className="mt-2 text-sm text-zinc-500">
          No budgets set this month.{" "}
          <Link href={BUDGETS_LINK} className="underline">
            Set budgets →
          </Link>
        </p>
      )}

      {data.projected !== null && (
        <p className="mt-2 text-xs text-zinc-400">
          ~{data.projected.format()} projected at the current run-rate
        </p>
      )}

      {data.overBudget.length > 0 && <OverBudgetList lines={data.overBudget} />}
    </DashboardCard>
  );
}
