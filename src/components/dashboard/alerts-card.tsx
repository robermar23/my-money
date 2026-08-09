import type { AlertsCard as AlertsCardData } from "@/lib/dashboard/loader.ts";
import { DashboardCard } from "./card.tsx";

/**
 * Alerts card (Phase 13, P13-11, ADR-029).
 *
 * The open-alert count as a badge plus the three most recent open-alert
 * **titles**, linking to `/alerts` (which owns resolve/dismiss — the dashboard is
 * navigate-only, ADR-029 §2).
 *
 * **ADR-015 is binding here**: alert titles are content-free by construction, and
 * this card renders *nothing but* the title and the detection date. No balance,
 * amount, account name, or payee is displayed — the whole point of the
 * content-free title is that it can appear on a glanceable surface safely.
 *
 * The zero state is deliberately *not* the dashed placeholder used elsewhere:
 * "no open alerts" is good news, so it reads as a calm confirmation rather than a
 * gap to be filled.
 */

interface Props {
  readonly data: AlertsCardData;
}

const CARD_TITLE = "Alerts";
const DEEP_LINK = "/alerts";

/** Short, locale-formatted detection date (no time — the card is a glance). */
function detectedLabel(at: Date): string {
  return at.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function AlertsCard({ data }: Props): React.JSX.Element {
  if (data.status === "empty") {
    return (
      <DashboardCard title={CARD_TITLE} href={DEEP_LINK} linkLabel="Alerts →">
        <div className="flex min-h-24 items-center justify-center gap-2 rounded-md border border-emerald-200 bg-emerald-50/50 p-4 text-emerald-700 text-sm dark:border-emerald-900/50 dark:bg-emerald-950/20 dark:text-emerald-300">
          <span aria-hidden>✓</span>
          <span>No open alerts</span>
        </div>
      </DashboardCard>
    );
  }

  return (
    <DashboardCard title={CARD_TITLE} href={DEEP_LINK} linkLabel="Alerts →">
      <div className="flex items-center gap-2">
        <span className="inline-flex min-w-7 items-center justify-center rounded-full bg-amber-100 px-2 py-0.5 font-medium font-mono text-amber-900 text-sm tabular-nums dark:bg-amber-900/40 dark:text-amber-200">
          {data.count}
        </span>
        <span className="text-sm text-zinc-500">open alert{data.count === 1 ? "" : "s"}</span>
      </div>

      {/* Titles only — never a figure (ADR-015). */}
      <ul className="mt-3 space-y-1.5 border-zinc-100 border-t pt-3 text-sm dark:border-zinc-900">
        {data.recent.map((alert) => (
          <li key={alert.id} className="flex items-baseline justify-between gap-2">
            <span className="truncate text-zinc-700 dark:text-zinc-300">{alert.title}</span>
            <span className="shrink-0 text-xs text-zinc-400">
              {detectedLabel(alert.detectedAt)}
            </span>
          </li>
        ))}
      </ul>
    </DashboardCard>
  );
}
