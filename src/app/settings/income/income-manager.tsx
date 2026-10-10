"use client";

import { INCOME_CADENCE_OPTIONS } from "@/lib/schemas/income.ts";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import {
  type TakeHomeSuggestionView,
  backfillContributionsAction,
  createIncomeSourceAction,
  deleteContributionRuleAction,
  deleteIncomeSourceAction,
  saveContributionRuleAction,
  setContributionRuleActiveAction,
  setIncomeSourceActiveAction,
  suggestTakeHomeAction,
  updateIncomeSourceAction,
} from "./actions.ts";
import { RuleForm } from "./rule-form.tsx";
import type { AccountView, HoldingView, RuleView, SourceView } from "./view-models.ts";

/**
 * `/settings/income` management surface (P14-14).
 *
 * Mirrors the categories manager: a client island over server actions, with
 * `router.refresh()` after each mutation so the server component re-reads. No
 * money arithmetic happens here — dollar figures arrive pre-formatted and the
 * only computation on this page is the read-only preview inside `RuleForm`,
 * which is itself a server action.
 *
 * Deactivate is offered before delete everywhere on purpose: pausing stops
 * future contributions while keeping the ledger that backs the 401k's cost
 * basis. The delete actions refuse outright once contributions exist.
 */

const inputClass =
  "rounded-md border border-zinc-300 px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900";
const labelClass = "block font-medium text-xs text-zinc-600 dark:text-zinc-400";

/** Human wording for each cadence, and how the schedule is phased. */
const CADENCE_LABELS: Record<string, string> = {
  weekly: "Weekly",
  biweekly: "Every two weeks",
  semimonthly: "Twice a month",
  monthly: "Monthly",
};

const EMPLOYEE_BASIS_SUFFIX: Record<string, string> = {
  percent: "% of gross",
  amount: "per period",
};

const MATCH_BASIS_SUFFIX: Record<string, string> = {
  none: "",
  percent_of_gross: "% of gross",
  percent_of_contribution: "% of my contribution",
  amount: "per period",
};

interface Props {
  readonly sources: readonly SourceView[];
  readonly accounts: readonly AccountView[];
  readonly holdings: readonly HoldingView[];
}

export function IncomeManager({ sources, accounts, holdings }: Props): React.JSX.Element {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [addingSource, setAddingSource] = useState(sources.length === 0);
  // The backfill is asynchronous — the action only enqueues. Say so, rather than
  // letting a silent refresh imply the work already finished.
  const [queued, setQueued] = useState<string | null>(null);

  function run(fn: () => Promise<{ error?: string }>, onDone?: () => void): void {
    setError(null);
    setQueued(null);
    startTransition(async () => {
      const result = await fn();
      if (result.error) {
        setError(result.error);
        return;
      }
      onDone?.();
      router.refresh();
    });
  }

  return (
    <section className="mt-6">
      {error && (
        <p className="mb-4 rounded-md bg-red-50 px-3 py-2 text-red-700 text-sm dark:bg-red-950 dark:text-red-300">
          {error}
        </p>
      )}

      {sources.length === 0 && !addingSource && (
        <p className="text-sm text-zinc-500">
          No income defined yet. Add a paycheck to start tracking contributions and your savings
          rate.
        </p>
      )}

      <div className="space-y-4">
        {sources.map((source) => (
          <SourceCard
            key={source.id}
            source={source}
            accounts={accounts}
            holdings={holdings}
            pending={pending}
            onRun={run}
          />
        ))}
      </div>

      {addingSource ? (
        <div className="mt-6 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
          <h3 className="font-medium">Add an income source</h3>
          <SourceFields
            source={null}
            disabled={pending}
            submitLabel="Add income source"
            onSubmit={(fd) =>
              run(
                () => createIncomeSourceAction({}, fd),
                () => setAddingSource(false),
              )
            }
            onCancel={() => setAddingSource(false)}
          />
        </div>
      ) : (
        <div className="mt-6 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setAddingSource(true)}
            className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm text-white dark:bg-zinc-50 dark:text-zinc-900"
          >
            Add income source
          </button>
          {sources.length > 0 && (
            <button
              type="button"
              disabled={pending}
              onClick={() =>
                run(backfillContributionsAction, () =>
                  setQueued("Backfill queued. Contributions appear once the worker finishes."),
                )
              }
              className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm disabled:opacity-50 dark:border-zinc-700"
            >
              Backfill history
            </button>
          )}
        </div>
      )}

      {queued && (
        <p className="mt-3 text-sm text-zinc-500" aria-live="polite">
          {queued}
        </p>
      )}

      {sources.length > 0 && (
        <p className="mt-3 text-xs text-zinc-500">
          Backfill walks every paycheck — <strong>including paused ones</strong> — from its start
          date to today and creates any contribution that is missing. Existing contributions are
          left alone, so it is safe to run more than once.
        </p>
      )}
    </section>
  );
}

