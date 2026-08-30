import { resolveRange } from "@/lib/analytics/range.ts";
import { requireUser } from "@/lib/auth/require-user.ts";
import { Money } from "@/lib/money/money.ts";
import { loadAttribution } from "@/lib/net-worth/attribution-loader.ts";
import { type AttributionSummary, summarySentence } from "@/lib/net-worth/summary.ts";
import type { AttributionRung, ResidualDiagnostic } from "@/lib/net-worth/types.ts";
import type { Metadata } from "next";
import Link from "next/link";
import { InputsUsed } from "../../plan/inputs-used.tsx";
import { AnalysisControls } from "../analysis-controls.tsx";
import { AttributionWaterfallChart } from "./attribution-waterfall-chart.tsx";
import {
  STATED_ATTRIBUTION_STATUSES,
  attributionNotice,
  longDate,
  waterfallBars,
} from "./view-models.ts";

/**
 * `/analysis/networth` — why net worth changed (P17-20, P17-22, P17-24,
 * ADR-039).
 *
 * Server component, `requireUser`-guarded, one `loadAttribution()` call. Every
 * figure was computed by the engine and formatted here; the only client code is
 * the waterfall island (ADR-005) and the shared range control.
 *
 * ── The page is honest before it is useful ─────────────────────────────────
 * Same ordering `/plan` and `/plan/cashflow` use: the degradation notice sits
 * ABOVE the figure it qualifies. A household reading "your net worth rose
 * $180,000" needs to know *before* they read it that the window starts before
 * the app's records do — afterwards is too late, because the number is what
 * they will remember.
 *
 * ── When the residual leads, the rungs step aside ──────────────────────────
 * P17-22's sharpest rule. Above {@link RESIDUAL_DOMINANT_SHARE} of the change,
 * the diagnostics render *before* the rung table, because in that state the
 * rungs are the less true half of the page: five confident figures explaining a
 * minority of what happened, sitting above the honest admission that most of it
 * is unaccounted for. Ordering is the only thing that fixes that — the rungs
 * are still shown, still correct, just no longer the headline.
 *
 * ── The chart is not the content ───────────────────────────────────────────
 * The waterfall is `aria-hidden` and the rung table is its text alternative
 * (P17-21). Every figure the chart draws is in the table with its audit trail,
 * so the page is complete with the chart removed — which is also what happens
 * on a screen too narrow to draw it usefully.
 *
 * Zero egress; no figure is logged (CLAUDE.md §Privacy).
 */

export const metadata: Metadata = { title: "Net worth change" };

const CURRENCY = "USD";

interface PageProps {
  readonly searchParams?: Promise<{
    range?: string;
    from?: string;
    to?: string;
  }>;
}

/** Format a stored `numeric` string for display. The only place this happens. */
function money(amount: string): string {
  return Money.fromString(amount, CURRENCY).format();
}

export default async function NetWorthAttributionPage({
  searchParams,
}: PageProps): Promise<React.JSX.Element> {
  await requireUser();

  const params = await searchParams;
  const range = resolveRange(params);
  const result = await loadAttribution({ from: range.from, to: range.to });
  const summary = summarySentence(result, CURRENCY);

  const notice = attributionNotice(result.status, result.from);
  const blocked = notice?.tone === "blocking";
  const statesFigure = STATED_ATTRIBUTION_STATUSES.includes(result.status);
  const bars = waterfallBars(result, money, CURRENCY);

  const rungTable = <RungTable rungs={result.rungs} />;
  const diagnostics = <Diagnostics diagnostics={result.diagnostics} summary={summary} />;

  return (
    <main className="mx-auto max-w-4xl p-6">
      <Link href="/analysis" className="text-sm text-zinc-500 hover:underline">
        ← Analysis
      </Link>
      <h1 className="mt-2 font-semibold text-2xl tracking-tight">What changed your net worth</h1>
      <p className="mt-1 max-w-2xl text-sm text-zinc-500">
        Your net worth on {longDate(result.to)} against {longDate(result.from)}, and this app's best
        account of what moved it. Everything below is worked out from what is already recorded here.
        Nothing is fetched and nothing leaves this machine.
      </p>

      <div className="mt-6">
        <AnalysisControls
          activeKey={range.key}
          accounts={[]}
          activeAccountId={null}
          from={range.from}
          to={range.to}
        />
      </div>

      {notice !== null && <Notice notice={notice} />}

      {!blocked && (
        <>
          {statesFigure && <Headline summary={summary} />}

          <section aria-labelledby="waterfall-heading" className="mt-8">
            <h2 id="waterfall-heading" className="font-medium">
              From {money(result.opening)} to {money(result.closing)}
            </h2>
            <p className="mt-1 max-w-2xl text-sm text-zinc-600 dark:text-zinc-400">
              Each bar picks up where the last one left off. The first and last bars are your net
              worth itself; the ones between are what this app can account for.
            </p>
            <div className="mt-3">
              <AttributionWaterfallChart bars={bars} currency={CURRENCY} />
            </div>
          </section>

          {/* P17-22: when most of the change is unaccounted for, the honest half
              of the page goes first. */}
          {summary.residualDominant ? (
            <>
              {diagnostics}
              {rungTable}
            </>
          ) : (
            <>
              {rungTable}
              {diagnostics}
            </>
          )}
        </>
      )}

      <section className="mt-10 border-zinc-200 border-t pt-4 dark:border-zinc-800">
        <h2 className="font-medium text-sm">Where these numbers came from</h2>
        <p className="mt-1 max-w-2xl text-sm text-zinc-500">
          The two end figures are the same ones the dashboard chart draws — this page never works
          them out a second way. If something here looks wrong, one of these inputs is the reason.
        </p>
        <InputsUsed inputs={result.inputsUsed} label="Computed from" />
      </section>
    </main>
  );
}

