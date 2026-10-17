import { Term } from "@/components/help/term.tsx";
import { listAccounts } from "@/lib/accounts/queries.ts";
import { resolveRange } from "@/lib/analytics/range.ts";
import { requireUser } from "@/lib/auth/require-user.ts";
import {
  BENCHMARK_SYMBOL,
  type DatedFlow,
  attribution,
  benchmarkTwr,
  externalFlow,
  gainLossSeries,
  moneyWeightedReturn,
  twr,
  twrIndexSeries,
  valueSeries,
} from "@/lib/investments/performance.ts";
import {
  benchmarkCloseSeries,
  listHoldingSnapshots,
  listInvestmentFlows,
} from "@/lib/investments/queries.ts";
import { Money } from "@/lib/money/money.ts";
import type { Metadata } from "next";
import { AnalysisControls } from "../../analysis/analysis-controls.tsx";
import { AttributionChart } from "./attribution-chart.tsx";
import { ReturnVsBenchmarkChart } from "./return-vs-benchmark-chart.tsx";
import { ValueOverTimeChart } from "./value-over-time-chart.tsx";

export const metadata: Metadata = { title: "Investment performance" };

const CURRENCY = "USD";
const INVESTMENT_TYPES = new Set(["investment", "crypto_ira"]);
const UUID_RE = /^[0-9a-f-]{36}$/i;

interface PageProps {
  readonly searchParams?: Promise<{
    range?: string;
    from?: string;
    to?: string;
    account?: string;
  }>;
}

/** A signed percent string → tone class (green up / red down / neutral). */
function tone(pct: string | null): string {
  if (pct === null) return "";
  return pct.startsWith("-")
    ? "text-red-600 dark:text-red-400"
    : "text-emerald-600 dark:text-emerald-400";
}

