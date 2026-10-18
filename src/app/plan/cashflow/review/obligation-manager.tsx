"use client";

import { type CategoryOption, CategoryPicker } from "@/components/category-picker.tsx";
import { Button } from "@/components/ui/button.tsx";
import { OBLIGATION_CADENCES } from "@/lib/schedule/cadence.ts";
import {
  OBLIGATION_AMOUNT_MODE_OPTIONS,
  OBLIGATION_DIRECTION_OPTIONS,
} from "@/lib/schemas/cashflow.ts";
import { useRouter } from "next/navigation";
import { useId, useState, useTransition } from "react";
import {
  deactivateObligationAction,
  reactivateObligationAction,
  saveObligationAction,
} from "./actions.ts";
import type { AccountView, ObligationView } from "./view-models.ts";

/**
 * Manual obligation CRUD (P16-25, ADR-036 §3).
 *
 * Detection cannot see a bill the household pays outside this app, or one that
 * has not run long enough to be a series yet. Adding by hand is the whole reason
 * ADR-036 §3 exists, and this is that surface.
 *
 * ── Deactivate, not delete ─────────────────────────────────────────────────
 * There is no delete control, and its absence is the point (CLAUDE.md
 * §Database). The occurrence history explains the household's past months and
 * is what the residual attribution reads; deleting the schedule cascades that
 * away. "Stop" pauses materialization and leaves the past intact, and a stopped
 * obligation can be resumed — which is also the right route when a series
 * genuinely restarts, because a fresh obligation would orphan the history.
 *
 * ── The amount edit says what it does ──────────────────────────────────────
 * Already-materialized occurrences snapshot their own expected amount (ADR-037
 * §5 consequence 2), so raising the rent changes what is projected from here on
 * and leaves what was expected in March exactly as it was. The form states that
 * out loud, because a silent no-effect-on-history edit reads as a bug.
 *
 * Money arrives pre-formatted (CLAUDE.md §Money); only the editable amount
 * travels as a raw string, and it is never parsed here.
 */

interface Props {
  readonly obligations: readonly ObligationView[];
  readonly accounts: readonly AccountView[];
  readonly categories: readonly CategoryOption[];
}

const inputClass =
  "rounded border border-zinc-300 px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900";

