import type {
  ObligationAmountMode,
  ObligationConfidence,
  ObligationDirection,
} from "@/db/schema/scheduled-obligations.ts";
import { OBLIGATION_CADENCES } from "@/lib/schedule/cadence.ts";
import { z } from "zod";
import { isoDateSchema } from "./account.ts";
import { checkboxSchema, nonNegativeMoneySchema } from "./income.ts";

/**
 * Boundary validation for every Phase-16 input (P16-23, ADR-037 / ADR-038).
 *
 * Four surfaces post into this file: the manual obligation form (P16-25), the
 * candidate confirm and dismiss controls (P16-24), and the two projection
 * settings on `household_profile`. Everything arrives from `FormData` as
 * strings and stays one — money is handed to Drizzle as a `numeric` string and
 * only ever combined through `Money`/Decimal (CLAUDE.md §Money). The single
 * `Number()` below is a bound check on a day count, not on an amount.
 *
 * Each refinement here mirrors a CHECK constraint on the table. **The database
 * is the authority; these exist so the user gets a sentence instead of a
 * Postgres error.** If you add a CHECK, add the matching refinement — and its
 * test, since the point of a refinement is the message a person reads.
 *
 * ── Where the vocabularies come from ───────────────────────────────────────
 * `OBLIGATION_CADENCES` is IMPORTED rather than redeclared, unlike the
 * directory's usual convention (see `INCOME_CADENCE_OPTIONS` in
 * [income.ts](./income.ts)). The convention exists to keep
 * `drizzle-orm/pg-core` out of the browser bundle, and
 * [schedule/cadence.ts](../schedule/cadence.ts) is not a Drizzle module — it
 * pulls its one Drizzle reference in as a TYPE, which erases. Importing the real
 * tuple is therefore strictly better here: the form options and the CHECK cannot
 * drift, because they are the same array.
 *
 * `direction`, `amount_mode` and `confidence` DO live in a Drizzle module, so
 * they are redeclared locally with `satisfies` clauses. The type-only imports
 * above erase at compile time, and the clauses prove each list is a subset of
 * its column's CHECK vocabulary — a renamed value fails the build rather than
 * failing at INSERT.
 *
 * ── What is deliberately NOT validated here ────────────────────────────────
 * That `accountId` names a real account, that `categoryId` exists, or that a
 * confirmed candidate is one the detector actually proposed. Those are
 * cross-row database facts, and a schema fed by the client cannot know them.
 * The server actions re-check each against the DB before writing — see
 * `confirmCandidateAction`, which takes `confidence` from the SERVER's freshly
 * derived candidate and never from the form.
 */

/** Longest label the form accepts. Long enough for "Auto insurance (Subaru)". */
const LABEL_MAX = 120;

/** The projection horizon bounds, mirroring `household_profile_horizon_days_check`. */
export const HORIZON_DAYS_MIN = 14;
export const HORIZON_DAYS_MAX = 365;

export const OBLIGATION_DIRECTION_OPTIONS = [
  "outflow",
  "inflow",
] as const satisfies readonly ObligationDirection[];

export const OBLIGATION_AMOUNT_MODE_OPTIONS = [
  "fixed",
  "trailing_median",
] as const satisfies readonly ObligationAmountMode[];

export const OBLIGATION_CONFIDENCE_OPTIONS = [
  "high",
  "medium",
  "low",
] as const satisfies readonly ObligationConfidence[];

/** An optional field an HTML form submits as `""` when blank. */
const optionalText = <T extends z.ZodTypeAny>(schema: T) => schema.optional().or(z.literal(""));

/** `""`/absent → `null`, for columns that are nullable in Postgres. */
const blankToNull = (value: string | undefined): string | null =>
  value === undefined || value.trim() === "" ? null : value.trim();

/**
 * Create or edit a scheduled obligation (P16-25).
 *
 * `expectedAmount` is a POSITIVE MAGNITUDE — the sign lives in `direction`,
 * exactly as the column does. A negative expected amount would flip an outflow
 * into an inflow deep inside the projection walk where nothing would notice, and
 * `scheduled_obligations_amount_non_negative_check` rejects it anyway.
 *
 * `anchorDate` is deliberately unconstrained relative to `startDate`, the same
 * decision `incomeSourceSchema` made for the same reason: the anchor *phases*
 * the schedule (which day of the month the bill lands) and may legitimately sit
 * either side of the start without changing which dates get materialized. Only
 * `startDate`/`endDate` bound the window, and that ordering IS checked.
 */
