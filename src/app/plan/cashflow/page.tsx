import { requireUser } from "@/lib/auth/require-user.ts";
import { loadCashFlow } from "@/lib/cashflow/loader.ts";
import { STATED_FIGURE_STATUSES } from "@/lib/cashflow/status.ts";
import { Money } from "@/lib/money/money.ts";
import type { Metadata } from "next";
import Link from "next/link";
import { InputsUsed } from "../inputs-used.tsx";
import { ProjectionChart } from "./projection-chart.tsx";
import {
  type CashFlowNotice,
  type OccurrenceView,
  type WeekGroupView,
  cashFlowNotice,
  groupOccurrencesByWeek,
  longDate,
  toProjectionPoints,
} from "./view-models.ts";

/**
 * `/plan/cashflow` — the projection surface (P16-31, P16-33, P16-34, ADR-038).
 *
 * Server component, `requireUser`-guarded, one `loadCashFlow()` call. Every
 * figure on the page was computed by the engine and formatted here; the only
 * client code is the chart island (ADR-005), and it receives display strings
 * plus one number to plot.
 *
 * ── The page is honest before it is useful ─────────────────────────────────
 * Same ordering `/plan` uses, and for the same reason: the degradation notice
 * sits ABOVE the figure it qualifies, not below it. A household reading
 * "$1,240 safe to spend" needs to know before they read it that no bills are on
 * the calendar yet — afterwards is too late, because the number is what they
 * will remember.
 *
 * ── What a safe-to-spend figure is, said out loud ──────────────────────────
 * It is not a balance and it is not an allowance. It is how much MORE than usual
 * the household can spend over a stated window without going below a floor they
 * chose — everyday spending is already inside the line (ADR-038 §2). A figure
 * that large, unqualified, would be read as "you have $1,240 spare", which is a
 * different and much more dangerous claim. So the horizon and the floor are
 * never more than a sentence away from the number, in every state.
 *
 * ── Four rungs, three of which still render something ──────────────────────
 * Only `no_operating_account` blocks the page: with no everyday account there is
 * no balance to walk forward and drawing a line from savings would be a lie
 * (ADR-038 §6). `insufficient_history` renders the calendar without the headline
 * figure — a schedule, labelled as one. `run_rate_only` renders everything, with
 * its rung named. Each names its missing input and links to the fix (P16-33).
 *
 * Zero egress; no figure is logged (CLAUDE.md §Privacy).
 */

export const metadata: Metadata = { title: "Cash flow" };

/** How many weeks of bills to list before collapsing the rest into a count. */
const WEEKS_SHOWN = 6;

const CURRENCY = "USD";

/** Format a stored `numeric` string for display. The only place this happens. */
function money(amount: string): string {
  return Money.fromString(amount, CURRENCY).format();
}

export default async function CashFlowPage(): Promise<React.JSX.Element> {
  await requireUser();

  const snapshot = await loadCashFlow();
  const { projection } = snapshot;

  const notice = cashFlowNotice(projection.status, {
    candidateCount: snapshot.candidateCount,
    historyMonths: snapshot.historyMonths,
  });
  const blocked = notice?.tone === "blocking";
  const statesFigure = STATED_FIGURE_STATUSES.includes(projection.status);

  const points = toProjectionPoints(projection.points, money);
  const upcoming = groupOccurrencesByWeek(snapshot.occurrences, snapshot.from, {
    maxWeeks: WEEKS_SHOWN,
    format: money,
  });

  return (
    <main className="mx-auto max-w-4xl p-6">
      <Link href="/plan" className="text-sm text-zinc-500 hover:underline">
        ← Guidance
      </Link>
      <h1 className="mt-2 font-semibold text-2xl tracking-tight">Cash flow</h1>
      <p className="mt-1 max-w-2xl text-sm text-zinc-500">
        What your everyday accounts are projected to do between {longDate(snapshot.from)} and{" "}
        {longDate(snapshot.to)}, from balances, bills and spending already recorded here. Nothing is
        fetched and nothing leaves this machine.
      </p>

      {notice !== null && <Notice notice={notice} />}

      {!blocked && (
        <>
          {statesFigure && (
            <Headline
              safeToSpend={projection.safeToSpend}
              lowWater={projection.lowWaterMark}
              horizonDays={projection.horizonDays}
              to={snapshot.to}
              coverage={projection.coverage}
              runRateOnly={projection.status === "run_rate_only"}
            />
          )}

          <section aria-labelledby="projection-heading" className="mt-8">
            <h2 id="projection-heading" className="font-medium">
              Day by day
            </h2>
            <p className="mt-1 max-w-2xl text-sm text-zinc-600 dark:text-zinc-400">
              Your everyday spending is spread evenly across every day, so it is inside this line
              rather than listed as an event. Hover a day to see the bills and pay that land on it.
            </p>
            <div className="mt-3">
              <ProjectionChart
                points={points}
                currency={CURRENCY}
                floor={projection.cashFloor}
                lowWaterDate={projection.lowWaterMark?.date ?? null}
              />
            </div>
          </section>

          <Upcoming grouped={upcoming} />
        </>
      )}

      <section className="mt-10 border-zinc-200 border-t pt-4 dark:border-zinc-800">
        <h2 className="font-medium text-sm">Where these numbers came from</h2>
        <p className="mt-1 max-w-2xl text-sm text-zinc-500">
          If a figure here looks wrong, one of these inputs is the reason. Each links to the screen
          that fixes it.
        </p>
        <InputsUsed inputs={projection.inputsUsed} label="Computed from" />
      </section>
    </main>
  );
}

