import type { RungState, RungStatus } from "@/lib/advice/types.ts";
import { Money } from "@/lib/money/money.ts";
import { InputsUsed } from "./inputs-used.tsx";

/**
 * The waterfall ladder (Phase 15, P15-33, ADR-034 §4).
 *
 * Seven rungs in fixed order, each with its state and the sentence explaining
 * why it is in that state. Pure presentation: `evaluateWaterfall` decided every
 * status, target, gap and reason (P15-22), and this component does no math —
 * ADR-029 §2 applied to guidance.
 *
 * ── Four states, four different meanings ───────────────────────────────────
 * The visual treatment matters more here than on a typical list, because the
 * states are easy to conflate and expensive to confuse:
 *
 *   - **done** is green and quiet. It is good news, not a call to action.
 *   - **in_progress** is the focus — one rung at a time, emphasized.
 *   - **blocked** is gray, and says so in words. It is an *ordering* statement,
 *     not a failure: "fund the match before the taxable account".
 *   - **unknown_input** is amber. It looks unlike `done` on purpose, because the
 *     single most damaging thing this feature could do is let "we cannot tell"
 *     read as "you are fine" (ADR-032 consequence 1). Amber with a fix link is
 *     what stops that.
 *
 * A rung is **never** `done` on absent data — the rules guarantee it, and this
 * component would render an honest amber rung if one ever slipped through.
 */

interface Props {
  readonly rungs: readonly RungState[];
  readonly currency: string;
}

const STATUS_LABEL: Readonly<Record<RungStatus, string>> = {
  done: "Done",
  in_progress: "Working on this",
  blocked: "Comes later",
  unknown_input: "Missing an input",
};

const STATUS_BADGE: Readonly<Record<RungStatus, string>> = {
  done: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  in_progress: "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300",
  blocked: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400",
  unknown_input: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
};

const STATUS_MARKER: Readonly<Record<RungStatus, string>> = {
  done: "border-emerald-500 bg-emerald-500",
  in_progress: "border-blue-500 bg-white dark:bg-zinc-950",
  blocked: "border-zinc-300 bg-white dark:border-zinc-700 dark:bg-zinc-950",
  unknown_input: "border-amber-500 bg-white dark:bg-zinc-950",
};

/** Format a money string for display. Never `Number()` — see CLAUDE.md §Money. */
function money(value: string, currency: string): string {
  return Money.fromString(value, currency).format();
}

export function WaterfallLadder({ rungs, currency }: Props): React.JSX.Element {
  const done = rungs.filter((rung) => rung.status === "done").length;

  return (
    <section className="mt-8">
      <div
        data-tour="plan-waterfall"
        className="flex flex-wrap items-baseline justify-between gap-2"
      >
        <h2 className="font-medium">Where your next dollar goes</h2>
        <span className="text-sm text-zinc-500">
          {done} of {rungs.length} rungs complete
        </span>
      </div>
      <p className="mt-1 max-w-3xl text-sm text-zinc-600 dark:text-zinc-400">
        A conventional ordering, worked top to bottom. Each rung is computed from your own data —
        you cannot add, rename or reorder one, because every target here comes from a figure the app
        can point at.
      </p>

      <ol className="mt-4">
        {rungs.map((rung, index) => (
          <li key={rung.rung} className="flex gap-3">
            {/* Spine: a marker per rung, with a connecting line except on the last. */}
            <div className="flex flex-col items-center">
              <span
                className={`mt-1.5 h-3 w-3 shrink-0 rounded-full border-2 ${STATUS_MARKER[rung.status]}`}
              />
              {index < rungs.length - 1 && (
                <span className="w-px grow bg-zinc-200 dark:bg-zinc-800" />
              )}
            </div>

            <div className="min-w-0 grow pb-5">
              <div className="flex flex-wrap items-center gap-2">
                <h3
                  className={`font-medium text-sm ${
                    rung.status === "blocked" ? "text-zinc-500" : ""
                  }`}
                >
                  {rung.label}
                </h3>
                <span
                  className={`rounded px-1.5 py-0.5 font-medium text-xs ${STATUS_BADGE[rung.status]}`}
                >
                  {STATUS_LABEL[rung.status]}
                </span>
              </div>

              <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">{rung.reason}</p>

              {/* Figures only when they exist. A missing target renders nothing
                  rather than a zero — see the header on why that matters. */}
              {(rung.target !== null || rung.current !== null) && (
                <dl className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-xs">
                  {rung.current !== null && (
                    <div>
                      <dt className="text-zinc-500">You have</dt>
                      <dd className="font-mono tabular-nums">{money(rung.current, currency)}</dd>
                    </div>
                  )}
                  {rung.target !== null && (
                    <div>
                      <dt className="text-zinc-500">Target</dt>
                      <dd className="font-mono tabular-nums">{money(rung.target, currency)}</dd>
                    </div>
                  )}
                  {rung.gap !== null && (
                    <div>
                      <dt className="text-zinc-500">Gap</dt>
                      <dd className="font-mono tabular-nums">{money(rung.gap, currency)}</dd>
                    </div>
                  )}
                </dl>
              )}

              <InputsUsed inputs={rung.inputsUsed} />
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
