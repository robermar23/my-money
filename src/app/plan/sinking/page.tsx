import { Term } from "@/components/help/term.tsx";
import { requireUser } from "@/lib/auth/require-user.ts";
import { listCategoriesWithGroups } from "@/lib/categories/queries.ts";
import { loadSinkingFund } from "@/lib/sinking/loader.ts";
import type { Metadata } from "next";
import Link from "next/link";
import { InputsUsed } from "../inputs-used.tsx";
import { CostRowActions, PlannedExpenseManager } from "./planned-expense-form.tsx";
import { costRows, plannedExpenseViews, sinkingHeadline, sinkingVerdict } from "./view-models.ts";

/**
 * `/plan/sinking` — the sinking-fund surface (P18-23, ADR-043 / ADR-046).
 *
 * Server component, `requireUser`-guarded, one {@link loadSinkingFund} call.
 * Every figure was computed by the pure modules in
 * [lib/sinking](../../../lib/sinking/requirement.ts) and formatted here; the only
 * client code is the manager island.
 *
 * ── The sentence comes first ──────────────────────────────────────────────
 * *"You should be holding $2,180 against the 4 known costs in the next 12
 * months. Your reserve above your emergency-fund target is $600."* That is the
 * deliverable PLAN18 states, and it is the first thing on the page — before the
 * gap, before the table, before any control. A household that reads nothing else
 * has the answer.
 *
 * ── No chart ──────────────────────────────────────────────────────────────
 * Deliberately. `kpi-dashboard-design`'s "which numbers earn a tile" applied by
 * subtraction: the requirement is one number and the itemization is seven
 * columns of fact. A line of accrual over time would be decoration, and a
 * stacked bar per cost would be the funding-progress indicator this phase
 * exists not to build.
 *
 * ── No per-cost funding state ─────────────────────────────────────────────
 * No row says "funded", "unfunded", "on track", or shows progress, and the
 * absence is the design (`personal-tool-builder`'s pushback at P18-00). The gap
 * and the surplus are household-level aggregates over one undivided reserve;
 * there is no fact about an individual cost's funding to render, and inventing
 * one would be the envelope system rebuilt in copy rather than in schema
 * (CLAUDE.md §Domain Scope).
 *
 * ── Degradations render the page, not an empty one ────────────────────────
 * `no_baseline` and `no_costs_recorded` each state what is missing, link to
 * where it is fixed, and keep every control below them. ADR-046 §5's call is the
 * sharp one: an empty cost list is **not** "you are on track" — the app cannot
 * tell "no large irregular costs" from "none recorded yet", and on any install
 * the second is overwhelmingly likelier.
 *
 * Zero egress; no figure and no label is logged (CLAUDE.md §Privacy).
 */

export const metadata: Metadata = { title: "Sinking funds" };

/** Where the essential baseline behind the emergency-fund target is fixed. */
const BASELINE_HREF = "/settings/categories";