/** The named gap above the figure it qualifies (P16-33). */
function Notice({ notice }: { readonly notice: CashFlowNotice }): React.JSX.Element {
  const blocking = notice.tone === "blocking";
  return (
    <section
      className={`mt-6 rounded-lg border p-4 ${
        blocking
          ? "border-zinc-200 border-dashed dark:border-zinc-800"
          : "border-amber-300 bg-amber-50/50 dark:border-amber-900 dark:bg-amber-950/20"
      }`}
    >
      <h2 className="font-medium text-sm">{notice.title}</h2>
      <p className="mt-1 max-w-2xl text-sm text-zinc-600 dark:text-zinc-400">{notice.body}</p>
      <Link href={notice.href} className="mt-2 inline-block text-sm underline">
        {notice.linkLabel} →
      </Link>
    </section>
  );
}

interface HeadlineProps {
  readonly safeToSpend: {
    readonly amount: string;
    readonly floor: string;
    readonly clampedAtZero: boolean;
    readonly shortfall: string | null;
  };
  readonly lowWater: { readonly date: string; readonly balance: string } | null;
  readonly horizonDays: number;
  readonly to: string;
  readonly coverage: string | null;
  readonly runRateOnly: boolean;
}

/**
 * Safe-to-spend and the low-water mark, as sentences (P16-34).
 *
 * The shortfall branch is not the same sentence with a minus sign. "You could
 * spend $0" is technically the clamped figure and tells a household nothing;
 * what they need is how far short they are and on which day, because those are
 * the two facts that decide whether to move money this week (ADR-038 §5).
 */
function Headline({
  safeToSpend,
  lowWater,
  horizonDays,
  to,
  coverage,
  runRateOnly,
}: HeadlineProps): React.JSX.Element {
  const floor = Money.fromString(safeToSpend.floor, CURRENCY);
  const hasFloor = !floor.isZero();

  return (
    <section aria-labelledby="headline-heading" className="mt-8">
      <h2 id="headline-heading" className="font-medium text-sm text-zinc-500">
        {safeToSpend.clampedAtZero ? "Projected shortfall" : "Safe to spend"}
      </h2>

      {safeToSpend.clampedAtZero ? (
        <>
          <div className="mt-1 font-mono text-4xl text-red-600 tabular-nums dark:text-red-400">
            {safeToSpend.shortfall === null ? "Short" : money(safeToSpend.shortfall)}
          </div>
          <p className="mt-2 max-w-2xl text-zinc-700 dark:text-zinc-300">
            {lowWater === null
              ? `Your balance is projected to fall below ${
                  hasFloor ? `your ${floor.format()} cushion` : "zero"
                } inside the next ${horizonDays} days.`
              : hasFloor
                ? `You are projected to be ${money(safeToSpend.shortfall ?? "0.00")} below your ${floor.format()} cushion on ${longDate(lowWater.date)}, when your balance reaches ${money(lowWater.balance)}.`
                : `You are projected to run out of money on ${longDate(lowWater.date)}, reaching ${money(lowWater.balance)}.`}
          </p>
          <p className="mt-2 max-w-2xl text-sm text-zinc-500">
            That is before any extra spending. Moving a bill, or moving money in before then, is
            what closes it.
          </p>
        </>
      ) : (
        <>
          <div className="mt-1 font-mono text-4xl tabular-nums">{money(safeToSpend.amount)}</div>
          <p className="mt-2 max-w-2xl text-zinc-700 dark:text-zinc-300">
            You could spend {money(safeToSpend.amount)} on top of your usual spending between now
            and {longDate(to)}
            {hasFloor
              ? ` and still keep ${floor.format()} in the bank.`
              : " without running out of money."}
          </p>
          {lowWater !== null && (
            <p className="mt-2 max-w-2xl text-zinc-700 dark:text-zinc-300">
              Your lowest projected balance is {money(lowWater.balance)} on{" "}
              {longDate(lowWater.date)}.
            </p>
          )}
        </>
      )}

      <p className="mt-3 text-sm text-zinc-500">
        Over {horizonDays} days
        {hasFloor ? `, against the ${floor.format()} cushion you set` : ", with no cushion set"}.{" "}
        {runRateOnly ? (
          <>Your spending pace only — no bills are dated on this line yet.</>
        ) : (
          coverage !== null && <Coverage coverage={coverage} />
        )}
      </p>
    </section>
  );
}

