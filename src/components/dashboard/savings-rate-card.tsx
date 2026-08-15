import type { SavingsRateCard as SavingsRateCardData } from "@/lib/dashboard/loader.ts";
import { DashboardCard } from "./card.tsx";

/**
 * Savings-rate card (Phase 14, P14-17, ADR-030/031) — fills the slot Phase 13
 * reserved for it (P13-13).
 *
 * Employee contributions ÷ projected annual gross, straight from `savingsRate`
 * (P14-07). Like every card here it does no math (ADR-029 §2); the rate, the
 * totals, and the null-when-undefined semantics all arrive decided.
 *
 * **The framing is deliberate.** The denominator is *projected* (current gross ×
 * pay periods per year) while the numerator is *measured* (contributions
 * actually materialized in the window). Those are different kinds of number, so
 * the card says "estimate" and names the window rather than presenting a
 * percentage as a measured fact — the same honesty ADR-022 requires of the
 * forward-income card. A rule created mid-year, or a backfill that hasn't run,
 * legitimately shows a low rate; the window label is what makes that legible
 * instead of alarming.
 *
 * The employer match is shown next to the employee figure but excluded from the
 * rate: matched dollars are real cost basis, but they are not income the user
 * chose to save.
 */

interface Props {
  /** Undefined only if the loader is ever called without the income read. */
  readonly data?: SavingsRateCardData;
  /** Grid column span assigned by the dashboard layout (P13-14). */
  readonly className?: string;
}

const CARD_TITLE = "Savings rate";
const DEEP_LINK = "/settings/income";

/** `2026-08-09` → `Aug 2026`, for the window label. */
function monthLabel(iso: string): string {
  const [year, month] = iso.split("-");
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, 1));
  return date.toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
}

export function SavingsRateCard({ data, className }: Props): React.JSX.Element | null {
  if (data === undefined) return null;

  if (data.status === "empty") {
    return (
      <DashboardCard title={CARD_TITLE} href={DEEP_LINK} linkLabel="Income →" className={className}>
        <DashboardCard.Empty
          message="Define your income to track your savings rate."
          href={DEEP_LINK}
          linkLabel="Add an income source"
        />
      </DashboardCard>
    );
  }

  return (
    <DashboardCard title={CARD_TITLE} href={DEEP_LINK} linkLabel="Income →" className={className}>
      <div className="flex items-baseline justify-between gap-3">
        <div>
          <div className="font-mono text-2xl tabular-nums">
            {data.ratePct === null ? <span className="text-zinc-500">—</span> : `${data.ratePct}%`}
          </div>
          <div className="text-xs text-zinc-500">of projected annual gross</div>
        </div>
        <div className="text-right">
          <div className="text-xs text-zinc-500">Annual gross</div>
          <div className="font-mono text-sm tabular-nums">{data.annualGross.format()}</div>
        </div>
      </div>

      <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-sm">
        <div>
          <dt className="text-xs text-zinc-500">You contributed</dt>
          <dd className="font-mono tabular-nums">{data.annualEmployee.format()}</dd>
        </div>
        <div>
          <dt className="text-xs text-zinc-500">Employer match</dt>
          <dd className="font-mono tabular-nums">{data.annualEmployer.format()}</dd>
        </div>
      </dl>

      {/* Estimate framing (P14-17): a projected denominator over a measured
          numerator. Naming the window is what keeps a partial year honest. */}
      <p className="mt-3 text-xs text-zinc-400">
        Estimate — contributions recorded {monthLabel(data.window.from)} to{" "}
        {monthLabel(data.window.to)} against gross projected from your current pay. Employer match
        excluded from the rate.
      </p>
    </DashboardCard>
  );
}