export const obligationSchema = z
  .object({
    accountId: z.string().uuid("Pick an account"),
    categoryId: optionalText(z.string().uuid("Pick a category from the list")),
    label: z.string().trim().min(1, "A name is required").max(LABEL_MAX),
    expectedAmount: nonNegativeMoneySchema,
    direction: z.enum(OBLIGATION_DIRECTION_OPTIONS),
    currency: z.string().trim().toUpperCase().length(3, "Use a 3-letter currency code"),
    cadence: z.enum(OBLIGATION_CADENCES),
    anchorDate: isoDateSchema,
    startDate: isoDateSchema,
    endDate: optionalText(isoDateSchema),
    amountMode: z.enum(OBLIGATION_AMOUNT_MODE_OPTIONS),
    notes: optionalText(z.string().trim().max(2000)),
    active: checkboxSchema,
  })
  .superRefine((value, ctx) => {
    // Mirrors scheduled_obligations_date_order_check. ISO dates compare
    // correctly as strings, so no Date parsing (and no timezone) is involved.
    if (value.endDate !== undefined && value.endDate !== "" && value.endDate < value.startDate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["endDate"],
        message: "End date must be on or after the start date",
      });
    }
  })
  .transform((value) => ({
    ...value,
    categoryId: blankToNull(value.categoryId),
    endDate: blankToNull(value.endDate),
    notes: blankToNull(value.notes),
  }));

export type ObligationFormInput = z.infer<typeof obligationSchema>;

/**
 * Confirm a detected candidate as a real obligation (P16-24, ADR-036 §2).
 *
 * The user may correct anything the detector guessed — label, amount, cadence,
 * schedule, category — which is why this carries the whole shape rather than
 * just an id. What it deliberately does NOT carry is `confidence`: how strongly
 * the detector believed its own proposal is provenance, not a user preference,
 * and a form that could assert it would let a hand-crafted POST create a
 * `source='detected'` obligation the detector never proposed. The action reads
 * it from the server's own candidate list instead.
 *
 * `detectionKey` is the value that lands in `scheduled_obligations.detection_key`
 * and hits the partial UNIQUE index, so a double-click confirms once.
 */
export const confirmCandidateSchema = z
  .object({
    accountId: z.string().uuid("Pick an account"),
    detectionKey: z.string().trim().min(1, "Missing the detected payee"),
    categoryId: optionalText(z.string().uuid("Pick a category from the list")),
    label: z.string().trim().min(1, "A name is required").max(LABEL_MAX),
    expectedAmount: nonNegativeMoneySchema,
    direction: z.enum(OBLIGATION_DIRECTION_OPTIONS),
    cadence: z.enum(OBLIGATION_CADENCES),
    anchorDate: isoDateSchema,
    startDate: isoDateSchema,
    amountMode: z.enum(OBLIGATION_AMOUNT_MODE_OPTIONS),
  })
  .transform((value) => ({ ...value, categoryId: blankToNull(value.categoryId) }));

export type ConfirmCandidateInput = z.infer<typeof confirmCandidateSchema>;

/**
 * Confirm a schedule proposed from stated loan terms (CF-A5, ADR-047).
 *
 * Deliberately the NARROWEST of the three write schemas, and the difference is
 * the point. A detected candidate carries its whole shape here because the
 * detector guessed all of it and the user may correct any of it. A liability
 * candidate guessed nothing: the cadence is `monthly` by construction (the loan
 * amortizes in `term_months`), the anchor and start date come from the
 * household's own payments, and `amount_mode` follows from whether those
 * payments exist. So the form carries only what a person could reasonably
 * disagree with — the name, the amount, the category, and which account the
 * money leaves — and the action reads every other field from the SERVER's
 * freshly derived candidate.
 *
 * `liabilityId` lands in `scheduled_obligations.liability_id` and hits the
 * partial UNIQUE index, so a double-click confirms once.
 *
 * Note what is absent: `source`, `detectionKey`, `confidence`, `cadence`,
 * `anchorDate`, `startDate`, `amountMode`. Provenance is never form data
 * (P16-24), and a field the form cannot assert is a field a hand-crafted POST
 * cannot forge.
 */