/**
 * How much of recent spending the calendar actually accounts for.
 *
 * Shown always rather than only when thin, because the number is a caveat either
 * way and a caveat that appears only sometimes reads as an alarm. `Number()` on
 * a dimensionless ratio at the display edge — not money (CLAUDE.md §Money).
 */
function Coverage({ coverage }: { readonly coverage: string }): React.JSX.Element {
  const pct = Math.round(Number(coverage) * 100);
  return (
    <span className={pct < 25 ? "text-amber-700 dark:text-amber-400" : undefined}>
      {pct}% of your recent spending is bills this calendar knows about
      {pct < 25 ? " — confirming more sharpens the dates." : "."}
    </span>
  );
}

/** Status wording for an occurrence that is no longer merely scheduled. */
const STATUS_NOTE: Readonly<Record<OccurrenceView["status"], string | null>> = {
  scheduled: null,
  matched: "posted",
  missed: "did not post",
  skipped: "skipped",
};

const STATUS_TONE: Readonly<Record<OccurrenceView["status"], string>> = {
  scheduled: "",
  matched: "text-emerald-700 dark:text-emerald-400",
  missed: "text-amber-700 dark:text-amber-400",
  skipped: "text-zinc-500",
};

/** The upcoming schedule, grouped by week, with what the cap left out counted. */
function Upcoming({ grouped }: { readonly grouped: ReturnType<typeof groupOccurrencesByWeek> }) {
  return (
    <section aria-labelledby="upcoming-heading" className="mt-10">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="upcoming-heading" className="font-medium">
          What is coming
        </h2>
        <Link href="/plan/cashflow/review" className="text-sm text-zinc-500 hover:underline">
          Manage recurring bills →
        </Link>
      </div>

      {grouped.groups.length === 0 ? (
        <p className="mt-3 rounded-lg border border-zinc-200 border-dashed p-6 text-center text-sm text-zinc-500 dark:border-zinc-800">
          No bills are dated inside this window. Confirming a recurring bill is what puts one here.
        </p>
      ) : (
        <>
          <div className="mt-3 space-y-6">
            {grouped.groups.map((group) => (
              <WeekGroup key={group.weekStart} group={group} />
            ))}
          </div>
          {grouped.hiddenCount > 0 && (
            <p className="mt-4 text-sm text-zinc-500">
              {grouped.hiddenCount} more {grouped.hiddenCount === 1 ? "bill falls" : "bills fall"}{" "}
              later in the window.
            </p>
          )}
        </>
      )}
    </section>
  );
}

/** One week's bills. */
function WeekGroup({ group }: { readonly group: WeekGroupView }): React.JSX.Element {
  return (
    <div>
      <h3 className="font-medium text-sm text-zinc-500">{group.heading}</h3>
      <ul className="mt-2 divide-y divide-zinc-100 dark:divide-zinc-900">
        {group.items.map((item) => (
          <li key={item.id} className="flex items-baseline gap-3 py-2 text-sm">
            <span className="w-6 shrink-0 text-right font-mono text-zinc-500 tabular-nums">
              {item.dayLabel}
            </span>
            <span className="grow">
              {item.label}
              {item.amountMode === "trailing_median" && (
                <span className="ml-2 text-xs text-zinc-500">varies</span>
              )}
              {STATUS_NOTE[item.status] !== null && (
                <span className={`ml-2 text-xs ${STATUS_TONE[item.status]}`}>
                  {STATUS_NOTE[item.status]}
                </span>
              )}
            </span>
            <span
              className={`shrink-0 font-mono tabular-nums ${
                item.direction === "inflow" ? "text-emerald-700 dark:text-emerald-400" : ""
              }`}
            >
              {item.direction === "inflow" ? "+" : "−"}
              {item.amountDisplay.replace("-", "")}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
