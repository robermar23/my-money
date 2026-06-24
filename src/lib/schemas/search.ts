import { Money } from "@/lib/money/money.ts";
import { z } from "zod";
import { isoDateSchema, moneyAmountSchema } from "./account.ts";

/**
 * Transaction search/filter validation (Phase 12, ADR-027/028).
 *
 * Parses the URL `searchParams` of the per-account and cross-account
 * transaction views at the boundary (CLAUDE.md §Zod). Everything arrives as
 * strings (URL params); blank values normalize to `undefined` so the query
 * builder omits that clause. Money/date values stay strings end-to-end — the
 * schema only validates shape and ordering; comparisons use `Money`, never
 * native float math.
 */

/** The sentinel category filter that means "transactions with no category." */
export const UNCATEGORIZED = "uncategorized" as const;

/** "" → undefined; otherwise passes the value through for the wrapped schema. */
const blankToUndefined = (v: unknown): unknown =>
  typeof v === "string" && v.trim() === "" ? undefined : v;

/** Optional free-text term. Length-bounded; actual sanitization is server-side. */
const optionalText = z.preprocess(blankToUndefined, z.string().trim().max(100).optional());

const optionalDate = z.preprocess(blankToUndefined, isoDateSchema.optional());

/** Amount-range bound: a signed money string (range is on the stored sign). */
const optionalAmount = z.preprocess(blankToUndefined, moneyAmountSchema.optional());

/** A category id (uuid) or the literal "uncategorized"; optional. */
const optionalCategory = z.preprocess(
  blankToUndefined,
  z.union([z.literal(UNCATEGORIZED), z.string().uuid()]).optional(),
);

const optionalAccountId = z.preprocess(blankToUndefined, z.string().uuid().optional());

/** A 1-based page number; coerced from the URL string, defaulting to 1. */
const pageSchema = z.coerce.number().int().positive().catch(1);

/** True when `a ≤ b` as money (no native float math). */
function moneyLte(a: string, b: string): boolean {
  const diff = Money.fromString(a, "USD").sub(Money.fromString(b, "USD"));
  return diff.isNegative() || diff.isZero();
}

/**
 * The full transaction-filter schema. `accountId` absent ⇒ all-accounts mode
 * (the cross-account `/transactions` view); present ⇒ scoped to one account.
 * Two ordering refinements keep impossible ranges out of the query.
 */
export const transactionFilterSchema = z
  .object({
    q: optionalText,
    from: optionalDate,
    to: optionalDate,
    minAmount: optionalAmount,
    maxAmount: optionalAmount,
    categoryId: optionalCategory,
    accountId: optionalAccountId,
    page: pageSchema,
  })
  .refine((d) => !(d.from && d.to) || d.from <= d.to, {
    message: "The start date must be on or before the end date.",
    path: ["from"],
  })
  .refine((d) => !(d.minAmount && d.maxAmount) || moneyLte(d.minAmount, d.maxAmount), {
    message: "The minimum amount must be less than or equal to the maximum.",
    path: ["minAmount"],
  });

export type TransactionFilterInput = z.infer<typeof transactionFilterSchema>;