export function ObligationManager({ obligations, accounts, categories }: Props): React.JSX.Element {
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);

  const active = obligations.filter((o) => o.active);
  const stopped = obligations.filter((o) => !o.active);

  if (accounts.length === 0) {
    return (
      <p className="mt-3 text-sm text-zinc-500">
        Add a checking, savings or credit-card account first — a bill has to be paid from somewhere.
      </p>
    );
  }

  return (
    <>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <p className="text-sm text-zinc-500">
          {active.length === 0
            ? "No confirmed bills yet. Until there is at least one, the projection can only use a flat spending rate."
            : `${active.length} bill${active.length === 1 ? "" : "s"} on the calendar.`}
        </p>
        <Button
          type="button"
          onClick={() => setAdding((open) => !open)}
          aria-expanded={adding}
          aria-controls="add-obligation-form"
          variant="secondary"
        >
          {adding ? "Cancel" : "Add a bill"}
        </Button>
      </div>

      {adding && (
        <div id="add-obligation-form" className="mt-4">
          <ObligationForm
            accounts={accounts}
            categories={categories}
            onDone={() => setAdding(false)}
          />
        </div>
      )}

      {active.length > 0 && (
        <ul className="mt-4 divide-y divide-zinc-100 dark:divide-zinc-900">
          {active.map((obligation) => (
            <ObligationRow
              key={obligation.id}
              obligation={obligation}
              accounts={accounts}
              categories={categories}
              editing={editing === obligation.id}
              onEdit={() => setEditing(editing === obligation.id ? null : obligation.id)}
              onDone={() => setEditing(null)}
            />
          ))}
        </ul>
      )}

      {stopped.length > 0 && (
        <section aria-labelledby="stopped-heading" className="mt-8">
          <h3 id="stopped-heading" className="font-medium text-sm text-zinc-500">
            Stopped
          </h3>
          <p className="mt-1 text-xs text-zinc-500">
            No longer projected. Their history is kept, so past months still add up.
          </p>
          <ul className="mt-2 divide-y divide-zinc-100 dark:divide-zinc-900">
            {stopped.map((obligation) => (
              <ObligationRow
                key={obligation.id}
                obligation={obligation}
                accounts={accounts}
                categories={categories}
                editing={editing === obligation.id}
                onEdit={() => setEditing(editing === obligation.id ? null : obligation.id)}
                onDone={() => setEditing(null)}
              />
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

function ObligationRow({
  obligation,
  accounts,
  categories,
  editing,
  onEdit,
  onDone,
}: {
  readonly obligation: ObligationView;
  readonly accounts: readonly AccountView[];
  readonly categories: readonly CategoryOption[];
  readonly editing: boolean;
  readonly onEdit: () => void;
  readonly onDone: () => void;
}): React.JSX.Element {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  function toggleActive(): void {
    setError(null);
    startTransition(async () => {
      const result = obligation.active
        ? await deactivateObligationAction(obligation.id)
        : await reactivateObligationAction(obligation.id);
      if (result.error) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  return (
    <li className="py-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="font-medium text-sm">{obligation.label}</span>
        <span className="text-xs text-zinc-500">
          {obligation.expectedDisplay} · {obligation.cadence} ·{" "}
          {obligation.direction === "outflow" ? "payment" : "receipt"} · {obligation.accountName}
          {obligation.source === "detected" ? " · found in your history" : ""}
        </span>
        <span className="ml-auto flex gap-2">
          <Button type="button" onClick={onEdit} aria-expanded={editing} variant="quiet">
            {editing ? "Close" : "Edit"}
          </Button>
          <Button type="button" onClick={toggleActive} disabled={pending} variant="secondary">
            {obligation.active ? "Stop" : "Resume"}
          </Button>
        </span>
      </div>

      {error && (
        <p role="alert" className="mt-2 text-red-600 text-sm dark:text-red-400">
          {error}
        </p>
      )}

      {editing && (
        <div className="mt-3">
          <ObligationForm
            obligation={obligation}
            accounts={accounts}
            categories={categories}
            onDone={onDone}
          />
        </div>
      )}
    </li>
  );
}

function ObligationForm({
  obligation,
  accounts,
  categories,
  onDone,
}: {
  readonly obligation?: ObligationView;
  readonly accounts: readonly AccountView[];
  readonly categories: readonly CategoryOption[];
  readonly onDone: () => void;
}): React.JSX.Element {
  const fieldId = useId();
  const [categoryId, setCategoryId] = useState<string | null>(obligation?.categoryId ?? null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  const errorId = `${fieldId}-error`;

  function submit(formData: FormData): void {
    setError(null);
    formData.set("categoryId", categoryId ?? "");
    startTransition(async () => {
      const result = await saveObligationAction({}, formData);
      if (result.error) {
        setError(result.error);
        return;
      }
      onDone();
      router.refresh();
    });
  }

  return (
    <form action={submit} className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
      {obligation && <input type="hidden" name="id" value={obligation.id} />}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field id={`${fieldId}-label`} label="Name">
          <input
            id={`${fieldId}-label`}
            name="label"
            required
            maxLength={120}
            defaultValue={obligation?.label ?? ""}
            placeholder="Mortgage"
            className={inputClass}
            aria-describedby={error ? errorId : undefined}
          />
        </Field>

        <Field id={`${fieldId}-account`} label="Paid from">
          <select
            id={`${fieldId}-account`}
            name="accountId"
            required
            defaultValue={obligation?.accountId ?? accounts[0]?.id}
            className={inputClass}
          >
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.name} — {account.institution}
              </option>
            ))}
          </select>
        </Field>

        <Field id={`${fieldId}-amount`} label="Amount" hint="Just the number — no minus sign.">
          <input
            id={`${fieldId}-amount`}
            name="expectedAmount"
            required
            inputMode="decimal"
            defaultValue={obligation?.expectedAmount ?? ""}
            placeholder="2150.00"
            className={inputClass}
            aria-describedby={`${fieldId}-amount-hint${error ? ` ${errorId}` : ""}`}
          />
        </Field>

        <Field id={`${fieldId}-direction`} label="Direction">
          <select
            id={`${fieldId}-direction`}
            name="direction"
            defaultValue={obligation?.direction ?? "outflow"}
            className={inputClass}
          >
            {OBLIGATION_DIRECTION_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {option === "outflow" ? "Money out (a bill)" : "Money in (a receipt)"}
              </option>
            ))}
          </select>
        </Field>

        <Field id={`${fieldId}-cadence`} label="Repeats">
          <select
            id={`${fieldId}-cadence`}
            name="cadence"
            defaultValue={obligation?.cadence ?? "monthly"}
            className={inputClass}
          >
            {OBLIGATION_CADENCES.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </Field>

        <Field
          id={`${fieldId}-anchor`}
          label="A date it landed"
          hint="Sets which day of the period the bill falls on."
        >
          <input
            id={`${fieldId}-anchor`}
            name="anchorDate"
            type="date"
            required
            defaultValue={obligation?.anchorDate ?? ""}
            className={inputClass}
            aria-describedby={`${fieldId}-anchor-hint`}
          />
        </Field>

        <Field id={`${fieldId}-start`} label="Track from">
          <input
            id={`${fieldId}-start`}
            name="startDate"
            type="date"
            required
            defaultValue={obligation?.startDate ?? ""}
            className={inputClass}
          />
        </Field>

        <Field id={`${fieldId}-end`} label="Ends (optional)" hint="Leave blank if it is ongoing.">
          <input
            id={`${fieldId}-end`}
            name="endDate"
            type="date"
            defaultValue={obligation?.endDate ?? ""}
            className={inputClass}
            aria-describedby={`${fieldId}-end-hint`}
          />
        </Field>

        <Field
          id={`${fieldId}-mode`}
          label="Amount behaviour"
          hint="A varying bill is re-priced from recent actuals and matched more loosely."
        >
          <select
            id={`${fieldId}-mode`}
            name="amountMode"
            defaultValue={obligation?.amountMode ?? "fixed"}
            className={inputClass}
            aria-describedby={`${fieldId}-mode-hint`}
          >
            {OBLIGATION_AMOUNT_MODE_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {option === "fixed" ? "Same every time" : "Varies (a utility bill)"}
              </option>
            ))}
          </select>
        </Field>

        <div className="flex flex-col gap-1 text-xs text-zinc-500">
          <span>Category</span>
          <CategoryPicker categories={categories} value={categoryId} onChange={setCategoryId} />
        </div>
      </div>

      <label className="mt-3 flex items-center gap-2 text-sm">
        <input type="checkbox" name="active" defaultChecked={obligation?.active ?? true} />
        Include in the projection
      </label>

      {obligation && (
        <p className="mt-3 text-xs text-zinc-500">
          Changing the amount affects future dates only. Bills already on the calendar keep the
          amount that was expected at the time, so past months still add up the way they did.
        </p>
      )}

      {error && (
        <p id={errorId} role="alert" className="mt-3 text-red-600 text-sm dark:text-red-400">
          {error}
        </p>
      )}

      <div className="mt-4 flex gap-2">
        <Button type="submit" variant="commit" pending={pending} pendingLabel="Saving…">
          {obligation ? "Save changes" : "Add bill"}
        </Button>
        <Button type="button" onClick={onDone} variant="secondary">
          Cancel
        </Button>
      </div>
    </form>
  );
}

/** A labelled field with optional hint text, wired for screen readers. */
function Field({
  id,
  label,
  hint,
  children,
}: {
  readonly id: string;
  readonly label: string;
  readonly hint?: string;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-xs text-zinc-500">
        {label}
      </label>
      {children}
      {hint && (
        <span id={`${id}-hint`} className="text-xs text-zinc-400">
          {hint}
        </span>
      )}
    </div>
  );
}
