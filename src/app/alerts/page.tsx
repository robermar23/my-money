import type { Alert } from "@/db/schema/index.ts";
import { listOpenAlerts, listResolvedAlerts } from "@/lib/alerts/queries.ts";
import { requireUser } from "@/lib/auth/require-user.ts";
import { dismissAlertAction } from "./actions.ts";

export const metadata = { title: "Alerts — my-money" };

const SEVERITY_STYLES: Record<string, string> = {
  critical: "border-red-300 bg-red-50 dark:border-red-900 dark:bg-red-950",
  warning: "border-amber-300 bg-amber-50 dark:border-amber-900 dark:bg-amber-950",
  info: "border-blue-300 bg-blue-50 dark:border-blue-900 dark:bg-blue-950",
};

function formatDetail(detail: Record<string, unknown>): Array<[string, string]> {
  return Object.entries(detail).map(([k, v]) => [k, v === null ? "—" : String(v)]);
}

function AlertCard({ alert }: { readonly alert: Alert }): React.JSX.Element {
  const tone = SEVERITY_STYLES[alert.severity] ?? SEVERITY_STYLES.info;
  const open = alert.resolvedAt === null;
  return (
    <div
      className={`rounded-lg border p-4 ${open ? tone : "border-zinc-200 dark:border-zinc-800"}`}
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <span className="rounded bg-zinc-200 px-1.5 py-0.5 font-medium text-xs uppercase tracking-wide dark:bg-zinc-800">
              {alert.severity}
            </span>
            <h3 className="font-medium text-sm">{alert.title}</h3>
          </div>
          <dl className="mt-2 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5 text-sm text-zinc-600 dark:text-zinc-400">
            {formatDetail(alert.detail).map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="font-code text-xs">{k}</dt>
                <dd className="font-code text-xs">{v}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-2 text-xs text-zinc-500">
            Detected {alert.detectedAt.toISOString().slice(0, 10)}
            {alert.resolvedAt && ` · Resolved ${alert.resolvedAt.toISOString().slice(0, 10)}`}
          </p>
        </div>
        {open && (
          <form action={dismissAlertAction.bind(null, alert.id)}>
            <button
              type="submit"
              className="rounded-md border border-zinc-300 px-3 py-1 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
            >
              Dismiss
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

export default async function AlertsPage(): Promise<React.JSX.Element> {
  await requireUser();
  const [open, resolved] = await Promise.all([listOpenAlerts(), listResolvedAlerts()]);

  return (
    <main className="mx-auto max-w-5xl px-6 py-8">
      <h1 className="font-semibold text-2xl tracking-tight">Alerts</h1>
      <p className="mt-1 text-sm text-zinc-500">
        Anomalies my-money detected for you — large transactions, balance drops, broken connections,
        and stalled pipelines. Figures are shown here only (never emailed).
      </p>

      <section className="mt-6">
        <h2 className="font-medium text-sm text-zinc-500 uppercase tracking-wide">
          Open ({open.length})
        </h2>
        {open.length === 0 ? (
          <p className="mt-3 rounded-lg border border-zinc-200 p-6 text-center text-sm text-zinc-500 dark:border-zinc-800">
            Nothing needs your attention. 🎉
          </p>
        ) : (
          <div className="mt-3 space-y-3">
            {open.map((a) => (
              <AlertCard key={a.id} alert={a} />
            ))}
          </div>
        )}
      </section>

      {resolved.length > 0 && (
        <section className="mt-8">
          <h2 className="font-medium text-sm text-zinc-500 uppercase tracking-wide">Resolved</h2>
          <div className="mt-3 space-y-3 opacity-70">
            {resolved.map((a) => (
              <AlertCard key={a.id} alert={a} />
            ))}
          </div>
        </section>
      )}
    </main>
  );
}