function SourceCard({
  source,
  accounts,
  holdings,
  pending,
  onRun,
}: {
  readonly source: SourceView;
  readonly accounts: readonly AccountView[];
  readonly holdings: readonly HoldingView[];
  readonly pending: boolean;
  readonly onRun: (fn: () => Promise<{ error?: string }>, onDone?: () => void) => void;
}): React.JSX.Element {
  const [editing, setEditing] = useState(false);
  const [editingRule, setEditingRule] = useState(false);

  return (
    <article className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="font-medium">
            {source.name}{" "}
            {!source.active && (
              <span className="rounded bg-zinc-100 px-2 py-0.5 align-middle text-xs text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
                paused
              </span>
            )}
          </h3>
          <p className="mt-1 text-sm text-zinc-500">
            <span className="font-mono">{source.grossDisplay}</span> gross ·{" "}
            {source.netDisplay !== null && (
              <>
                <span className="font-mono">{source.netDisplay}</span> take-home ·{" "}
              </>
            )}
            {CADENCE_LABELS[source.cadence] ?? source.cadence} · paydays phased from{" "}
            {source.anchorDate} · from {source.startDate}
            {source.endDate ? ` to ${source.endDate}` : ""}
          </p>
          {source.notes && <p className="mt-1 text-sm text-zinc-500">{source.notes}</p>}
        </div>
        <div className="flex flex-wrap gap-1.5">
          <button
            type="button"
            onClick={() => setEditing((v) => !v)}
            className="rounded border border-zinc-300 px-2 py-1 text-xs dark:border-zinc-700"
          >
            {editing ? "Close" : "Edit"}
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={() => onRun(() => setIncomeSourceActiveAction(source.id, !source.active))}
            className="rounded border border-zinc-300 px-2 py-1 text-xs disabled:opacity-50 dark:border-zinc-700"
          >
            {source.active ? "Pause" : "Resume"}
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={() => onRun(() => deleteIncomeSourceAction(source.id))}
            className="rounded border border-red-300 px-2 py-1 text-red-700 text-xs disabled:opacity-50 dark:border-red-800 dark:text-red-300"
          >
            Delete
          </button>
        </div>
      </div>

      {editing && (
        <SourceFields
          source={source}
          disabled={pending}
          submitLabel="Save changes"
          onSubmit={(fd) => {
            fd.set("id", source.id);
            onRun(
              () => updateIncomeSourceAction({}, fd),
              () => setEditing(false),
            );
          }}
          onCancel={() => setEditing(false)}
        />
      )}

      <div className="mt-4 border-zinc-100 border-t pt-3 dark:border-zinc-900">
        {source.rule && !editingRule ? (
          <RuleSummary
            rule={source.rule}
            source={source}
            pending={pending}
            onEdit={() => setEditingRule(true)}
            onRun={onRun}
          />
        ) : null}

        {!source.rule && !editingRule && (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm text-zinc-500">No 401k contribution defined for this paycheck.</p>
            <button
              type="button"
              disabled={accounts.length === 0}
              onClick={() => setEditingRule(true)}
              className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm disabled:opacity-50 dark:border-zinc-700"
            >
              {accounts.length === 0 ? "Create an investment account first" : "Add contribution"}
            </button>
          </div>
        )}

        {editingRule && (
          <RuleForm
            sourceId={source.id}
            rule={source.rule}
            accounts={accounts}
            holdings={holdings}
            disabled={pending}
            onSave={(fd) =>
              onRun(
                () => saveContributionRuleAction({}, fd),
                () => setEditingRule(false),
              )
            }
            onCancel={() => setEditingRule(false)}
          />
        )}
      </div>
    </article>
  );
}

