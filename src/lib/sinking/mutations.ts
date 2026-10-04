import "server-only";

import { db } from "@/db/client.ts";
import { plannedExpenses } from "@/db/schema/index.ts";
import type { PlannedExpenseStatus } from "@/db/schema/planned-expenses.ts";
import { and, eq } from "drizzle-orm";

/**
 * The sinking fund's only database writes (P18-25, ADR-043 §3).
 *
 * Four functions over one table, and every one of them is a single statement.
 * The validation happened at the Zod boundary
 * ([schemas/planned-expense.ts](../schemas/planned-expense.ts)) and the
 * authority is the table's own CHECKs; nothing here re-decides either.
 *
 * ── Separate from [queries.ts](./queries.ts) on purpose ───────────────────
 * `src/lib/advice/` imports the read module, and the privacy-egress allowlist is
 * how that import is justified. A rule that computes a recommendation must not
 * be one `import` away from a function that can write a row — splitting the
 * files is what makes that property reviewable instead of asserted.
 *
 * ── No delete ─────────────────────────────────────────────────────────────
 * There is no `deletePlannedExpense`, and the absence is the design (CLAUDE.md
 * §Database — historical financial data is the entire product). A cost that is
 * not coming after all is `cancelled`: it stops accruing (ADR-044 §7), stays
 * visible with its status, and leaves the household's record of what it once
 * expected to pay intact. The same posture the obligation surface takes with
 * Stop rather than Delete, for the same reason.
 *
 * ── The transitions are guarded in the WHERE clause ───────────────────────
 * {@link markPlannedExpensePaid} and {@link cancelPlannedExpense} both match on
 * `status = 'planned'`, so a second click, a double-submit, or a mark-paid on an
 * already-cancelled row updates **nothing** and says so by returning `false`.
 * Checking the status in a prior `select` would be a race between two tabs; a
 * conditional `UPDATE` is atomic, and it is one round trip rather than two.
 *
 * ── Privacy ───────────────────────────────────────────────────────────────
 * `label` and `notes` are the most sensitive strings this app holds (the table's
 * own header). Nothing here reaches `console`, and no value is echoed into a
 * returned error.
 */

/** The fields a create or an edit writes. Money stays a string (CLAUDE.md §Money). */
export interface PlannedExpenseWrite {
  readonly label: string;
  readonly amount: string;
  readonly currency: string;
  readonly dueDate: string;
  readonly accrualStartDate: string;
  readonly categoryId: string | null;
  readonly notes: string | null;
}

/** `planned`, as the column's own default states it. */
const PLANNED = "planned" satisfies PlannedExpenseStatus;

/**
 * Record a new one-off future cost.
 *
 * `status` is left to the column default rather than written here, so there is
 * exactly one place that decides what a new row starts as.
 *
 * @param write - Validated fields. Never logged.
 * @returns The new row's id.
 * @throws If a CHECK rejects the row — a malformed write fails loudly rather
 *   than storing a state the accrual cannot read.
 */
export async function createPlannedExpense(write: PlannedExpenseWrite): Promise<string> {
  const [row] = await db
    .insert(plannedExpenses)
    .values(write)
    .returning({ id: plannedExpenses.id });
  if (row === undefined) throw new Error("Insert returned no row");
  return row.id;
}

/**
 * Edit an existing cost.
 *
 * Does **not** touch `status`, `paid_at` or `cancelled_at`: a status the edit
 * form could assert is a status a hand-crafted POST could set to anything, and
 * the two timestamps would then disagree with it. The transitions are their own
 * functions below.
 *
 * @param id - The row to update.
 * @param write - Validated fields. Never logged.
 * @returns `true` when a row matched, `false` when the id is unknown.
 */
export async function updatePlannedExpense(
  id: string,
  write: PlannedExpenseWrite,
): Promise<boolean> {
  const updated = await db
    .update(plannedExpenses)
    .set({ ...write, updatedAt: new Date() })
    .where(eq(plannedExpenses.id, id))
    .returning({ id: plannedExpenses.id });
  return updated.length > 0;
}

/**
 * Mark a cost paid: it happened, and it stops accruing (ADR-044 §7).
 *
 * `paid_at` is an audit trail, not a funding figure — it records *when the
 * household said so*, and there is deliberately no amount beside it. A "how
 * much was actually paid" column is the first step toward the envelope this
 * phase does not build (§Domain Scope).
 *
 * @param id - The row to transition.
 * @param now - The instant to stamp. Injected so a test is deterministic.
 * @returns `true` when a `planned` row was transitioned, `false` otherwise —
 *   including a second click on the same row, and a row already cancelled.
 */
export async function markPlannedExpensePaid(id: string, now: Date = new Date()): Promise<boolean> {
  const updated = await db
    .update(plannedExpenses)
    .set({ status: "paid" satisfies PlannedExpenseStatus, paidAt: now, updatedAt: now })
    .where(and(eq(plannedExpenses.id, id), eq(plannedExpenses.status, PLANNED)))
    .returning({ id: plannedExpenses.id });
  return updated.length > 0;
}

/**
 * Cancel a cost: it is not coming after all.
 *
 * The row stays. See the header on why there is no delete.
 *
 * @param id - The row to transition.
 * @param now - The instant to stamp. Injected so a test is deterministic.
 * @returns `true` when a `planned` row was transitioned, `false` otherwise —
 *   including a double-cancel, and a row already paid.
 */
export async function cancelPlannedExpense(id: string, now: Date = new Date()): Promise<boolean> {
  const updated = await db
    .update(plannedExpenses)
    .set({ status: "cancelled" satisfies PlannedExpenseStatus, cancelledAt: now, updatedAt: now })
    .where(and(eq(plannedExpenses.id, id), eq(plannedExpenses.status, PLANNED)))
    .returning({ id: plannedExpenses.id });
  return updated.length > 0;
}
