import type { PlannedExpenseStatus } from "@/db/schema/planned-expenses.ts";
import { todayIso } from "@/lib/prices/types.ts";
import { z } from "zod";
import { isoDateSchema } from "./account.ts";
import { nonNegativeMoneySchema } from "./income.ts";

/**
 * Boundary validation for planned-expense entry (P18-04, ADR-043 / ADR-044).
 *
 * `planned_expenses` is the one new table in Phase 18, and these schemas are
 * the only door into it. Everything arrives from `FormData` as strings and
 * stays one — `amount` is handed to Drizzle as a `numeric` string and only ever
 * combined through `Money`/Decimal ([CLAUDE.md](../../../CLAUDE.md) §Money).
 * **There is no `Number()` anywhere in this file**, not even to compare an
 * amount against zero: the positivity test below is a string test, the same
 * decision `nonNegativeMoneySchema` made and for the same reason.
 *
 * Each refinement mirrors a CHECK on the table. **The database is the
 * authority; these exist so the user gets a sentence instead of a Postgres
 * error.** If you add a CHECK, add the matching refinement — and its test,
 * since the point of a refinement is the message a person reads.
 *
 * -- Create vs. edit, and why they differ in exactly one rule --------------
 * ADR-043 §6: `due_date` is validated as future-or-today **on entry**, but the
 * column is unconstrained relative to `now`, because time passes and a row that
 * was legal yesterday must not become illegal today. So the create schema
 * enforces `dueDate >= today` and the edit schema does not — otherwise a cost
 * would become uneditable the morning after its due date, exactly when the
 * household needs to mark it paid or push it out.
 *
 * That is the ONLY difference. Both share the amount, label, date-order and
 * length rules, because both write the same row.
 *
 * -- What is deliberately NOT here ----------------------------------------
 * No `fundedAmount`, no `funded` flag, no funding account, no contribution
 * entry: there is no such column, by design (ADR-043 §3, §Domain Scope). A form
 * field that cannot be stored is a feature someone will later "finish".
 *
 * `status` is also absent from both schemas. A new row is `planned` by database
 * default, and the two transitions a user can make — mark paid, cancel — are
 * their own one-click actions carrying only an id (Batch 6), not an editable
 * dropdown. A status the form could assert is a status a hand-crafted POST
 * could set to anything, and `paid_at` / `cancelled_at` would not follow it.
 * {@link PLANNED_EXPENSE_STATUS_OPTIONS} exists for rendering a filter, not for
 * accepting one.
 *
 * `label` and `notes` are PII (see the table header) — they are validated here
 * and never logged, not even in a validation error.
 */

/** Longest label the form accepts. Long enough for "New roof (north side)". */
const LABEL_MAX = 120;

/** Longest note the form accepts, matching the obligation form's cap. */
const NOTES_MAX = 2000;

/**
 * The statuses a surface may filter by.
 *
 * Re-declared locally rather than imported from the table, following this
 * directory's convention: `planned-expenses.ts` is a Drizzle module, and
 * importing its runtime value would pull `drizzle-orm/pg-core` into a client
 * bundle. The type-only import above erases, and the `satisfies` clause proves
 * this list is a subset of the column's CHECK vocabulary — a renamed status
 * fails the build rather than failing at query time.
 *
 * Not an input vocabulary — see the header.
 */
export const PLANNED_EXPENSE_STATUS_OPTIONS = [
  "planned",
  "paid",
  "cancelled",
] as const satisfies readonly PlannedExpenseStatus[];

/** An optional field an HTML form submits as `""` when blank. */
const optionalText = <T extends z.ZodTypeAny>(schema: T) => schema.optional().or(z.literal(""));

/** `""`/absent → `null`, for columns that are nullable in Postgres. */
const blankToNull = (value: string | undefined): string | null =>
  value === undefined || value.trim() === "" ? null : value.trim();

/**
 * A money amount that is strictly positive.
 *
 * The table's CHECK allows `0` — a zero-amount row is harmless and the
 * constraint exists to reject negatives — but there is no reason to *record* a
 * free cost, and a zero would contribute a `"0.00"` requirement that makes the
 * cost list longer without making the number different.
 *
 * The test is a string test. `"0"`, `"0.00"` and `"000.0"` are all zero and are
 * all rejected; nothing round-trips through a float to find that out.
 */
