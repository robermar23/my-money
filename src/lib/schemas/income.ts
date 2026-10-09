import type { IncomeCadence } from "@/db/schema/income-sources.ts";
import type {
  EmployeeContributionBasis,
  EmployerMatchBasis,
} from "@/db/schema/retirement-contributions.ts";
import { z } from "zod";
import { isoDateSchema, moneyAmountSchema } from "./account.ts";

/**
 * Boundary validation for the income-management forms (P14-13, ADR-030).
 *
 * These schemas guard the two things a user can define in Phase 14: a paycheck
 * (`income_sources`) and the 401k rule that draws from it
 * (`retirement_contributions`). Everything arrives from `FormData` as strings,
 * so every field is validated as a string and stays one — money and percentages
 * are handed to Drizzle as `numeric` strings and only ever combined through
 * `Money`/Decimal (CLAUDE.md §Money). Nothing here converts a money value to a
 * `number`; the two `Number()` calls below are *bound checks* on percentages
 * (mirroring `annualRateSchema` in [account.ts](./account.ts)) whose results are
 * discarded, never stored or arithmetic'd.
 *
 * Each refinement here mirrors a CHECK constraint on the table. The database is
 * the authority; these exist so the user gets a sentence instead of a Postgres
 * error. If you add a CHECK, add the matching refinement.
 *
 * **Not validated here:** that a chosen `holdingId` belongs to the chosen
 * `accountId`. That is a cross-row database fact, and a schema fed by the client
 * cannot be trusted to know it — the server action re-checks it against the DB
 * before writing (see `saveContributionRuleAction`).
 */

/** Percent ceiling shared by every percentage field (mirrors the table CHECKs). */
const MAX_PERCENT = 100;

/**
 * The form vocabularies, declared here rather than imported from
 * `src/db/schema/` — that is the convention for this directory (see
 * `CATEGORY_KINDS` in [category.ts](./category.ts)), and it matters: the client
 * form components import these lists, and importing the Drizzle table modules
 * would drag `drizzle-orm/pg-core` into the browser bundle.
 *
 * The `satisfies` clauses are type-only (`import type` above erases at compile
 * time) and prove each list is a subset of its column's CHECK vocabulary, so a
 * renamed value fails the build instead of failing at INSERT.
 */
export const INCOME_CADENCE_OPTIONS = [
  "weekly",
  "biweekly",
  "semimonthly",
  "monthly",
] as const satisfies readonly IncomeCadence[];

export const EMPLOYEE_BASIS_OPTIONS = [
  "percent",
  "amount",
] as const satisfies readonly EmployeeContributionBasis[];

export const MATCH_BASIS_OPTIONS = [
  "none",
  "percent_of_gross",
  "percent_of_contribution",
  "amount",
] as const satisfies readonly EmployerMatchBasis[];

/**
 * A money amount that may not be negative. Gross pay and contributions are money
 * *in*; a negative would corrupt both cost basis and the savings rate, and the
 * `income_sources_gross_non_negative_check` CHECK rejects it anyway.
 *
 * The sign test is a string test, not `Number(s) < 0` — no money value round-trips
 * through a float, not even to be compared.
 */
export const nonNegativeMoneySchema = moneyAmountSchema.refine((s) => !s.startsWith("-"), {
  message: "Must be zero or more",
});

/**
 * A non-negative decimal with up to four places — the scale of
 * `employee_value` / `match_value` (`numeric(18,4)`) and `match_cap_percent`
 * (`numeric(7,4)`). The regex admits no leading `-`, so negatives are rejected
 * before any refinement runs.
 */
export const decimalValueSchema = z
  .string()
  .trim()
  .min(1, "A value is required")
  .regex(/^\d+(\.\d{1,4})?$/, "Use a non-negative number with up to four decimal places");

/** An optional field that an HTML form submits as an empty string when blank. */
const optionalText = <T extends z.ZodTypeAny>(schema: T) => schema.optional().or(z.literal(""));

/** Empty string / undefined → null, for columns that are nullable in Postgres. */
const blankToNull = (value: string | undefined): string | null =>
  value === undefined || value.trim() === "" ? null : value.trim();

/**
 * An HTML checkbox submits `"on"` when checked and is ABSENT when unchecked —
 * so a missing value must read as `false`, not as a validation error. Hidden
 * mirror inputs may also send `"true"`/`"false"`.
 */
export const checkboxSchema = z.preprocess(
  (value) => value === "on" || value === "true" || value === true,
  z.boolean(),
);

/**
 * Create or edit an income source (the paycheck).
 *
 * `anchorDate` is deliberately unconstrained relative to `startDate`: the anchor
 * *phases* the schedule (which Friday is payday) and may legitimately sit before
 * the start, or after it, without changing which dates the job materializes.
 * Only `startDate`/`endDate` bound the window — and that ordering is checked.
 */
