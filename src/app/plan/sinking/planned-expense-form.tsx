"use client";

import { type CategoryOption, CategoryPicker } from "@/components/category-picker.tsx";
import { Button } from "@/components/ui/button.tsx";
import type { CostCollision } from "@/lib/sinking/types.ts";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, useTransition } from "react";
import {
  cancelPlannedExpenseAction,
  markPlannedExpensePaidAction,
  savePlannedExpenseAction,
} from "./actions.ts";
import type { PlannedExpenseView } from "./view-models.ts";

/**
 * The planned-expense manager (P18-24, ADR-043 / ADR-045 §4).
 *
 * The only client code on `/plan/sinking` — the figure, the verdict and the
 * itemized table are all server-rendered, and nothing here does arithmetic on a
 * dollar (CLAUDE.md §Money). Follows
 * [obligation-manager.tsx](../cashflow/review/obligation-manager.tsx): a
 * collapsed add form, one row per record, an inline edit form.
 *
 * ── The labels say what the app does, and what it does not ────────────────
 * The amount field is **"What this will cost"**, not "how much to save". The
 * distinction is the whole phase: this app computes a requirement against a real
 * balance, and it does not partition, reserve, or move money (CLAUDE.md §Domain
 * Scope). A field labelled "how much to save" invites the reading that the app
 * is holding it somewhere, and a note under the form says plainly that it is
 * not — once, in the place where a household would form the wrong belief.
 *
 * ── The collision warning, and why "Record it anyway" is a real button ────
 * ADR-045 §4. The server checks for an obligation occurrence this cost looks
 * like a duplicate of and returns the warning **instead of writing**, with no
 * error. This renders it inline, names the obligation, links to where that
 * schedule is managed, and offers recording it anyway as a plain primary
 * button — not a hidden path behind a second disclosure, because a genuine
 * coincidence is ordinary and the household is the only party that knows which
 * case it is. Focus moves to the warning when it appears, so a keyboard or
 * screen-reader user meets it rather than discovering it.
 *
 * ── No funding controls ───────────────────────────────────────────────────
 * No "funded so far" field, no contribution entry, no funding account picker.
 * There is no such column (ADR-043 §3), and a form field that cannot be stored
 * is a feature someone will later "finish".
 *
 * ── Rendering user text ───────────────────────────────────────────────────
 * `label` and `notes` are the household's own words. They are rendered as
 * children and as input values, where React escapes them. There is no
 * `dangerouslySetInnerHTML` anywhere in this file, and no label is interpolated
 * into a `title`, an `aria-label` or an `href` — the places escaping would not
 * cover.
 */

interface Props {
  readonly expenses: readonly PlannedExpenseView[];
  readonly categories: readonly CategoryOption[];
  readonly currency: string;
  /** `YYYY-MM-DD`, so a new cost's accrual starts the day it is recorded. */
  readonly today: string;
}

const inputClass =
  "rounded border border-zinc-300 px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900";

/** Where a colliding obligation's schedule is managed. */
const OBLIGATION_HREF = "/plan/cashflow/review";

/**
 * Display formatters for the collision warning, local to this island.
 *
 * Every other figure on `/plan/sinking` is formatted on the server and arrives
 * as a display string. A collision cannot be: it comes back from a server action
 * in the ADR-045 §4 `CostCollision` shape, which is the contract the detector
 * states and not a view model to widen. Importing the page's own
 * [view-models.ts](./view-models.ts) would pull `Money` — and so decimal.js —
 * into the client bundle for two labels.
 *
 * `Intl` is the one display edge CLAUDE.md §Money sanctions, and these do no
 * arithmetic: a string in, a string out, nothing combined, nothing rounded back.
 */
const COLLISION_MONEY = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const COLLISION_DATE = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "long",
  day: "numeric",
  timeZone: "UTC",
});

