"use server";

import { requireUser } from "@/lib/auth/require-user.ts";
import { deleteBudget, setBudget } from "@/lib/budgets/queries.ts";
import { applyBudgetSuggestions } from "@/lib/budgets/suggestions.ts";
import {
  applyBudgetSuggestionsSchema,
  deleteBudgetSchema,
  setBudgetSchema,
} from "@/lib/schemas/budget.ts";
import { revalidatePath } from "next/cache";

/**
 * Server actions for monthly category budgets (ADR-018, P8-18).
 *
 * Convention (PLAN7 server-action rules): `requireUser()` → Zod validate →
 * mutate → `revalidatePath`. Single-user app, so ownership is implicit. Money is
 * validated via {@link setBudgetSchema} (Money.fromString, never `Number`).
 */
export interface BudgetActionResult {
  error?: string;
  ok?: boolean;
}

export async function setBudgetAction(
  _prev: BudgetActionResult,
  formData: FormData,
): Promise<BudgetActionResult> {
  await requireUser();
  const parsed = setBudgetSchema.safeParse({
    categoryId: formData.get("categoryId"),
    amount: formData.get("amount"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  await setBudget(parsed.data.categoryId, parsed.data.amount);
  revalidatePath("/analysis/budgets");
  return { ok: true };
}

export async function deleteBudgetAction(categoryId: string): Promise<BudgetActionResult> {
  await requireUser();
  const parsed = deleteBudgetSchema.safeParse({ categoryId });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  await deleteBudget(parsed.data.categoryId);
  revalidatePath("/analysis/budgets");
  return { ok: true };
}

/** The confirm half of the preview → confirm flow, plus what it wrote. */
export interface ApplySuggestionsResult extends BudgetActionResult {
  applied?: number;
}

/**
 * Apply the budget targets the user confirmed (P15-27).
 *
 * The **confirm** half of preview → confirm: the caller passes exactly the rows
 * the user ticked, after any edits they made to the amounts. This action never
 * re-derives the suggestion list — doing so would discard those edits and turn a
 * reviewed change into a silent bulk mutation (CLAUDE.md §Importers).
 *
 * @param targets - `(categoryId, amount)` pairs from the confirmed preview.
 * @returns The number of budgets written, or a validation error.
 */
export async function applyBudgetSuggestionsAction(
  targets: readonly { categoryId: string; amount: string }[],
): Promise<ApplySuggestionsResult> {
  await requireUser();
  const parsed = applyBudgetSuggestionsSchema.safeParse({ targets });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const applied = await applyBudgetSuggestions(parsed.data.targets);
  revalidatePath("/analysis/budgets");
  revalidatePath("/plan");
  return { ok: true, applied };
}