export const incomeSourceSchema = z
  .object({
    name: z.string().trim().min(1, "Name is required").max(120),
    cadence: z.enum(INCOME_CADENCE_OPTIONS),
    grossPerPeriod: nonNegativeMoneySchema,
    /** Optional user-stated take-home (ADR-049). Blank = let the projection share observed net. */
    netPerPeriod: optionalText(nonNegativeMoneySchema),
    currency: z.string().trim().toUpperCase().length(3, "Use a 3-letter currency code"),
    anchorDate: isoDateSchema,
    startDate: isoDateSchema,
    endDate: optionalText(isoDateSchema),
    notes: optionalText(z.string().trim().max(2000)),
    active: checkboxSchema,
  })
  .superRefine((value, ctx) => {
    // Mirrors income_sources_date_order_check. ISO dates compare correctly as
    // strings, so no Date parsing (and no timezone) is involved.
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
    endDate: blankToNull(value.endDate),
    netPerPeriod: blankToNull(value.netPerPeriod),
    notes: blankToNull(value.notes),
  }));

export type IncomeSourceInput = z.infer<typeof incomeSourceSchema>;

/**
 * The schedule fields the take-home suggestion reads (ADR-049 §2). Gross is
 * optional — it only orders candidates — and a malformed one is dropped rather
 * than failing the suggestion.
 */
export const takeHomeSuggestionSchema = z
  .object({
    cadence: z.enum(INCOME_CADENCE_OPTIONS),
    anchorDate: isoDateSchema,
    startDate: isoDateSchema,
    endDate: optionalText(isoDateSchema),
    grossPerPeriod: z.string().optional(),
  })
  .transform((value) => ({
    ...value,
    endDate: blankToNull(value.endDate),
    grossPerPeriod: nonNegativeMoneySchema.safeParse(value.grossPerPeriod).success
      ? (value.grossPerPeriod as string)
      : null,
  }));

/** The match shapes whose `matchValue` is a percentage rather than dollars. */
const PERCENT_MATCH_BASES = new Set(["percent_of_gross", "percent_of_contribution"]);

/**
 * Create or edit the 401k contribution rule attached to a source.
 *
 * `holdingId` is optional by design (ADR-031): a rule with no holding — or one
 * whose holding has no public price — still accrues real cost basis, it just
 * records dollars instead of buying shares.
 */
export const contributionRuleSchema = z
  .object({
    accountId: z.string().uuid("Pick an investment account"),
    holdingId: optionalText(z.string().uuid("Pick a holding from the list")),
    employeeBasis: z.enum(EMPLOYEE_BASIS_OPTIONS),
    employeeValue: decimalValueSchema,
    pretax: checkboxSchema,
    matchBasis: z.enum(MATCH_BASIS_OPTIONS),
    matchValue: decimalValueSchema,
    matchCapPercent: optionalText(decimalValueSchema),
    active: checkboxSchema,
  })
  .superRefine((value, ctx) => {
    // Mirrors retirement_contributions_employee_value_check: a percent basis is
    // a real percentage. A fixed `amount` basis has no ceiling here — an amount
    // larger than gross is CLAMPED to gross by `computeContribution`, and the
    // preview (P14-15) shows the user that clamp before they save.
    if (value.employeeBasis === "percent" && Number(value.employeeValue) > MAX_PERCENT) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["employeeValue"],
        message: "A percentage of gross cannot exceed 100%",
      });
    }
    // Mirrors retirement_contributions_match_value_check.
    if (PERCENT_MATCH_BASES.has(value.matchBasis) && Number(value.matchValue) > MAX_PERCENT) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["matchValue"],
        message: "A percentage cannot exceed 100%",
      });
    }
    // Mirrors retirement_contributions_match_cap_check.
    if (
      value.matchCapPercent !== undefined &&
      value.matchCapPercent !== "" &&
      Number(value.matchCapPercent) > MAX_PERCENT
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["matchCapPercent"],
        message: "A cap cannot exceed 100% of gross",
      });
    }
  })
  .transform((value) => ({
    ...value,
    holdingId: blankToNull(value.holdingId),
    // `none` means no match at all: normalise the two companion fields so a
    // leftover value from an earlier edit can never resurface if the basis is
    // later switched back. `computeContribution` ignores them when `none`, but
    // storing a stale number would mislead anyone reading the row.
    matchValue: value.matchBasis === "none" ? "0" : value.matchValue,
    matchCapPercent: value.matchBasis === "none" ? null : blankToNull(value.matchCapPercent),
  }));

export type ContributionRuleInput = z.infer<typeof contributionRuleSchema>;

/**
 * The preview request (P14-15). Same math fields as the rule, but no account or
 * holding: a preview computes dollars, it does not touch the ledger. Kept
 * separate so the preview stays callable for a rule that would not yet save
 * (e.g. before an account has been picked).
 */
export const contributionPreviewSchema = z.object({
  incomeSourceId: z.string().uuid("Pick an income source"),
  employeeBasis: z.enum(EMPLOYEE_BASIS_OPTIONS),
  employeeValue: decimalValueSchema,
  matchBasis: z.enum(MATCH_BASIS_OPTIONS),
  matchValue: decimalValueSchema,
  matchCapPercent: optionalText(decimalValueSchema),
});

export type ContributionPreviewInput = z.infer<typeof contributionPreviewSchema>;
