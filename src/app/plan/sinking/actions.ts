"use server";

import { requireUser } from "@/lib/auth/require-user.ts";
import {
  plannedExpenseCreateSchema,
  plannedExpenseEditSchema,
  plannedExpenseIdSchema,
} from "@/lib/schemas/planned-expense.ts";
import { detectCollisions } from "@/lib/sinking/collisions.ts";
import {
  cancelPlannedExpense,
  createPlannedExpense,
  markPlannedExpensePaid,
  updatePlannedExpense,
} from "@/lib/sinking/mutations.ts";
import { listCollidableOccurrences, listPlannedExpenses } from "@/lib/sinking/queries.ts";
import type { CostCollision } from "@/lib/sinking/types.ts";
import { revalidatePath } from "next/cache";

/**
 * Server actions for the sinking-fund surface (P18-25, ADR-043 / ADR-045 §4).
 *
 * Four entry points over one table. Each one validates at the Zod boundary
 * ([schemas/planned-expense.ts](../../../lib/schemas/planned-expense.ts)),
 * writes through [sinking/mutations.ts](../../../lib/sinking/mutations.ts), and
 * revalidates the three surfaces that read planned expenses.
 *
 * ── The collision warns BEFORE the write, and never blocks it ─────────────
 * ADR-045 §4. A planned expense that looks like an obligation occurrence is
 * usually the same cost entered twice, and double-counting it would inflate the
 * requirement with nothing on the page to explain why. But "usually" is not
 * "always": two $400 costs in the same week is an ordinary month, and the app
 * cannot tell which case it is looking at. So it warns, and the household — who
 * does know — decides.
 *
 * **The check runs before the insert, and that ordering is the ADR's, not a
 * preference.** "Record it anyway" is only an offer if the recording has not
 * happened yet; warning afterwards would mean the figure on the page already
 * counts the cost twice, and the household's only remedy would be to go cancel
 * the row they just created — an extra step on the *likelier* of the two cases.
 * Warning first costs one extra click on the genuine coincidence, which is the
 * rarer one, and never lets a double count reach the headline at all.
 *
 * It is a warning and not a rule: `acknowledgeCollisions` is a client-supplied
 * bypass by design, and the server does not remember the answer. Nothing here
 * merges, filters, or adjusts a total (ADR-045 §4).
 *
 * ── Status is never an input ───────────────────────────────────────────────
 * Neither write schema has a `status` field, so a hand-crafted POST cannot set
 * one — and the two transitions carry an id and nothing else. Which transition
 * happened is which action was called, so `paid_at` and `cancelled_at` cannot
 * end up disagreeing with the status beside them. Both transitions are guarded
 * in the `UPDATE`'s own WHERE clause (`status = 'planned'`), so a double-click
 * or a second tab writes nothing rather than re-stamping a timestamp.
 *
 * ── No delete ─────────────────────────────────────────────────────────────
 * There is no delete action, and the absence is deliberate (CLAUDE.md
 * §Database — historical financial data is the entire product). Cancel sets the
 * status and `cancelled_at`; the row stays, stops accruing, and keeps the
 * household's record of what it once expected to pay.
 *
 * ── Privacy ───────────────────────────────────────────────────────────────
 * `label` and `notes` are the most sensitive free text in this app. Nothing here
 * reaches `console`, and every error returned to the user is a sentence written
 * in this file — never a Postgres message, a constraint name, or a value echoed
 * back (CLAUDE.md §Privacy).
 */

export interface SinkingActionResult {
  readonly ok?: true;
  readonly error?: string;
  /**
   * Obligation occurrences this cost may duplicate.
   *
   * Returned **instead of** a write, with no `error`: nothing is wrong, and
   * nothing was recorded. Re-submitting with `acknowledgeCollisions` set records
   * it. See the header.
   */
  readonly collisions?: readonly CostCollision[];
  /** Set on create so the client can collapse its form and focus the new row. */
  readonly createdId?: string;
}

/** Every surface that reads planned expenses, so a change shows up at once. */
function revalidateSinkingSurfaces(): void {
  revalidatePath("/plan/sinking");
  // `/plan` renders the `sinking_fund` card and `/plan/cashflow` carries the
  // sentence that links here — both read the same rows (P18-26, P18-27).
  revalidatePath("/plan");
  revalidatePath("/plan/cashflow");
}

/** Read a FormData field as a string, mapping absent/File values to undefined. */
function field(formData: FormData, key: string): string | undefined {
  const value = formData.get(key);
  return typeof value === "string" ? value : undefined;
}

/** The fields both write schemas share, read off the form. */
function writeFields(formData: FormData): Record<string, string | undefined> {
  return {
    label: field(formData, "label"),
    amount: field(formData, "amount"),
    currency: field(formData, "currency") || "USD",
    dueDate: field(formData, "dueDate"),
    accrualStartDate: field(formData, "accrualStartDate") ?? "",
    categoryId: field(formData, "categoryId") ?? "",
    notes: field(formData, "notes") ?? "",
  };
}

