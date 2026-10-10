import { requireUser } from "@/lib/auth/require-user.ts";
import { loadCashFlow } from "@/lib/cashflow/loader.ts";
import type { ShortfallClose } from "@/lib/cashflow/shortfall-close.ts";
import { STATED_FIGURE_STATUSES } from "@/lib/cashflow/status.ts";
import { Money } from "@/lib/money/money.ts";
import { loadKnownFutureCosts } from "@/lib/sinking/queries.ts";
import { sinkingHorizon, sinkingRequirement } from "@/lib/sinking/requirement.ts";
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
  sinkingNoteSentence,
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
 * ── The sinking-fund sentence, and what it may not say ───────────────────
 * P18-27, bound by ADR-046 §9 and ADR-048 §5. A household looking at dated
 * money is already asking the question, so one sentence names what their known
 * irregular costs require and links to `/plan/sinking`. It states **no**
 * emergency-fund target and **no** available figure — that pairing is the other
 * page's answer, and ADR-048 §5 gives the reason: `reserveMonthsFor()` needs a
 * full `AdviceInput`, and reaching for one here is precisely how a second
 * implementation of "how many months" gets written.
 *
 * So this page composes the requirement and **nothing downstream of it**: two
 * indexed queries into the same `sinkingRequirement` the other two surfaces
 * call. It cannot disagree about the figure, and it cannot state the half it is
 * forbidden to state, because it never computes it.
 *
 * P18-29 gave the sentence a second job. Recorded costs now land on the
 * projection as events, so the sentence has to say which of them are already on
 * the line and which are still past its edge — see {@link SinkingNote}.
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

  // One clock for the page. `loadCashFlow` would default to the same date, but
  // two independent `new Date()` calls can straddle midnight, and the bills
  // list and the sinking sentence would then be dated a day apart.
  const today = new Date().toISOString().slice(0, 10);
  const [snapshot, knownFutureCosts] = await Promise.all([
    loadCashFlow({ today }),
    loadKnownFutureCosts(today),
  ]);
  const sinking = sinkingRequirement(knownFutureCosts, today, sinkingHorizon(today, CURRENCY));
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
              close={snapshot.shortfallClose}
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

          <Upcoming grouped={upcoming} sinking={sinking} horizonTo={snapshot.to} />
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
  /** What would close the shortfall, when there is one (ADR-048). */
  readonly close: ShortfallClose | null;
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
  close,
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
          <ShortfallClosing close={close} by={lowWater?.date ?? null} />
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
 * What would actually close the shortfall (P16-34 revised, ADR-048).
 *
 * The line this replaces named the fix — *"moving money in before then"* —
 * **without checking whether the household could perform it**, which is the
 * difference between advice and a slogan. One display was serving two opposite
 * situations: for a family with a funded emergency fund it over-alarmed, and for
 * one without it under-stated a real solvency problem.
 *
 * Four branches, because there are four different sentences:
 *
 *   - **covered** — a TIMING problem. Name the transfer, the date, and what is
 *     left afterwards, so the household can act today.
 *   - **partly covered** — the reserve helps and does not finish. What is still
 *     short is the number that matters, so it is the one in the sentence.
 *   - **uncovered** — a SOLVENCY problem, and the app says so plainly rather
 *     than gesturing at money that is not there.
 *   - **reserve unknown** — the app does not know where the cash sits, so it
 *     refuses to guess (ADR-033 §1) and links to the screen that fixes it.
 *
 * ── What this deliberately does not say ────────────────────────────────────
 * **No emergency-fund target.** Whether what remains is still *enough* is
 * `/plan`'s question, answered there against a full `AdviceInput`; computing a
 * second "how many months" here is how two numbers come to disagree on one
 * screen (ADR-048 §5). **No transfer button, and no offer to make one** — money
 * movement is permanently out of scope. This is a sentence about a number, not
 * an instruction.
 */
