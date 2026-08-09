import type { IncomeCard as IncomeCardData } from "@/lib/dashboard/loader.ts";
import { DashboardCard } from "./card.tsx";

/**
 * Forward-income card (Phase 13, P13-10, ADR-029).
 *
 * The projected forward 12-month dividend/distribution income and the portfolio
 * yield-on-cost, both straight from `forwardIncome` (ADR-029 §2: the card does no
 * math), plus a one-line hint at the largest payers. Links to
 * `/investments/forecast`, which owns the deep view.
 *
 * **Carries the ADR-022 framing**: this is an *estimate* — shares held × the
 * security's current forward annual rate — never a promise of income and never
 * advice. The label sits next to the number, not buried, because a bare dollar
 * figure on a landing page reads as a commitment.
 *
 * Note: the plan text for P13-10 also mentions a *blended forward yield*
 * (income ÷ market value). No library computes it, and ADR-029's hard boundary
 * forbids inventing a metric in the dashboard layer, so it is deliberately
 * omitted — adding it belongs in `forward-income.ts` with its own tests.
 */

interface Props {
  readonly data: IncomeCardData;
}

const CARD_TITLE = "Forward income";
const DEEP_LINK = "/investments/forecast";

export function IncomeCard({ data }: Props): React.JSX.Element {
  if (data.status === "empty") {
    return (
      <DashboardCard title={CARD_TITLE} href={DEEP_LINK} linkLabel="Forecast →">
        <DashboardCard.Empty
          message="No dividend-paying holdings yet."
          href="/investments"
          linkLabel="View investments"
        />
      </DashboardCard>
    );
  }

  return (
    <DashboardCard title={CARD_TITLE} href={DEEP_LINK} linkLabel="Forecast →">
      <div className="flex items-baseline justify-between gap-3">
        <div>
          <div className="font-mono text-2xl tabular-nums">{data.forward12mo.format()}</div>
          <div className="text-xs text-zinc-500">estimated next 12 months</div>
        </div>
        <div className="text-right">
          <div className="text-xs text-zinc-500">Yield on cost</div>
          <div className="font-mono text-sm tabular-nums">
            {data.yieldOnCost === null ? (
              <span className="text-zinc-500">—</span>
            ) : (
              `${data.yieldOnCost}%`
            )}
          </div>
        </div>
      </div>

      {data.topPayers.length > 0 && (
        <p className="mt-3 truncate text-sm text-zinc-600 dark:text-zinc-400">
          <span className="text-zinc-500">Largest payers: </span>
          {data.topPayers.map((p) => `${p.symbol} ${p.annualIncome.format()}`).join(" · ")}
        </p>
      )}

      {/* ADR-022: an estimate, not a promise and not advice. */}
      <p className="mt-3 text-xs text-zinc-400">
        Estimate — assumes today's holdings keep their current distribution rate.
      </p>
    </DashboardCard>
  );
}