/**
 * Find the obligation occurrences a candidate cost may duplicate.
 *
 * A failure here must not block the save. The warning is a courtesy, and a
 * household that cannot record a cost because the *duplicate check* broke is
 * strictly worse off than one that records a cost without being warned. So a
 * throw degrades to "no collisions" and the write proceeds.
 */
async function collisionsFor(candidate: {
  label: string;
  amount: string;
  currency: string;
  dueDate: string;
}): Promise<readonly CostCollision[]> {
  try {
    return detectCollisions(candidate, await listCollidableOccurrences(candidate.dueDate));
  } catch {
    return [];
  }
}

/**
 * Record a new cost, or edit an existing one.
 *
 * One action for both, because the form is one form; which it is is whether the
 * payload carries an `id`. The schemas differ in exactly one rule — create
 * requires a future-or-today due date and edit does not (ADR-043 §6).
 *
 * The edit path runs the same collision check: an edit that moves a cost onto an
 * obligation's due date creates the same double count that entering it there
 * would have.
 *
 * @param _prev - Previous result, for `useActionState` compatibility. Unused.
 * @param formData - The submitted form. An `acknowledgeCollisions` of `true`
 *   skips the duplicate warning, which is what "Record it anyway" sends.
 * @returns `{ ok, createdId? }` on a write, `{ collisions }` when the household
 *   should look before it writes, or `{ error }` with a sentence.
 */
export async function savePlannedExpenseAction(
  _prev: SinkingActionResult,
  formData: FormData,
): Promise<SinkingActionResult> {
  await requireUser();

  const id = field(formData, "id");
  const fields = writeFields(formData);
  const acknowledged = field(formData, "acknowledgeCollisions") === "true";

  if (id !== undefined && id !== "") {
    const parsed = plannedExpenseEditSchema.safeParse({ ...fields, id });
    if (!parsed.success) {
      return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
    }
    // The schemas' shared `normalize` transform is typed over the common
    // fields, so its return type does not carry `id` even though the parse
    // validated it. Naming the write fields is one line and keeps `id` out of
    // the `SET` clause, which a rest-spread would have put there.
    const { label, amount, currency, dueDate, accrualStartDate, categoryId, notes } = parsed.data;
    const write = { label, amount, currency, dueDate, accrualStartDate, categoryId, notes };
    const rowId = id;

    if (!acknowledged) {
      const collisions = await collisionsFor(write);
      if (collisions.length > 0) return { collisions };
    }

    if (!(await updatePlannedExpense(rowId, write))) {
      return { error: "That cost is no longer on your list." };
    }

    revalidateSinkingSurfaces();
    return { ok: true };
  }

  const parsed = plannedExpenseCreateSchema.safeParse(fields);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  if (!acknowledged) {
    const collisions = await collisionsFor(parsed.data);
    if (collisions.length > 0) return { collisions };
  }

  const createdId = await createPlannedExpense(parsed.data);
  revalidateSinkingSurfaces();
  return { ok: true, createdId };
}

/**
 * Mark a cost paid: it happened, and it stops accruing (ADR-044 §7).
 *
 * @param id - The row's uuid.
 * @returns `{ ok }`, or `{ error }` when the row is unknown or is not `planned`
 *   — including a second click, which writes nothing.
 */
export async function markPlannedExpensePaidAction(id: string): Promise<SinkingActionResult> {
  await requireUser();

  const parsed = plannedExpenseIdSchema.safeParse({ id });
  if (!parsed.success) return { error: "Unknown planned expense" };

  if (!(await markPlannedExpensePaid(parsed.data.id))) {
    // One sentence covering both cases, because the user does not need to know
    // which: either way the row is not waiting on this click any more.
    return { error: "That cost is already marked paid or cancelled." };
  }

  revalidateSinkingSurfaces();
  return { ok: true };
}

/**
 * Cancel a cost: it is not coming after all. The row stays.
 *
 * @param id - The row's uuid.
 * @returns `{ ok }`, or `{ error }` on a double-cancel or an already-paid row.
 */
export async function cancelPlannedExpenseAction(id: string): Promise<SinkingActionResult> {
  await requireUser();

  const parsed = plannedExpenseIdSchema.safeParse({ id });
  if (!parsed.success) return { error: "Unknown planned expense" };

  if (!(await cancelPlannedExpense(parsed.data.id))) {
    return { error: "That cost is already marked paid or cancelled." };
  }

  revalidateSinkingSurfaces();
  return { ok: true };
}

/**
 * The costs the manager renders.
 *
 * Re-exported through the action module so the client island has one import
 * surface and never reaches a `server-only` module itself.
 */
export async function listPlannedExpensesAction(): ReturnType<typeof listPlannedExpenses> {
  await requireUser();
  return listPlannedExpenses();
}
