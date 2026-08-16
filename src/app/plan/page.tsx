import { GuidanceDisclaimer } from "@/components/guidance-disclaimer.tsx";
import type { PlanReadiness } from "@/lib/advice/plan.ts";
import { loadPlan } from "@/lib/advice/plan.ts";
import { requireUser } from "@/lib/auth/require-user.ts";
import Link from "next/link";
import { type DismissedItem, DismissedList } from "./dismissed-list.tsx";
import { RecommendationList } from "./recommendation-list.tsx";
import { WaterfallLadder } from "./waterfall-ladder.tsx";

/**
 * `/plan` — the guidance surface (Phase 15, P15-33, ADR-032).
 *
 * Server component, `requireUser`-guarded, one `loadPlan()` call: snapshot →
 * dismissals → engine → readiness. Everything below is presentation; no figure
 * on this page is computed here (ADR-029 §2).
 *
 * ── The page is honest before it is useful ─────────────────────────────────
 * The order of the sections is a claim about priority. The disclaimer is first
 * and unconditional (ADR-032 §5). The "what would sharpen this" panel comes
 * before the recommendations, not after, because a household with 40% of its
 * spending unclassified should read the caveat before the number it qualifies —
 * ADR-032 consequence 1 in layout form.
 *
 * ── Graceful degradation (P15-37, ADR-029 §5 + ADR-034 §7) ────────────────
 * There is no error state on this page, only progressively less to say. No
 * history at all renders a first-run panel; thin history renders the gated-rule
 * notice naming how many months each rule wants; missing inputs render as named,
 * linked gaps. Every empty state points at the screen that fixes it.
 *
 * Zero egress; nothing here logs a figure (CLAUDE.md §Privacy).
 */

export const metadata = { title: "Plan — my-money" };

export default async function PlanPage(): Promise<React.JSX.Element> {
  await requireUser();

  const { advice, readiness, window, currency } = await loadPlan();

  const dismissed: DismissedItem[] = advice.suppressed.map((entry) => ({
    id: entry.recommendation.id,
    ruleId: entry.recommendation.ruleId,
    subjectKey: entry.recommendation.subjectKey,
    title: entry.recommendation.title,
    dismissedAt: entry.dismissedAt.toISOString(),
    snoozeUntil: entry.snoozeUntil?.toISOString() ?? null,
  }));

  return (
    <main className="mx-auto max-w-5xl p-6">
      <h1 className="font-semibold text-2xl tracking-tight">Your plan</h1>
      <p className="mt-1 text-sm text-zinc-500">
        Computed from your own data on {advice.generatedAt}, over the {window.from} to {window.to}{" "}
        window. Nothing here is stored or sent anywhere.
      </p>

      {/* ADR-032 §5 — unconditional, in every state. */}
      <GuidanceDisclaimer />

      {!readiness.hasHistory ? (
        <FirstRun />
      ) : (
        <>
          <Readiness readiness={readiness} />

          {advice.gated.length > 0 && (
            <section className="mt-6 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
              <h2 className="font-medium text-sm">Not enough history yet</h2>
              <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
                You have {readiness.historyMonths}{" "}
                {readiness.historyMonths === 1 ? "month" : "months"} of transaction history. These
                rules stay quiet until they have enough to answer honestly, rather than answering
                now and being wrong:
              </p>
              <ul className="mt-2 space-y-1 text-sm text-zinc-600 dark:text-zinc-400">
                {advice.gated.map((rule) => (
                  <li key={rule.ruleId}>
                    <span className="font-medium">{rule.title}</span> — needs{" "}
                    {rule.minMonthsHistory} months
                  </li>
                ))}
              </ul>
            </section>
          )}

          {advice.waterfall.length > 0 ? (
            <WaterfallLadder rungs={advice.waterfall} currency={currency} />
          ) : (
            <section className="mt-8 rounded-lg border border-zinc-200 border-dashed p-6 text-center text-sm text-zinc-500 dark:border-zinc-800">
              <p>
                The waterfall needs a few months of history before it can tell you which rung you
                are on.
              </p>
              <Link href="/transactions" className="mt-1 inline-block underline">
                Import statements to backfill →
              </Link>
            </section>
          )}

          <section className="mt-8">
            <h2 className="font-medium">What to look at</h2>
            <p className="mt-1 max-w-3xl text-sm text-zinc-600 dark:text-zinc-400">
              Ranked by urgency, then by how much money is involved. Items the app cannot evaluate
              are listed too — a gap in the data is worth seeing.
            </p>

            {advice.recommendations.length === 0 ? (
              <p className="mt-4 rounded-lg border border-zinc-200 border-dashed p-6 text-center text-sm text-zinc-500 dark:border-zinc-800">
                {dismissed.length > 0
                  ? "Everything currently computed is hidden by you — see below."
                  : "Nothing to flag right now."}
              </p>
            ) : (
              <RecommendationList recommendations={advice.recommendations} currency={currency} />
            )}
          </section>

          <DismissedList items={dismissed} />
        </>
      )}
    </main>
  );
}

/**
 * The named-and-linked gap list (P15-37).
 *
 * Renders nothing when there is nothing missing, which is the point: it is a
 * to-do list that empties, not a permanent disclaimer strip.
 */
function Readiness({
  readiness,
}: {
  readonly readiness: PlanReadiness;
}): React.JSX.Element | null {
  if (readiness.missing.length === 0) return null;

  return (
    <section className="mt-6 rounded-lg border border-amber-300 bg-amber-50/50 p-4 dark:border-amber-900 dark:bg-amber-950/20">
      <h2 className="font-medium text-sm">What would sharpen this</h2>
      <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
        Every figure below is only as good as what it read. These are the inputs it could not find.
      </p>
      <ul className="mt-3 space-y-2">
        {readiness.missing.map((gap) => (
          <li key={gap.id} className="text-sm">
            <span className="font-medium">{gap.label}</span>
            <span className="text-zinc-600 dark:text-zinc-400"> — {gap.detail} </span>
            <Link href={gap.href} className="underline">
              {gap.linkLabel} →
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The genuine first-run state: no transactions at all, so nothing to compute. */
function FirstRun(): React.JSX.Element {
  return (
    <section className="mt-6 rounded-lg border border-zinc-200 border-dashed p-8 text-center dark:border-zinc-800">
      <h2 className="font-medium">Nothing to plan with yet</h2>
      <p className="mx-auto mt-2 max-w-md text-sm text-zinc-600 dark:text-zinc-400">
        Guidance is computed from transactions you have recorded — what you actually earn and spend.
        There are none yet, so there is nothing to measure. It will not guess.
      </p>
      <div className="mt-4 flex flex-wrap justify-center gap-4 text-sm">
        <Link href="/accounts" className="underline">
          Add an account
        </Link>
        <Link href="/transactions" className="underline">
          Import a statement
        </Link>
        <Link href="/settings/connections" className="underline">
          Connect a bank
        </Link>
      </div>
    </section>
  );
}
