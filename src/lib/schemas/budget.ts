import { Money } from "@/lib/money/money.ts";
import { z } from "zod";

/**
 * Validation for monthly category budgets (ADR-018, P8-18).
 *
 * Money discipline (CLAUDE.md §Money): the target `amount` is validated and
 * carried as a *string*. We parse it through {@link Money} purely to reject
 * non-numeric / negative input — never to do `Number()` arithmetic — then store
 * the canonical 2-decimal string.
 */

/** A `YYYY-MM` calendar-month key. */
export const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export const monthSchema = z.string().trim().regex(MONTH_RE, "Month must be YYYY-MM");

/**
 * A money amount as a string: parseable by Money, finite, and non-negative.
 * Normalized to the canonical 2-decimal form (e.g. "50" → "50.00").
 */
const budgetAmount = z
  .string()
  .trim()
  .min(1, "Amount is required")
  .transform((raw, ctx) => {
    let money: Money;
    try {
      money = Money.fromString(raw, "USD");
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid amount" });
      return z.NEVER;
    }
    if (money.isNegative()) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Amount cannot be negative" });
      return z.NEVER;
    }
    return money.toString();
  });

export const setBudgetSchema = z.object({
  categoryId: z.string().trim().uuid("Invalid id"),
  amount: budgetAmount,
});

export type SetBudgetInput = z.infer<typeof setBudgetSchema>;

export const deleteBudgetSchema = z.object({
  categoryId: z.string().trim().uuid("Invalid id"),
});

export type DeleteBudgetInput = z.infer<typeof deleteBudgetSchema>;