export default async function SinkingFundPage(): Promise<React.JSX.Element> {
  await requireUser();

  const [snapshot, categoryData] = await Promise.all([
    loadSinkingFund(),
    listCategoriesWithGroups(),
  ]);

  const { requirement, availability, status, currency, today } = snapshot;
  const rows = costRows(requirement, currency);
  const expenses = plannedExpenseViews(snapshot.plannedExpenses, currency, today);
  const categories = categoryData.categories.map((category) => ({
    id: category.id,
    name: category.name,
    groupName: category.groupName,
    kind: category.kind,
  }));

  return (
    <main className="mx-auto max-w-4xl p-6">
      <Link href="/plan" className="text-sm text-zinc-500 hover:underline">
        ← Guidance
      </Link>
      <h1 className="mt-2 font-semibold text-2xl tracking-tight">Sinking funds</h1>

      {status === "no_baseline" && (
        <section className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-950">
          <h2 className="font-medium text-sm">We cannot tell you how much to set aside yet</h2>
          <p className="mt-1 text-sm text-zinc-700 dark:text-zinc-300">
            What you can set aside for upcoming costs is the savings you hold above your emergency
            fund, and sizing that fund needs a figure for your essential monthly expenses. There is
            not enough classified spending history to compute one.{" "}
            <Link href={BASELINE_HREF} className="underline">
              Classify a few categories as essential
            </Link>{" "}
            and this fills in. You can still record costs below.
          </p>
        </section>
      )}

      {status === "no_costs_recorded" && (
        <section className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-950">
          <h2 className="font-medium text-sm">Nothing recorded to work from yet</h2>
          <p className="mt-1 text-sm text-zinc-700 dark:text-zinc-300">
            This is not the same as having no large irregular costs. Insurance premiums, property
            taxes, a car service, a dental bill — record what you know is coming and this becomes a
            figure rather than a blank.
          </p>
        </section>
      )}

      {status === "ok" && (
        <>
          <p data-tour="sinking-headline" className="mt-3 max-w-2xl text-lg">
            {sinkingHeadline(requirement, availability, currency)}
          </p>
          <Verdict requirement={requirement} availability={availability} currency={currency} />
        </>
      )}

      <p className="mt-4 max-w-2xl text-sm text-zinc-500">
        Costs due in the next 12 months, from what you have recorded here and from the non-monthly
        bills on your calendar. Monthly bills are left out — they are already in your everyday
        spending. A bill whose amount varies contributes a moving estimate, so its share of the
        figure changes as recent actuals do.
      </p>
      <p className="mt-2 max-w-2xl text-sm text-zinc-500">
        Nothing here moves or reserves money. It compares a requirement with the savings you
        actually hold.
      </p>

      {snapshot.confidence === "low" && status === "ok" && (
        <p className="mt-2 max-w-2xl text-amber-700 text-sm dark:text-amber-400">
          Treat the emergency-fund half of this with some caution: it rests on a short or partly
          unclassified spending history. What your known costs require is unaffected — that is read
          from the costs themselves.
        </p>
      )}

      <InputsUsed inputs={snapshot.inputsUsed} label="This figure is based on" />

      {rows.length > 0 && (
        <section aria-labelledby="costs-heading" className="mt-8">
          <h2 id="costs-heading" className="font-medium text-lg">
            The costs behind the figure
          </h2>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-sm">
              <thead data-tour="sinking-costs" className="text-left text-xs text-zinc-500">
                <tr className="border-zinc-200 border-b dark:border-zinc-800">
                  <th scope="col" className="py-2 pr-3 font-medium">
                    Cost
                  </th>
                  <th scope="col" className="py-2 pr-3 font-medium">
                    Due
                  </th>
                  <th scope="col" className="py-2 pr-3 text-right font-medium">
                    Amount
                  </th>
                  <th scope="col" className="py-2 pr-3 text-right font-medium">
                    Months left
                  </th>
                  <th scope="col" className="py-2 pr-3 text-right font-medium">
                    Per month
                  </th>
                  <th scope="col" className="py-2 text-right font-medium">
                    <Term id="required-today" align="end">
                      Required today
                    </Term>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-900">
                {rows.map((row) => (
                  <tr
                    key={row.key}
                    className={row.pastDue ? "bg-amber-50/60 dark:bg-amber-950/40" : undefined}
                  >
                    <td className="py-2 pr-3">
                      <span className="font-medium">{row.label}</span>
                      <span className="block text-xs text-zinc-500">{row.sourceLabel}</span>
                      {row.pastDue && row.editable && (
                        <span className="mt-1 block">
                          <CostRowActions id={row.sourceId} />
                        </span>
                      )}
                    </td>
                    <td className="py-2 pr-3">
                      {row.dueDateDisplay}
                      {row.pastDue && (
                        <span className="block text-amber-700 text-xs dark:text-amber-400">
                          past due
                        </span>
                      )}
                    </td>
                    <td className="py-2 pr-3 text-right font-mono tabular-nums">
                      {row.amountDisplay}
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums">{row.monthsRemaining}</td>
                    <td className="py-2 pr-3 text-right font-mono tabular-nums">
                      {row.perMonthDisplay}
                    </td>
                    <td className="py-2 text-right font-mono tabular-nums">
                      {row.requiredTodayDisplay}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {requirement.pastDueCount > 0 && (
            <p className="mt-3 text-sm text-zinc-500">
              {requirement.pastDueCount} of these {requirement.pastDueCount === 1 ? "is" : "are"}{" "}
              already past due and{" "}
              {requirement.pastDueCount === 1 ? "is still counted" : "are still counted"} in full.
              Mark {requirement.pastDueCount === 1 ? "it" : "them"} paid, or move the date.
            </p>
          )}
        </section>
      )}

      <section aria-labelledby="manager-heading" className="mt-12">
        <h2 id="manager-heading" data-tour="sinking-recorded" className="font-medium text-lg">
          Costs you have recorded
        </h2>
        <PlannedExpenseManager
          expenses={expenses}
          categories={categories}
          currency={currency}
          today={today}
        />
      </section>
    </main>
  );
}

/**
 * The gap or the surplus, as the one answer that follows the headline.
 *
 * Rendered as a figure plus the sentence that qualifies it, never a figure
 * alone: a $1,580 gap with no rate beside it is a number to feel bad about
 * rather than one to act on.
 */
function Verdict({
  requirement,
  availability,
  currency,
}: {
  readonly requirement: Parameters<typeof sinkingVerdict>[0];
  readonly availability: Parameters<typeof sinkingVerdict>[1];
  readonly currency: string;
}): React.JSX.Element {
  const verdict = sinkingVerdict(requirement, availability, currency);

  return (
    <div
      data-tour="sinking-verdict"
      className="mt-4 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800"
    >
      <p className="text-xs text-zinc-500">
        {verdict.position === "gap"
          ? "Short by"
          : verdict.position === "surplus"
            ? "Spare"
            : "Level"}
      </p>
      <p className="font-semibold text-2xl tabular-nums">{verdict.amountDisplay}</p>
      <p className="mt-1 max-w-xl text-sm text-zinc-500">{verdict.sentence}</p>
    </div>
  );
}