export function PlannedExpenseManager({
  expenses,
  categories,
  currency,
  today,
}: Props): React.JSX.Element {
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);

  const open = expenses.filter((expense) => expense.status === "planned");
  const closed = expenses.filter((expense) => expense.status !== "planned");

  return (
    <>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <p className="text-sm text-zinc-500">
          {open.length === 0
            ? "Nothing recorded yet. A cost you know is coming — a premium, a tax bill, a car service, a dental bill — is what this figure is computed from."
            : `${open.length} cost${open.length === 1 ? "" : "s"} recorded.`}
        </p>
        <Button
          type="button"
          onClick={() => setAdding((isOpen) => !isOpen)}
          aria-expanded={adding}
          aria-controls="add-planned-expense-form"
          variant="secondary"
        >
          {adding ? "Cancel" : "Add a cost"}
        </Button>
      </div>

      {adding && (
        <div id="add-planned-expense-form" className="mt-4">
          <PlannedExpenseForm
            categories={categories}
            currency={currency}
            today={today}
            onDone={() => setAdding(false)}
          />
        </div>
      )}

      {open.length > 0 && (
        <ul className="mt-4 divide-y divide-zinc-100 dark:divide-zinc-900">
          {open.map((expense) => (
            <PlannedExpenseRow
              key={expense.id}
              expense={expense}
              categories={categories}
              currency={currency}
              today={today}
              editing={editing === expense.id}
              onEdit={() => setEditing(editing === expense.id ? null : expense.id)}
              onDone={() => setEditing(null)}
            />
          ))}
        </ul>
      )}

      {closed.length > 0 && (
        <section aria-labelledby="settled-heading" className="mt-8">
          <h3 id="settled-heading" className="font-medium text-sm text-zinc-500">
            Paid and cancelled
          </h3>
          <p className="mt-1 text-xs text-zinc-500">
            No longer counted in the figure above. They are kept, so your record of what you
            expected to pay stays intact.
          </p>
          <ul className="mt-2 divide-y divide-zinc-100 dark:divide-zinc-900">
            {closed.map((expense) => (
              <li key={expense.id} className="flex flex-wrap items-baseline gap-x-3 py-2 text-sm">
                <span className="text-zinc-500 line-through">{expense.label}</span>
                <span className="text-xs text-zinc-500">
                  {expense.amountDisplay} · due {expense.dueDateDisplay} · {expense.status}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

/**
 * The two one-click transitions, for a past-due row in the itemized table.
 *
 * Exported separately so the server-rendered table can carry them on exactly
 * the rows they apply to, without the table itself becoming a client component.
 */
export function CostRowActions({ id }: { readonly id: string }): React.JSX.Element {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  function run(action: (id: string) => Promise<{ error?: string }>): void {
    setError(null);
    startTransition(async () => {
      const result = await action(id);
      if (result.error) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  return (
    <span className="flex flex-wrap items-center gap-2">
      <Button
        type="button"
        onClick={() => run(markPlannedExpensePaidAction)}
        disabled={pending}
        variant="commit"
        size="xs"
      >
        Mark paid
      </Button>
      <Button
        type="button"
        onClick={() => run(cancelPlannedExpenseAction)}
        disabled={pending}
        variant="quiet"
        size="xs"
      >
        Cancel it
      </Button>
      {error && (
        <span role="alert" className="text-red-600 text-xs dark:text-red-400">
          {error}
        </span>
      )}
    </span>
  );
}

function PlannedExpenseRow({
  expense,
  categories,
  currency,
  today,
  editing,
  onEdit,
  onDone,
}: {
  readonly expense: PlannedExpenseView;
  readonly categories: readonly CategoryOption[];
  readonly currency: string;
  readonly today: string;
  readonly editing: boolean;
  readonly onEdit: () => void;
  readonly onDone: () => void;
}): React.JSX.Element {
  return (
    <li className="py-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="font-medium text-sm">{expense.label}</span>
        <span className="text-xs text-zinc-500">
          {expense.amountDisplay} · due {expense.dueDateDisplay}
        </span>
        {expense.pastDue && (
          <span className="rounded bg-amber-100 px-1.5 py-0.5 text-amber-900 text-xs dark:bg-amber-950 dark:text-amber-300">
            past due
          </span>
        )}
        <span className="ml-auto flex items-center gap-2">
          <Button type="button" onClick={onEdit} aria-expanded={editing} variant="quiet">
            {editing ? "Close" : "Edit"}
          </Button>
          <CostRowActions id={expense.id} />
        </span>
      </div>

      {editing && (
        <div className="mt-3">
          <PlannedExpenseForm
            expense={expense}
            categories={categories}
            currency={currency}
            today={today}
            onDone={onDone}
          />
        </div>
      )}
    </li>
  );
}

export function PlannedExpenseForm({
  expense,
  categories,
  currency,
  today,
  onDone,
}: {
  readonly expense?: PlannedExpenseView;
  readonly categories: readonly CategoryOption[];
  readonly currency: string;
  readonly today: string;
  readonly onDone: () => void;
}): React.JSX.Element {
  const fieldId = useId();
  const [categoryId, setCategoryId] = useState<string | null>(expense?.categoryId ?? null);
  const [error, setError] = useState<string | null>(null);
  const [collisions, setCollisions] = useState<readonly CostCollision[]>([]);
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  const warningRef = useRef<HTMLDivElement | null>(null);
  /** The submission the warning is about, so "Record it anyway" can resend it. */
  const heldRef = useRef<FormData | null>(null);

  const errorId = `${fieldId}-error`;
  const warningId = `${fieldId}-collision`;

  // The warning is the one thing on this form a user must not scroll past.
  useEffect(() => {
    if (collisions.length > 0) warningRef.current?.focus();
  }, [collisions]);

  function send(formData: FormData): void {
    setError(null);
    formData.set("categoryId", categoryId ?? "");
    formData.set("currency", currency);
    startTransition(async () => {
      const result = await savePlannedExpenseAction({}, formData);
      if (result.error) {
        setError(result.error);
        return;
      }
      if (result.collisions && result.collisions.length > 0) {
        heldRef.current = formData;
        setCollisions(result.collisions);
        return;
      }
      setCollisions([]);
      heldRef.current = null;
      onDone();
      router.refresh();
    });
  }

  function recordAnyway(): void {
    const held = heldRef.current;
    if (held === null) return;
    held.set("acknowledgeCollisions", "true");
    setCollisions([]);
    send(held);
  }

  return (
    <form action={send} className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
      {expense && <input type="hidden" name="id" value={expense.id} />}

      <div className="grid gap-3 sm:grid-cols-2">
        <Field id={`${fieldId}-label`} label="What it is">
          <input
            id={`${fieldId}-label`}
            name="label"
            required
            maxLength={120}
            defaultValue={expense?.label ?? ""}
            placeholder="New roof"
            className={inputClass}
            aria-describedby={error ? errorId : undefined}
          />
        </Field>

        <Field
          id={`${fieldId}-amount`}
          label="What this will cost"
          hint="The whole cost, not what you plan to set aside each month."
        >
          <input
            id={`${fieldId}-amount`}
            name="amount"
            required
            inputMode="decimal"
            defaultValue={expense?.amount ?? ""}
            placeholder="12000.00"
            className={inputClass}
            aria-describedby={`${fieldId}-amount-hint${error ? ` ${errorId}` : ""}`}
          />
        </Field>

        <Field id={`${fieldId}-due`} label="When it is due">
          <input
            id={`${fieldId}-due`}
            name="dueDate"
            type="date"
            required
            defaultValue={expense?.dueDate ?? ""}
            className={inputClass}
          />
        </Field>

        <Field
          id={`${fieldId}-start`}
          label="Start setting aside from"
          hint="Defaults to today. Spreading the cost from an earlier date raises what is required now."
        >
          <input
            id={`${fieldId}-start`}
            name="accrualStartDate"
            type="date"
            defaultValue={expense?.accrualStartDate ?? today}
            className={inputClass}
            aria-describedby={`${fieldId}-start-hint`}
          />
        </Field>

        <div className="flex flex-col gap-1 text-xs text-zinc-500">
          <span>Category (optional)</span>
          <CategoryPicker categories={categories} value={categoryId} onChange={setCategoryId} />
        </div>

        <Field id={`${fieldId}-notes`} label="Notes (optional)">
          <input
            id={`${fieldId}-notes`}
            name="notes"
            maxLength={2000}
            defaultValue={expense?.notes ?? ""}
            className={inputClass}
          />
        </Field>
      </div>

      <p className="mt-3 text-xs text-zinc-500">
        This records a cost, not a transfer. The app works out what you should already have set
        aside and compares it with your savings — it does not move or reserve any money.
      </p>

      {collisions.length > 0 && (
        <div
          ref={warningRef}
          id={warningId}
          role="alert"
          tabIndex={-1}
          className="mt-3 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-800 dark:bg-amber-950"
        >
          <p className="font-medium">This looks like a bill you already track.</p>
          <ul className="mt-1 space-y-1 text-xs">
            {collisions.map((collision) => (
              <li key={`${collision.obligationId}:${collision.dueDate}`}>
                {collision.obligationLabel} is already on your calendar for{" "}
                {COLLISION_DATE.format(new Date(`${collision.dueDate}T00:00:00Z`))} at{" "}
                {COLLISION_MONEY.format(Number(collision.amount))}.{" "}
                <Link href={OBLIGATION_HREF} className="underline">
                  See that schedule
                </Link>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs">
            Recording it here as well would count the same money twice. If these really are two
            different costs, record it anyway — nothing has been saved yet.
          </p>
          <div className="mt-3 flex gap-2">
            <Button type="button" onClick={recordAnyway} disabled={pending} variant="commit">
              Record it anyway
            </Button>
            <Button
              type="button"
              onClick={() => {
                setCollisions([]);
                heldRef.current = null;
                onDone();
              }}
              variant="secondary"
            >
              Never mind
            </Button>
          </div>
        </div>
      )}

      {error && (
        <p id={errorId} role="alert" className="mt-3 text-red-600 text-sm dark:text-red-400">
          {error}
        </p>
      )}

      <div className="mt-4 flex gap-2">
        <Button type="submit" variant="commit" pending={pending} pendingLabel="Saving…">
          {expense ? "Save changes" : "Record it"}
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