export default async function PerformancePage(props: PageProps): Promise<React.JSX.Element> {
  await requireUser();
  const search = (await props.searchParams) ?? {};
  const range = resolveRange(search);
  const accountId = search.account && UUID_RE.test(search.account) ? search.account : null;
  const accountIds = accountId ? [accountId] : undefined;

  const [snapshots, flowTxns, benchCloses, allAccounts] = await Promise.all([
    listHoldingSnapshots({ from: range.from, to: range.to, accountIds }),
    listInvestmentFlows({ from: range.from, to: range.to, accountIds }),
    benchmarkCloseSeries(BENCHMARK_SYMBOL, { from: range.from, to: range.to }),
    listAccounts(),
  ]);

  // Value & gain/loss series straight from the snapshots.
  const values = valueSeries(snapshots, CURRENCY);
  const gains = gainLossSeries(snapshots, CURRENCY);

  // External flows (classifier drops dividends/interest/fees).
  const flows: DatedFlow[] = flowTxns.map(externalFlow).filter((f): f is DatedFlow => f !== null);

  // Headline metrics. All null when there's insufficient history.
  const portfolioTwr = twr(values, flows);
  const benchTwr = benchmarkTwr(benchCloses);
  const first = values[0];
  const last = values.at(-1);
  const mwr =
    first && last
      ? moneyWeightedReturn({
          startValue: first.value,
          startDate: first.date,
          endValue: last.value,
          endDate: last.date,
          flows,
        })
      : null;
  const attr = first && last ? attribution(first.value, last.value, flows, CURRENCY) : null;

  // vs-benchmark delta (only when both sides are computable).
  const benchDelta =
    portfolioTwr !== null && benchTwr !== null
      ? Money.fromString(portfolioTwr, "USD").sub(Money.fromString(benchTwr, "USD")).toString()
      : null;

  // Latest gain/loss figure (from the most recent dated point with a known basis).
  const lastGain = [...gains].reverse().find((g) => g.gain !== null) ?? null;

  // Chart data (Number() only at this display edge).
  const valuePoints = gains.map((g) => ({
    date: g.date,
    value: Number(g.value),
    costBasis: g.costBasis === null ? null : Number(g.costBasis),
  }));

  const portfolioIndex = twrIndexSeries(values, flows);
  const benchIndex = twrIndexSeries(benchCloses);
  const byDate = new Map<
    string,
    { date: string; portfolio: number | null; benchmark: number | null }
  >();
  for (const p of portfolioIndex) {
    byDate.set(p.date, { date: p.date, portfolio: Number(p.value), benchmark: null });
  }
  for (const b of benchIndex) {
    const row = byDate.get(b.date) ?? { date: b.date, portfolio: null, benchmark: null };
    row.benchmark = Number(b.value);
    byDate.set(b.date, row);
  }
  const benchmarkPoints = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));

  const investmentAccounts = allAccounts.filter((a) => INVESTMENT_TYPES.has(a.type));
  const hasHistory = values.length >= 2;

  return (
    <main className="mx-auto max-w-5xl p-6">
      <h1 className="font-semibold text-2xl tracking-tight">Investment performance</h1>
      <p className="mt-1 text-sm text-zinc-500">{range.label}</p>

      <div data-tour="performance-range" className="mt-4">
        <AnalysisControls
          activeKey={range.key}
          accounts={investmentAccounts.map((a) => ({ id: a.id, name: a.name }))}
          activeAccountId={accountId}
          from={range.from}
          to={range.to}
        />
      </div>

      {/* Summary tiles */}
      <div data-tour="performance-tiles" className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Tile
          label={<Term id="time-weighted-return">Time-weighted return</Term>}
          value={pct(portfolioTwr)}
          tone={tone(portfolioTwr)}
        />
        <Tile
          label={<Term id="xirr">Money-weighted (XIRR)</Term>}
          value={pct(mwr)}
          tone={tone(mwr)}
        />
        <Tile
          label="Gain / loss"
          value={lastGain?.gain ? Money.fromString(lastGain.gain, CURRENCY).format() : "—"}
          tone={tone(lastGain?.gain ?? null)}
        />
        <Tile label="vs S&P 500" value={pctDelta(benchDelta)} tone={tone(benchDelta)} />
      </div>

      {!hasHistory && (
        <p className="mt-6 rounded-md border border-zinc-200 border-dashed p-6 text-center text-sm text-zinc-500 dark:border-zinc-800">
          Not enough snapshot history in this range yet. Performance metrics fill in once the
          nightly job has recorded at least two days of holdings — or run the history backfill.
        </p>
      )}

      {hasHistory && (
        <>
          <section data-tour="performance-value" className="mt-8">
            <h2 className="font-medium">Value & cost basis over time</h2>
            <div className="mt-3">
              <ValueOverTimeChart points={valuePoints} currency={CURRENCY} />
            </div>
          </section>

          <section className="mt-8 grid gap-8 lg:grid-cols-2">
            <div data-tour="performance-benchmark">
              <h2 className="font-medium">Return vs. benchmark</h2>
              <p className="mt-0.5 text-xs text-zinc-400">
                Both indexed to 100 at the range start (time-weighted, flow-neutralized).
              </p>
              <div className="mt-3">
                <ReturnVsBenchmarkChart points={benchmarkPoints} />
              </div>
            </div>
            <div data-tour="performance-contributions">
              <h2 className="font-medium">Contributions vs. market growth</h2>
              <p className="mt-0.5 text-xs text-zinc-400">
                Did the portfolio grow, or did you just add money?
              </p>
              <div className="mt-3">
                {attr ? (
                  <AttributionChart
                    netFlows={Number(attr.netFlows)}
                    marketGrowth={Number(attr.marketGrowth)}
                    currency={CURRENCY}
                  />
                ) : null}
              </div>
            </div>
          </section>
        </>
      )}

      <p className="mt-8 text-xs text-zinc-400">
        Performance figures are display metrics, not tax or investment advice — no realized
        gain/loss, tax lots, or 1099 reporting. History recorded before this feature was deployed is
        estimated (today's holdings valued against past prices).
      </p>
    </main>
  );
}

/** A percent string ("10.00") → "10.00%", or "—" when null. */
function pct(value: string | null): string {
  return value === null ? "—" : `${value}%`;
}

/** A signed delta percent → "+1.20%" / "-1.20%", or "—". */
function pctDelta(value: string | null): string {
  if (value === null) return "—";
  return value.startsWith("-") ? `${value}%` : `+${value}%`;
}

function Tile({
  label,
  value,
  tone = "",
}: {
  readonly label: React.ReactNode;
  readonly value: string;
  readonly tone?: string;
}): React.JSX.Element {
  return (
    <div className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
      <div className="text-xs text-zinc-500">{label}</div>
      <div className={`mt-1 font-semibold text-lg tabular-nums ${tone}`}>{value}</div>
    </div>
  );
}