export const confirmLiabilityCandidateSchema = z
  .object({
    liabilityId: z.string().uuid("Missing the loan"),
    // Validated against the candidate's OWN operating accounts in the action —
    // a uuid here only proves the shape, not that the household could pay from
    // it. Attaching the largest bill in the month to the wrong balance moves
    // the low-water date, which is the number this page exists to state.
    accountId: z.string().uuid("Pick the account this is paid from"),
    categoryId: optionalText(z.string().uuid("Pick a category from the list")),
    label: z.string().trim().min(1, "A name is required").max(LABEL_MAX),
    expectedAmount: nonNegativeMoneySchema,
  })
  .transform((value) => ({ ...value, categoryId: blankToNull(value.categoryId) }));

export type ConfirmLiabilityCandidateInput = z.infer<typeof confirmLiabilityCandidateSchema>;

/**
 * Dismiss or snooze a liability candidate (CF-A5).
 *
 * Same two-state model and same storage as {@link dismissCandidateSchema} —
 * `recommendation_dismissals` under the shared `obligation_candidate` rule id,
 * with the subject key `"liability <liabilityId>"` (ADR-047 §5). A household
 * that pays its mortgage from an account this app does not track should be able
 * to make the suggestion go away in one click.
 */
export const dismissLiabilityCandidateSchema = z.object({
  liabilityId: z.string().uuid("Missing the loan"),
  snoozeDays: optionalText(
    z
      .string()
      .trim()
      .regex(/^\d{1,4}$/, "Use a whole number of days")
      .refine((s) => Number(s) >= 1, { message: "A snooze must be at least one day" }),
  ),
});

export type DismissLiabilityCandidateInput = z.infer<typeof dismissLiabilityCandidateSchema>;

/**
 * Dismiss or snooze a candidate (P16-24).
 *
 * Blank `snoozeDays` dismisses indefinitely; a number suppresses the candidate
 * until then, after which it returns on its own. Same two-state model as
 * recommendation dismissals (ADR-032 §3), and the same storage — see
 * `dismissCandidateAction`.
 */
export const dismissCandidateSchema = z.object({
  accountId: z.string().uuid("Pick an account"),
  detectionKey: z.string().trim().min(1, "Missing the detected payee"),
  snoozeDays: optionalText(
    z
      .string()
      .trim()
      .regex(/^\d{1,4}$/, "Use a whole number of days")
      .refine((s) => Number(s) >= 1, { message: "A snooze must be at least one day" }),
  ),
});

export type DismissCandidateInput = z.infer<typeof dismissCandidateSchema>;

/** Deactivate (never delete) an obligation — CLAUDE.md §Database. */
export const deactivateObligationSchema = z.object({
  id: z.string().uuid("Unknown obligation"),
});

/**
 * The two projection settings on `household_profile` (ADR-037 §4, ADR-038 §5).
 *
 * Both are OVERRIDES of a checked-in default, so blank is the normal state and
 * means "use the default" — never "zero". That distinction is load-bearing for
 * the floor in particular: a stored `0.00` says "I want no cushion", while blank
 * says "I have not thought about it", and only the first should silence a
 * prompt to set one.
 *
 * The floor may not be negative. A negative buffer is not "spend $200 past
 * empty" — it is a data-entry error, and it would ADD to safe-to-spend in the
 * one direction that gets a household into trouble (ADR-038 §5).
 */
export const cashFlowSettingsSchema = z
  .object({
    cashFloor: optionalText(nonNegativeMoneySchema),
    projectionHorizonDays: optionalText(
      z
        .string()
        .trim()
        .regex(/^\d{1,3}$/, "Use a whole number of days"),
    ),
  })
  .superRefine((value, ctx) => {
    // Mirrors household_profile_horizon_days_check. Beyond ~90 days the residual
    // discretionary rate dominates and the line stops being information; the
    // upper bound is a guard rail, not an endorsement (ADR-038 §4).
    if (value.projectionHorizonDays === undefined || value.projectionHorizonDays === "") return;
    const days = Number(value.projectionHorizonDays);
    if (days < HORIZON_DAYS_MIN || days > HORIZON_DAYS_MAX) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["projectionHorizonDays"],
        message: `The horizon must be between ${HORIZON_DAYS_MIN} and ${HORIZON_DAYS_MAX} days`,
      });
    }
  })
  .transform((value) => ({
    cashFloor: blankToNull(value.cashFloor),
    projectionHorizonDays: blankToNull(value.projectionHorizonDays),
  }));

export type CashFlowSettingsInput = z.infer<typeof cashFlowSettingsSchema>;
