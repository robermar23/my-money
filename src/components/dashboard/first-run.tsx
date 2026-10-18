import { buttonClass } from "@/components/ui/button-styles.ts";
import type { ChecklistItem } from "@/lib/help/checklist.ts";
import Link from "next/link";
import { ChecklistList } from "./checklist-list.tsx";

/**
 * First-run dashboard state (Phase 13, P13-16, ADR-029 §5).
 *
 * On a brand-new install there is nothing to curate: no accounts means no net
 * worth, no holdings, no transactions, and therefore no allocation, performance,
 * spending, income, alerts, or movers. Rendering the full grid would show seven
 * "nothing here yet" placeholders at once, which reads as a broken page rather
 * than an empty one.
 *
 * So the dashboard collapses to a single instruction. This is the far end of
 * ADR-029's graceful-degradation rule — the same curated page, degrading all the
 * way from *everything* to *nothing* — and it keeps the one action that unblocks
 * every card in front of the user.
 *
 * Below it sits the getting-started checklist (PLAN20 P20-30), so the steps after
 * the first account are visible from the start. It is not dismissible here: on
 * an empty book every item is still to do.
 */
export function FirstRunDashboard({
  checklist,
}: {
  readonly checklist: readonly ChecklistItem[];
}): React.JSX.Element {
  return (
    <>
      <h1 className="font-semibold text-2xl tracking-tight">Welcome</h1>
      <div className="mt-6 rounded-lg border border-zinc-200 border-dashed p-10 text-center dark:border-zinc-800">
        <p className="font-medium text-lg">Add your first account</p>
        <p className="mx-auto mt-2 max-w-md text-sm text-zinc-500">
          Your net worth, allocation, performance, spending, and forward income all build from your
          accounts. Add one and this page fills in as you go.
        </p>
        <Link
          href="/accounts/new"
          className={buttonClass({ variant: "commit", size: "md", className: "mt-6" })}
        >
          Add an account
        </Link>
      </div>
      <section aria-labelledby="getting-started-heading" className="mx-auto mt-8 max-w-md">
        <h2 id="getting-started-heading" className="mb-3 font-medium text-sm">
          Getting started
        </h2>
        <ChecklistList items={checklist} />
      </section>
    </>
  );
}