function ShortfallClosing({
  close,
  by,
}: {
  readonly close: ShortfallClose | null;
  readonly by: string | null;
}): React.JSX.Element {
  const deadline = by === null ? "then" : longDate(by);

  // No classification: the projection is short but nobody asked what covers it.
  // The original sentence, which is true in every case and useful in none of
  // them — the honest fallback rather than a guess about the reserve.
  if (close === null) {
    return (
      <p className="mt-2 max-w-2xl text-sm text-zinc-500">
        That is before any extra spending. Moving a bill, or moving money in before then, is what
        closes it.
      </p>
    );
  }

  if (close.kind === "reserve_unknown") {
    return (
      <p className="mt-2 max-w-2xl text-sm text-zinc-500">
        {close.unclassifiedCount === 1
          ? "One of your cash accounts is not classified yet"
          : `${close.unclassifiedCount} of your cash accounts are not classified yet`}
        , so this page cannot tell whether your savings would cover this.{" "}
        <Link href="/accounts" className="underline">
          Say which accounts are savings
        </Link>{" "}
        and it will.
      </p>
    );
  }

  if (close.kind === "uncovered") {
    return (
      <p className="mt-2 max-w-2xl text-sm text-zinc-500">
        {close.reserveAccountCount === 0
          ? "No savings account is set up here, so there is nothing on file to move in."
          : "Your savings accounts have nothing in them to move across."}{" "}
        Closing this needs a bill to move, spending to come down, or money from somewhere this app
        does not track.
      </p>
    );
  }

  if (close.kind === "partly_covered") {
    return (
      <p className="mt-2 max-w-2xl text-sm text-zinc-500">
        Your savings would help but not finish it: moving all {money(close.reserveTotal)} in before{" "}
        {deadline} still leaves you {money(close.stillShort)} short. A bill has to move, or spending
        has to come down.
      </p>
    );
  }

  return (
    <p className="mt-2 max-w-2xl text-sm text-zinc-500">
      Your savings covers this. Moving {money(close.transferAmount)} in before {deadline} keeps you
      above the line, and leaves {money(close.remainingAfterTransfer)} of your{" "}
      {money(close.reserveTotal)} in savings.{" "}
      <Link href="/plan" className="underline">
        Whether that is still enough
      </Link>{" "}
      is a separate question.
    </p>
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
function Upcoming({
  grouped,
  sinking,
  horizonTo,
}: {
  readonly grouped: ReturnType<typeof groupOccurrencesByWeek>;
  readonly sinking: ReturnType<typeof sinkingRequirement>;
  readonly horizonTo: string;
}) {
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

      <SinkingNote sinking={sinking} horizonTo={horizonTo} />
    </section>
  );
}

/**
 * The one sentence Phase 18 adds here (P18-27, ADR-046 §9 / ADR-048 §5).
 *
 * A household reading a bill calendar is already asking what the costs *past*
 * the horizon need, so the answer goes where the question is asked rather than
 * waiting to be discovered under Planning. One sentence, one link.
 *
 * It names the requirement and the horizon, and **says nothing about the
 * emergency-fund target or what is available against it** — that pairing is
 * `/plan/sinking`'s answer, and this component cannot state it because the page
 * never computes it (see the module header).
 *
 * Silent when nothing is recorded: a household with no planned costs gets no
 * sentence here rather than a $0.00 that reads as a verdict. `/plan` is where
 * an unrecorded cost list is named as a missing input (ADR-046 §5).
 *
 * ── The word P18-29 made wrong, and had to change ─────────────────────────
 * The sentence used to open *"Beyond this window…"*, which was true when it was
 * written and became false the moment the projection gained the fourth event
 * kind: a cost dated inside the horizon is now **on the line above**. The copy
 * says which, and how many, because the alternative is a page that counts the
 * same roof in two places and tells the reader the second one is somewhere
 * else.
 *
 * The prose itself moved to {@link sinkingNoteSentence} when that was fixed.
 * Two branches and four pluralizations around a money figure is logic, and this
 * bug is the evidence that reviewing it as markup does not catch it.
 */
function SinkingNote({
  sinking,
  horizonTo,
}: {
  readonly sinking: ReturnType<typeof sinkingRequirement>;
  readonly horizonTo: string;
}): React.JSX.Element | null {
  const sentence = sinkingNoteSentence(sinking, horizonTo, money);
  if (sentence === null) return null;

  return (
    <p className="mt-6 max-w-2xl border-zinc-200 border-t pt-4 text-sm text-zinc-500 dark:border-zinc-800">
      {sentence}{" "}
      <Link href="/plan/sinking" className="underline">
        See what they require
      </Link>
    </p>
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
              {item.fromLoanTerms && (
                <span className="ml-2 text-xs text-zinc-500">from your loan terms</span>
              )}
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
