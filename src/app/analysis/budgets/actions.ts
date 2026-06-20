"use server";

import { requireUser } from "@/lib/auth/require-user.ts";
import { deleteBudget, setBudget } from "@/lib/budgets/queries.ts";
import { deleteBudgetSchema, setBudgetSchema } from "@/lib/schemas/budget.ts";
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