/**
 * Why a rule has materialized nothing yet, in the user's terms.
 *
 * The old copy always claimed the nightly job would pick it up "from the next
 * payday". For a paused source, or one whose end date has passed, that is simply
 * false — the nightly job skips paused rules and never revisits a finished
 * paycheck, so the message promised a run that was never coming. Each branch
 * below names the actual state and the action that resolves it.
 */
function emptyLedgerNote(rule: RuleView, source: SourceView): string {
  if (!source.active || !rule.active) {
    return source.ended
      ? "Nothing materialized yet. Paused, and this paycheck has ended — the nightly job will never pick it up. Use “Backfill history” to reconstruct what it contributed."
      : "Nothing materialized yet. Paused, so no contributions are being created. Resume it, or use “Backfill history” to reconstruct past paydays.";
  }
  if (source.ended) {
    return "Nothing materialized yet, and this paycheck has ended. Use “Backfill history” to reconstruct what it contributed.";
  }
  if (source.startsInFuture) {
    return "Nothing materialized yet — the nightly job creates contributions from the first payday.";
  }
  return "Nothing materialized yet — the nightly job will pick up paydays back to the start date. Use “Backfill history” to do it now.";
}

/** The saved rule, rendered read-only with its materialization tally. */
function RuleSummary({
  rule,
  source,
  pending,
  onEdit,
  onRun,
}: {
  readonly rule: RuleView;
  readonly source: SourceView;
  readonly pending: boolean;
  readonly onEdit: () => void;
  readonly onRun: (fn: () => Promise<{ error?: string }>) => void;
}): React.JSX.Element {
  const employee = `${rule.employeeValue}${
    rule.employeeBasis === "percent" ? "" : " "
  }${EMPLOYEE_BASIS_SUFFIX[rule.employeeBasis] ?? ""}`;
  const match =
    rule.matchBasis === "none"
      ? "no employer match"
      : `${rule.matchValue}${rule.matchBasis === "amount" ? " " : ""}${
          MATCH_BASIS_SUFFIX[rule.matchBasis] ?? ""
        } match${rule.matchCapPercent ? `, capped at ${rule.matchCapPercent}% of gross` : ""}`;

  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <p className="text-sm">
          <strong>{employee}</strong> → {rule.accountName}
          {rule.holdingSymbol ? ` · buys ${rule.holdingSymbol}` : " · dollars only"} ·{" "}
          {rule.pretax ? "pre-tax" : "Roth"}
          {!rule.active && " · paused"}
        </p>
        <p className="mt-1 text-sm text-zinc-500">With {match}.</p>
        <p className="mt-1 text-xs text-zinc-500">
          {rule.materializedCount === 0
            ? emptyLedgerNote(rule, source)
            : `${rule.materializedCount} contribution${
                rule.materializedCount === 1 ? "" : "s"
              } materialized through ${rule.lastPayDate} · ${rule.totalEmployeeDisplay} mine + ${
                rule.totalEmployerDisplay
              } employer, all of it cost basis.`}
        </p>
        {rule.doubleCountRisk && (
          <p className="mt-2 rounded-md bg-amber-50 px-3 py-2 text-amber-900 text-xs dark:bg-amber-950 dark:text-amber-200">
            <strong>Double-count risk.</strong> {rule.holdingSymbol} also has cost-basis lots synced
            from your bank, so the same dollars may be counted twice in this position’s basis.
            Contributions only ever write their own rows — but consider pointing this rule at a
            holding it alone funds.
          </p>
        )}
      </div>
      <div className="flex flex-wrap gap-1.5">
        <button
          type="button"
          onClick={onEdit}
          className="rounded border border-zinc-300 px-2 py-1 text-xs dark:border-zinc-700"
        >
          Edit
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={() => onRun(() => setContributionRuleActiveAction(rule.id, !rule.active))}
          className="rounded border border-zinc-300 px-2 py-1 text-xs disabled:opacity-50 dark:border-zinc-700"
        >
          {rule.active ? "Pause" : "Resume"}
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={() => onRun(() => deleteContributionRuleAction(rule.id))}
          className="rounded border border-red-300 px-2 py-1 text-red-700 text-xs disabled:opacity-50 dark:border-red-800 dark:text-red-300"
        >
          Delete
        </button>
      </div>
    </div>
  );
}

