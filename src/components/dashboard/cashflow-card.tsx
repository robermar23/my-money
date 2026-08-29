import type { CashFlowCard as CashFlowCardData } from "@/lib/dashboard/loader.ts";
import { Money } from "@/lib/money/money.ts";
import { DashboardCard } from "./card.tsx";

/**
 * Cash-flow card (Phase 16, P16-32, ADR-038 / ADR-029).
 *
 * One figure — safe-to-spend — plus the sentence that qualifies it and the next
 * bill that explains it. The loader decided every number (ADR-029 §2); this
 * formats and links.
 *
 * ── Why the projection chart is not here ───────────────────────────────────
 * A sixty-day line at card width is a shape, not information: nobody reads a
 * date off it, and the one thing a household needs from this feature is a date.
 * The chart earns its place on `/plan/cashflow`, where the axis is legible and
 * the tooltip can name the bills. What a card can carry is a number a person
 * acts on today, so that is what it carries.
 *
 * ── The figure never appears without its two qualifiers ────────────────────
 * A bare "$1,240" reads as a balance. It is not one: it is what the household
 * can spend ON TOP of its usual spending, over a stated window, without going
 * below a floor it chose. The horizon and the floor therefore render in the same
 * breath as the number, in every state — that is ADR-038 §5's requirement, and
 * it is also just the difference between a fact and a slogan.
 */

interface Props {
  /** Undefined only if the loader is ever called without the cash-flow read. */
  readonly data?: CashFlowCardData;
  readonly className?: string;
  readonly currency?: string;
}

const CARD_TITLE = "Safe to spend";
const DEEP_LINK = "/plan/cashflow";

/**
 * Render a decimal fraction as a whole-percent string.
 *
 * `Number()` on a dimensionless ratio at the final display step — not money, and
 * never read back into a calculation (CLAUDE.md §Money).
 */
function percent(fraction: string): string {
  return `${Math.round(Number(fraction) * 100)}%`;
}

/** `"2026-07-14"` → `"July 14"`, in UTC so a calendar date never shifts a day. */
function dayLabel(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

export function CashFlowCard({
  data,
  className,
  currency = "USD",
}: Props): React.JSX.Element | null {
  if (data === undefined) return null;

  if (data.status === "empty") {
    return (
      <DashboardCard
        title={CARD_TITLE}
        href={DEEP_LINK}
        linkLabel="Cash flow →"
        className={className}
      >
        <DashboardCard.Empty message={data.reason} href={data.href} linkLabel="Fix this" />
      </DashboardCard>
    );
  }

  const floor = Money.fromString(data.floor, currency);
  const hasFloor = !floor.isZero();

  return (
    <DashboardCard
      title={CARD_TITLE}
      href={DEEP_LINK}
      linkLabel="Cash flow →"
      className={className}
    >
      {data.clampedAtZero ? (
        <>
          <div className="font-mono text-2xl text-red-600 tabular-nums dark:text-red-400">
            {data.shortfall === null
              ? "Short"
              : `− ${Money.fromString(data.shortfall, currency).format()}`}
          </div>
          <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
            {data.lowWater === null
              ? `You are projected to fall below your cushion within ${data.horizonDays} days.`
              : `That is how far below ${
                  hasFloor ? `your ${floor.format()} cushion` : "empty"
                } you are projected to go on ${dayLabel(data.lowWater.date)}.`}
          </p>
        </>
      ) : (
        <>
          <div className="font-mono text-2xl tabular-nums">
            {Money.fromString(data.safeToSpend, currency).format()}
          </div>
          <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
            Spendable over the next {data.horizonDays} days on top of your usual spending
            {hasFloor ? `, keeping ${floor.format()} in reserve` : ""}.
          </p>
        </>
      )}

      {data.lowWater !== null && !data.clampedAtZero && (
        <p className="mt-2 text-xs text-zinc-500">
          Lowest projected balance: {Money.fromString(data.lowWater.balance, currency).format()} on{" "}
          {dayLabel(data.lowWater.date)}.
        </p>
      )}

      {data.nextObligation !== null && (
        <p className="mt-2 border-zinc-100 border-t pt-2 text-xs text-zinc-500 dark:border-zinc-900">
          Next: {data.nextObligation.label}{" "}
          {data.nextObligation.direction === "inflow" ? "arrives" : "due"}{" "}
          {dayLabel(data.nextObligation.dueDate)} —{" "}
          {Money.fromString(data.nextObligation.amount, currency).format()}
        </p>
      )}

      {/* P16-33: the rung is stated, not implied by a thinner-looking number. */}
      {data.projectionStatus === "run_rate_only" ? (
        <p className="mt-2 text-amber-700 text-xs dark:text-amber-400">
          Your spending pace only — no bills are on the calendar yet
          {data.candidateCount > 0
            ? `, and ${data.candidateCount} ${
                data.candidateCount === 1 ? "suggestion is" : "suggestions are"
              } waiting`
            : ""}
          .
        </p>
      ) : (
        data.coverage !== null && (
          <p className="mt-2 text-xs text-zinc-500">
            {percent(data.coverage)} of recent spending is bills this calendar knows about.
          </p>
        )
      )}
    </DashboardCard>
  );
}