/** The named gap above the figure it qualifies (P17-22). */
function Notice({
  notice,
}: {
  readonly notice: NonNullable<ReturnType<typeof attributionNotice>>;
}): React.JSX.Element {
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

/**
 * The one sentence, assembled from P17-15's decisions (P17-24).
 *
 * The wording is deliberately a family member's, not an accountant's: "rose",
 * "mostly from", "we cannot account for". The one place hedging is allowed is a
 * *stated* one — the residual clause names an amount, never a vague "roughly".
 */
function Headline({ summary }: { readonly summary: AttributionSummary }): React.JSX.Element {
  const verb =
    summary.direction === "flat" ? "finished level" : summary.direction === "up" ? "rose" : "fell";

  return (
    <section aria-labelledby="headline-heading" className="mt-8">
      <h2 id="headline-heading" className="font-medium text-sm text-zinc-500">
        This window
      </h2>
      <p className="mt-1 font-semibold text-3xl tabular-nums tracking-tight">
        {summary.direction === "flat" ? money("0.00") : money(summary.magnitude)}
      </p>
      <p className="mt-2 max-w-2xl text-sm text-zinc-600 dark:text-zinc-400">
        Your net worth {verb}
        {summary.direction === "flat" ? " " : ` by ${money(summary.magnitude)} `}
        between {longDate(summary.from)} and {longDate(summary.to)}
        {summary.drivers.length > 0 ? (
          <>
            , mostly from{" "}
            {summary.drivers.map((d, i) => (
              <span key={d.rungId}>
                {i > 0 && (i === summary.drivers.length - 1 ? " and " : ", ")}
                <span className="font-medium">{d.label.toLowerCase()}</span>
              </span>
            ))}
          </>
        ) : (
          ", with no single cause large enough to call out"
        )}
        .
        {summary.residual !== null && (
          <>
            {" "}
            <span className="text-amber-700 dark:text-amber-400">
              {money(summary.residual.amount)} of that is money this app cannot yet account for
            </span>
            {summary.diagnosticCount > 0
              ? ` — there ${summary.diagnosticCount === 1 ? "is one reason" : `are ${summary.diagnosticCount} reasons`} below, each with somewhere to go and fix it.`
              : " — and it has nothing to point at, which usually means an account or a loan it has never been told about."}
          </>
        )}
      </p>
    </section>
  );
}

/**
 * Every rung with its amount and its audit trail (ADR-039 §5).
 *
 * All six rows, always, including the zero ones: "we checked and it was
 * nothing" and "we did not look" are different statements, and dropping the row
 * makes them indistinguishable. This table is also the chart's text
 * alternative, so it carries every figure the waterfall draws.
 */
function RungTable({ rungs }: { readonly rungs: readonly AttributionRung[] }): React.JSX.Element {
  return (
    <section aria-labelledby="rungs-heading" className="mt-10">
      <h2 id="rungs-heading" className="font-medium">
        What we can account for
      </h2>
      <ul className="mt-3 divide-y divide-zinc-200 dark:divide-zinc-800">
        {rungs.map((rung) => {
          const amount = Money.fromString(rung.amount, CURRENCY);
          const residual = rung.id === "unexplained";
          return (
            <li key={rung.id} className="py-3">
              <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <span className={`text-sm ${residual ? "font-medium" : ""}`}>{rung.label}</span>
                <span
                  className={`font-mono text-sm tabular-nums ${
                    residual
                      ? "text-amber-700 dark:text-amber-400"
                      : amount.isNegative()
                        ? "text-red-700 dark:text-red-400"
                        : "text-emerald-700 dark:text-emerald-400"
                  }`}
                >
                  {money(rung.amount)}
                </span>
              </div>
              <InputsUsed inputs={rung.inputsUsed} label="Worked out from" />
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/**
 * The residual's named causes, each with a fix link (ADR-039 §4).
 *
 * An empty list with a large residual is itself a finding and says so: the app
 * has checked every cause it knows about and found none, which points at
 * something it has never been told about rather than at nothing.
 */
function Diagnostics({
  diagnostics,
  summary,
}: {
  readonly diagnostics: readonly ResidualDiagnostic[];
  readonly summary: AttributionSummary;
}): React.JSX.Element | null {
  if (diagnostics.length === 0 && summary.residual === null) return null;

  return (
    <section aria-labelledby="diagnostics-heading" className="mt-10">
      <h2 id="diagnostics-heading" className="font-medium">
        Why some of it is unexplained
      </h2>
      {diagnostics.length === 0 ? (
        <p className="mt-1 max-w-2xl text-sm text-zinc-600 dark:text-zinc-400">
          This app checked every cause it knows how to look for and found none, so it has nothing to
          point at. That usually means an account, a loan or a pot of money it has never been told
          about.
        </p>
      ) : (
        <>
          <p className="mt-1 max-w-2xl text-sm text-zinc-600 dark:text-zinc-400">
            Each of these is something the app could not see clearly. Fixing one will not
            necessarily move the figure by the amount shown — that is how much money the problem
            involves, not a promise.
          </p>
          <ul className="mt-3 space-y-3">
            {diagnostics.map((d) => (
              <li
                key={d.code}
                className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                  <span className="font-medium text-sm">{d.label}</span>
                  <span className="font-mono text-sm text-zinc-500 tabular-nums">
                    {money(d.magnitude)}
                  </span>
                </div>
                <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">{d.detail}</p>
                {d.href !== undefined && (
                  <Link href={d.href} className="mt-1 inline-block text-sm underline">
                    Fix this →
                  </Link>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