/** The income-source field set, shared by create and edit. */
function SourceFields({
  source,
  disabled,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  readonly source: SourceView | null;
  readonly disabled: boolean;
  readonly submitLabel: string;
  readonly onSubmit: (formData: FormData) => void;
  readonly onCancel: () => void;
}): React.JSX.Element {
  const today = new Date().toISOString().slice(0, 10);
  const [name, setName] = useState(source?.name ?? "");
  const [cadence, setCadence] = useState(source?.cadence ?? "biweekly");
  const [grossPerPeriod, setGrossPerPeriod] = useState(source?.grossPerPeriod ?? "");
  const [netPerPeriod, setNetPerPeriod] = useState(source?.netPerPeriod ?? "");
  const [currency, setCurrency] = useState(source?.currency ?? "USD");
  const [anchorDate, setAnchorDate] = useState(source?.anchorDate ?? today);
  const [startDate, setStartDate] = useState(source?.startDate ?? today);
  const [endDate, setEndDate] = useState(source?.endDate ?? "");
  const [notes, setNotes] = useState(source?.notes ?? "");
  const [active, setActive] = useState(source?.active ?? true);
  const id = source?.id ?? "new";

  function submit(): void {
    const fd = new FormData();
    fd.set("name", name);
    fd.set("cadence", cadence);
    fd.set("grossPerPeriod", grossPerPeriod);
    fd.set("netPerPeriod", netPerPeriod);
    fd.set("currency", currency);
    fd.set("anchorDate", anchorDate);
    fd.set("startDate", startDate);
    fd.set("endDate", endDate);
    fd.set("notes", notes);
    if (active) fd.set("active", "on");
    onSubmit(fd);
  }

  return (
    <div className="mt-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className={labelClass} htmlFor={`name-${id}`}>
            Name
          </label>
          <input
            id={`name-${id}`}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Acme Corp — salary"
            className={`mt-1 w-full ${inputClass}`}
          />
        </div>
        <div>
          <label className={labelClass} htmlFor={`gross-${id}`}>
            Gross pay per period
          </label>
          <div className="mt-1 flex gap-2">
            <input
              id={`gross-${id}`}
              value={grossPerPeriod}
              onChange={(e) => setGrossPerPeriod(e.target.value)}
              placeholder="3000.00"
              inputMode="decimal"
              className={`flex-1 ${inputClass}`}
            />
            <input
              aria-label="Currency"
              value={currency}
              onChange={(e) => setCurrency(e.target.value)}
              className={`w-16 ${inputClass}`}
            />
          </div>
        </div>
        <TakeHomeField
          id={id}
          value={netPerPeriod}
          onChange={setNetPerPeriod}
          schedule={{ cadence, anchorDate, startDate, endDate, grossPerPeriod }}
        />
        <div>
          <label className={labelClass} htmlFor={`cadence-${id}`}>
            Pay cadence
          </label>
          <select
            id={`cadence-${id}`}
            value={cadence}
            onChange={(e) => setCadence(e.target.value)}
            className={`mt-1 w-full ${inputClass}`}
          >
            {INCOME_CADENCE_OPTIONS.map((c) => (
              <option key={c} value={c}>
                {CADENCE_LABELS[c]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className={labelClass} htmlFor={`anchor-${id}`}>
            A real payday <span className="font-normal text-zinc-400">(sets the rhythm)</span>
          </label>
          <input
            id={`anchor-${id}`}
            type="date"
            value={anchorDate}
            onChange={(e) => setAnchorDate(e.target.value)}
            className={`mt-1 w-full ${inputClass}`}
          />
        </div>
        <div>
          <label className={labelClass} htmlFor={`start-${id}`}>
            Track contributions from
          </label>
          <input
            id={`start-${id}`}
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
            className={`mt-1 w-full ${inputClass}`}
          />
        </div>
        <div>
          <label className={labelClass} htmlFor={`end-${id}`}>
            Until <span className="font-normal text-zinc-400">(blank = ongoing)</span>
          </label>
          <input
            id={`end-${id}`}
            type="date"
            value={endDate}
            onChange={(e) => setEndDate(e.target.value)}
            className={`mt-1 w-full ${inputClass}`}
          />
        </div>
        <div className="sm:col-span-2">
          <label className={labelClass} htmlFor={`notes-${id}`}>
            Notes <span className="font-normal text-zinc-400">(optional)</span>
          </label>
          <input
            id={`notes-${id}`}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            className={`mt-1 w-full ${inputClass}`}
          />
        </div>
      </div>

      <label className="mt-3 flex items-center gap-1.5 text-sm">
        <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
        Active — new paydays materialize contributions
      </label>

      <div className="mt-4 flex gap-2">
        <button
          type="button"
          disabled={disabled}
          onClick={submit}
          className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm text-white disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-900"
        >
          {submitLabel}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm dark:border-zinc-700"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

/** How long the schedule fields must sit still before the suggestion is re-read. */
const SUGGEST_DEBOUNCE_MS = 400;

/**
 * Take-home per paycheck, with candidates read from deposits that already
 * landed on this schedule's paydays (ADR-049 §2).
 *
 * Suggestions are offered, never applied: each names its payee and how many
 * paydays it matched, so the user confirms a deposit stream — two benefits from
 * one payer on one day are two separate rows to choose between.
 */
function TakeHomeField({
  id,
  value,
  onChange,
  schedule,
}: {
  readonly id: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly schedule: {
    readonly cadence: string;
    readonly anchorDate: string;
    readonly startDate: string;
    readonly endDate: string;
    readonly grossPerPeriod: string;
  };
}): React.JSX.Element {
  const [suggestions, setSuggestions] = useState<readonly TakeHomeSuggestionView[] | null>(null);
  const { cadence, anchorDate, startDate, endDate, grossPerPeriod } = schedule;

  useEffect(() => {
    let stale = false;
    const timer = setTimeout(() => {
      suggestTakeHomeAction({ cadence, anchorDate, startDate, endDate, grossPerPeriod })
        .then((result) => {
          if (!stale) setSuggestions(result.suggestions ?? []);
        })
        .catch(() => {
          if (!stale) setSuggestions([]);
        });
    }, SUGGEST_DEBOUNCE_MS);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [cadence, anchorDate, startDate, endDate, grossPerPeriod]);

  return (
    <div>
      <label className={labelClass} htmlFor={`net-${id}`}>
        Take-home per period{" "}
        <span className="font-normal text-zinc-400">(what reaches the bank; optional)</span>
      </label>
      <input
        id={`net-${id}`}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={suggestions?.[0]?.amount ?? "2400.00"}
        inputMode="decimal"
        className={`mt-1 w-full ${inputClass}`}
      />
      {suggestions === null ? (
        <p className="mt-1 text-xs text-zinc-500">Looking for matching deposits…</p>
      ) : suggestions.length === 0 ? (
        <p className="mt-1 text-xs text-zinc-500">
          No income deposits line up with these paydays yet. Leave blank to share observed take-home
          evenly.
        </p>
      ) : (
        <ul className="mt-1 space-y-1" aria-label="Take-home found in deposits">
          {suggestions.map((s) => (
            <li
              key={`${s.payee}-${s.amount}`}
              className="flex flex-wrap items-center gap-x-2 text-xs text-zinc-500"
            >
              <button
                type="button"
                onClick={() => onChange(s.amount)}
                disabled={value === s.amount}
                className="rounded border border-zinc-300 px-1.5 py-0.5 font-mono text-zinc-800 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-200"
              >
                {value === s.amount ? `Using ${s.amountDisplay}` : `Use ${s.amountDisplay}`}
              </button>
              <span>
                {s.payee} · {s.matchedPaydays} of {s.expectedPaydays} paydays · latest{" "}
                {s.latestDisplay} on {s.latestDate}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