const positiveMoneySchema = nonNegativeMoneySchema.refine((s) => !/^0+(\.0+)?$/.test(s.trim()), {
  message: "Amount must be more than zero",
});

/**
 * The fields both the create and the edit form post.
 *
 * `accrualStartDate` is optional on the wire and resolved to today when blank
 * (ADR-044 §4) — stored and explicit, never inferred from `created_at` or from
 * `due_date − 12 months`, both of which would move a displayed figure for
 * reasons the user cannot see.
 */
const plannedExpenseFields = z.object({
  label: z.string().trim().min(1, "A name is required").max(LABEL_MAX),
  amount: positiveMoneySchema,
  currency: z.string().trim().toUpperCase().length(3, "Use a 3-letter currency code"),
  dueDate: isoDateSchema,
  accrualStartDate: optionalText(isoDateSchema),
  categoryId: optionalText(z.string().uuid("Pick a category from the list")),
  notes: optionalText(z.string().trim().max(NOTES_MAX)),
});

type PlannedExpenseFields = z.infer<typeof plannedExpenseFields>;

/**
 * Resolve the accrual start the row will actually carry.
 *
 * Called from both the refinement and the transform, so the date-order rule
 * checks the value that gets stored rather than the value that was typed.
 *
 * `todayIso()` is evaluated per parse, not at module load: a long-running
 * server process would otherwise default every row to the day it booted.
 */
const resolveAccrualStart = (value: PlannedExpenseFields): string =>
  value.accrualStartDate === undefined || value.accrualStartDate.trim() === ""
    ? todayIso()
    : value.accrualStartDate.trim();

/**
 * Mirrors `planned_expenses_date_order_check`. ISO dates compare correctly as
 * strings, so no `Date` parsing — and no timezone — is involved.
 */
const checkDateOrder = (value: PlannedExpenseFields, ctx: z.RefinementCtx): void => {
  if (resolveAccrualStart(value) > value.dueDate) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["accrualStartDate"],
      message: "Start setting aside on or before the due date",
    });
  }
};

/** Normalize the optional columns to what Postgres stores. */
const normalize = (value: PlannedExpenseFields) => ({
  ...value,
  accrualStartDate: resolveAccrualStart(value),
  categoryId: blankToNull(value.categoryId),
  notes: blankToNull(value.notes),
});

/**
 * Record a new one-off future cost.
 *
 * The create-only rule is `dueDate >= today`: a cost that has already happened
 * is not something to set money aside for, and entering one is almost always a
 * typo in the year. See the header for why the edit schema drops it.
 */
export const plannedExpenseCreateSchema = plannedExpenseFields
  .superRefine((value, ctx) => {
    checkDateOrder(value, ctx);
    // ADR-043 §6 — entry only. The column itself is unconstrained relative to
    // now, and the edit path deliberately allows a past date.
    if (value.dueDate < todayIso()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["dueDate"],
        message: "The due date is in the past",
      });
    }
  })
  .transform(normalize);

export type PlannedExpenseCreateInput = z.infer<typeof plannedExpenseCreateSchema>;

/**
 * Edit an existing cost.
 *
 * Carries the row id and drops the future-date rule — a row whose due date has
 * passed must stay editable, which is the whole point of ADR-043 §6.
 */
export const plannedExpenseEditSchema = plannedExpenseFields
  .extend({ id: z.string().uuid("Unknown planned expense") })
  .superRefine(checkDateOrder)
  .transform(normalize);

export type PlannedExpenseEditInput = z.infer<typeof plannedExpenseEditSchema>;

/**
 * Mark a cost paid, or cancel it (Batch 6).
 *
 * Deliberately an id and nothing else. Which transition happened is which
 * action was called, so the form cannot assert a status that `paid_at` /
 * `cancelled_at` would then disagree with.
 */
export const plannedExpenseIdSchema = z.object({
  id: z.string().uuid("Unknown planned expense"),
});

export type PlannedExpenseIdInput = z.infer<typeof plannedExpenseIdSchema>;
