import { ACCOUNT_SUBTYPES, ACCOUNT_TAX_TREATMENTS } from "@/db/schema/accounts.ts";
import { CATEGORY_NECESSITIES } from "@/db/schema/categories.ts";
import { z } from "zod";
import { isoDateSchema, moneyAmountSchema } from "./account.ts";

/**
 * Zod schemas for every input Phase 15 added (PLAN15 P15-28).
 *
 * These validate the data-entry surfaces in Batch 5 — the forms that make the
 * ADR-033 columns real. Two things make this file worth reading rather than
 * skimming:
 *
 * ── 1. It is the UNIT GUARD ────────────────────────────────────────────────
 * The schema carries two rate conventions on purpose (see
 * [accounts.ts](../../db/schema/accounts.ts) header):
 *
 *   - **APY is a PERCENTAGE.** `"4.5"` means 4.5%.
 *   - **APR is a decimal FRACTION.** `"0.2499"` means 24.99%.
 *
 * The single most likely data-entry error in this whole phase is typing an APR
 * the way it is printed on a statement — `24.99` — which would model a 2499%
 * card and produce a payoff plan that is not merely wrong but absurd. The 0–1
 * bound rejects it at the boundary with a message that says what to type
 * instead. The DB CHECK is the backstop; this is the part a human reads.
 *
 * The mirror-image mistake — typing `0.045` into APY, meaning 4.5% — CANNOT be
 * rejected here, because 0.045% is a real (if unattractive) yield. It is
 * addressed in the field's placeholder and help text, which is the honest place
 * for it: a validator that guesses at intent is worse than one that doesn't.
 *
 * ── 2. Empty string means "clear it", not "invalid" ────────────────────────
 * Every one of these columns is nullable and NULL is MEANINGFUL — an unset
 * subtype must stay distinguishable from a deliberate one (ADR-033 §1), and an
 * unrecorded APR must reach the engine as `unknown_input` rather than a
 * confident zero. HTML forms cannot submit `null`, so `""` is the wire
 * representation of "not recorded", accepted everywhere and mapped back to NULL
 * by the server action. `.optional().or(z.literal(""))` is the shipped idiom for
 * that (see [account.ts](./account.ts)); it is used unchanged here.
 *
 * Money values stay strings throughout (CLAUDE.md §Money). Nothing here parses a
 * dollar figure to a number — `Number()` appears only inside range refinements
 * on rates and years, never on an amount.
 */

/** An optional numeric-string field: a value, or `""` meaning "not recorded". */
const optionalNumeric = z.string().trim().optional().or(z.literal(""));

/** True when a form field carries no value (absent, or the empty string). */
function isBlank(value: string | undefined): boolean {
  return value === undefined || value.trim().length === 0;
}

/**
 * Whether a percentage field is within `[0, 100]`, e.g. APY.
 *
 * @param value - The raw form value; blank passes (see the file header).
 * @returns True when unset or in range.
 */
function percentInRange(value: string | undefined): boolean {
  if (isBlank(value)) return true;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && n <= 100;
}

/** A decimal fraction in `[0, 1]`, e.g. APR. Blank passes. */
function fractionInRange(value: string | undefined): boolean {
  if (isBlank(value)) return true;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && n <= 1;
}

/** An integer within an inclusive range. Blank passes. */
function intInRange(value: string | undefined, min: number, max: number): boolean {
  if (isBlank(value)) return true;
  const n = Number(value);
  return Number.isInteger(n) && n >= min && n <= max;
}

// ── Account terms (P15-29) ──────────────────────────────────────────────────

/**
 * Cash-account subtype, APY, CD maturity and tax treatment.
 *
 * The `maturityDate` refinement is the one that carries meaning rather than
 * hygiene: a maturity date on a checking account is not a harmless stray value,
 * it is a sign the user believes they are describing something the app will act
 * on. Rejecting it says plainly that the field belongs to CDs.
 */
export const accountTermsSchema = z
  .object({
    subtype: z.enum(ACCOUNT_SUBTYPES).optional().or(z.literal("")),
    /** PERCENTAGE — "4.5" is 4.5%. See the file header on units. */
    apy: optionalNumeric,
    maturityDate: isoDateSchema.optional().or(z.literal("")),
    taxTreatment: z.enum(ACCOUNT_TAX_TREATMENTS).optional().or(z.literal("")),
  })
  .refine((v) => percentInRange(v.apy), {
    path: ["apy"],
    message: "APY is a percentage between 0 and 100 (enter 4.5 for 4.5%)",
  })
  .refine((v) => isBlank(v.maturityDate) || v.subtype === "cd", {
    path: ["maturityDate"],
    message: "A maturity date only applies to a CD — set the subtype to CD first",
  });

export type AccountTermsInput = z.infer<typeof accountTermsSchema>;

// ── Credit-line terms (P15-30) ──────────────────────────────────────────────

/**
 * Revolving terms for a credit card.
 *
 * Every field is optional: a household may know the limit and not the APR, and
 * the engine reports what is missing rather than assuming (ADR-032 consequence
 * 1). The APR bound is the unit guard described in the file header.
 *
 * The minimum payment may be a flat amount, a percentage of the balance, or
 * both — issuers commonly bill the greater of the two, and the payoff engine
 * takes the max, so neither is rejected in the presence of the other.
 */
export const creditLineTermsSchema = z
  .object({
    /** Decimal FRACTION — "0.2499" is 24.99%. See the file header on units. */
    apr: optionalNumeric,
    creditLimit: moneyAmountSchema.optional().or(z.literal("")),
    minimumPayment: moneyAmountSchema.optional().or(z.literal("")),
    /** PERCENTAGE of the balance — "2" is 2%. */
    minimumPaymentPercent: optionalNumeric,
    notes: z.string().trim().max(500).optional().or(z.literal("")),
  })
  .refine((v) => fractionInRange(v.apr), {
    path: ["apr"],
    message: "APR is a decimal fraction between 0 and 1 (enter 0.2499 for 24.99%)",
  })
  .refine((v) => percentInRange(v.minimumPaymentPercent), {
    path: ["minimumPaymentPercent"],
    message: "Minimum payment percent is between 0 and 100 (enter 2 for 2%)",
  })
  .refine((v) => isBlank(v.creditLimit) || !v.creditLimit?.startsWith("-"), {
    path: ["creditLimit"],
    message: "Credit limit cannot be negative",
  })
  .refine((v) => isBlank(v.minimumPayment) || !v.minimumPayment?.startsWith("-"), {
    path: ["minimumPayment"],
    message: "Minimum payment cannot be negative",
  });

export type CreditLineTermsInput = z.infer<typeof creditLineTermsSchema>;

// ── Category classification (P15-31) ────────────────────────────────────────

/**
 * One category's necessity + baseline exclusion.
 *
 * `necessity: ""` clears the classification back to unclassified, which is a
 * legitimate thing to want: a user who mis-classified a category needs a way
 * back to "I haven't decided", and the honest unclassified-share figure depends
 * on that state being reachable.
 */
export const categoryClassificationSchema = z.object({
  categoryId: z.string().trim().uuid("Invalid id"),
  necessity: z.enum(CATEGORY_NECESSITIES).optional().or(z.literal("")),
  excludedFromBaseline: z.boolean().optional(),
});

export type CategoryClassificationInput = z.infer<typeof categoryClassificationSchema>;

/**
 * The bulk "classify unclassified" pass.
 *
 * Bounded at 200 and de-duplicated for the same reason the budget-apply schema
 * is (see [budget.ts](./budget.ts)): with a category appearing twice, which
 * classification wins would depend on update order, and a bulk write whose
 * outcome depends on iteration order is a bug waiting for a bigger taxonomy.
 */
export const bulkClassifySchema = z.object({
  assignments: z
    .array(categoryClassificationSchema)
    .min(1, "Select at least one category to classify")
    .max(200, "Too many categories in one pass")
    .refine(
      (rows) => new Set(rows.map((r) => r.categoryId)).size === rows.length,
      "The same category appears twice",
    ),
});

export type BulkClassifyInput = z.infer<typeof bulkClassifySchema>;

// ── Household profile + members (P15-32) ────────────────────────────────────

/** Bounds mirroring the `household_profile` CHECKs. */
const RESERVE_MONTHS_MIN = 1;
const RESERVE_MONTHS_MAX = 60;
const RETIREMENT_AGE_MIN = 30;
const RETIREMENT_AGE_MAX = 100;

/** Earliest plausible birth year, mirroring the `household_members` CHECK. */
const BIRTH_YEAR_MIN = 1900;

/**
 * The singleton household profile.
 *
 * Every field is an OVERRIDE of a checked-in default (see
 * [household.ts](../../db/schema/household.ts)), so blank is not merely allowed
 * — it is the normal state, and it means "use the conventional default". The
 * form never pre-fills a default into a field, because doing so would silently
 * convert "no opinion" into a stored opinion that stops tracking the constant.
 *
 * The split refinement enforces the same two-part rule as the DB CHECK: all
 * three percentages or none, and they must sum to 100. A partial split has no
 * meaning — the diagnostic compares three shares against a whole — and a split
 * summing to 90 would silently make 10% of take-home unaccounted for.
 */
export const householdProfileSchema = z
  .object({
    reserveMonthsOverride: optionalNumeric,
    retirementTargetAge: optionalNumeric,
    /** PERCENTAGE — "4.5" is 4.5%. */
    benchmarkSavingsApy: optionalNumeric,
    needsPct: optionalNumeric,
    wantsPct: optionalNumeric,
    savingsPct: optionalNumeric,
    /** Decimal FRACTION — "0.07" is 7%. */
    highInterestThresholdApr: optionalNumeric,
  })
  .refine((v) => intInRange(v.reserveMonthsOverride, RESERVE_MONTHS_MIN, RESERVE_MONTHS_MAX), {
    path: ["reserveMonthsOverride"],
    message: `Reserve months must be a whole number between ${RESERVE_MONTHS_MIN} and ${RESERVE_MONTHS_MAX}`,
  })
  .refine((v) => intInRange(v.retirementTargetAge, RETIREMENT_AGE_MIN, RETIREMENT_AGE_MAX), {
    path: ["retirementTargetAge"],
    message: `Retirement age must be between ${RETIREMENT_AGE_MIN} and ${RETIREMENT_AGE_MAX}`,
  })
  .refine((v) => percentInRange(v.benchmarkSavingsApy), {
    path: ["benchmarkSavingsApy"],
    message: "Benchmark APY is a percentage between 0 and 100 (enter 4.5 for 4.5%)",
  })
  .refine((v) => fractionInRange(v.highInterestThresholdApr), {
    path: ["highInterestThresholdApr"],
    message: "The threshold is a decimal fraction between 0 and 1 (enter 0.07 for 7%)",
  })
  .superRefine((v, ctx) => {
    const parts = [v.needsPct, v.wantsPct, v.savingsPct];
    const filled = parts.filter((p) => !isBlank(p));
    if (filled.length === 0) return;
    if (filled.length < parts.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["needsPct"],
        message: "Set all three split percentages, or leave all three blank to use 50/30/20",
      });
      return;
    }
    const numbers = parts.map((p) => Number(p));
    if (numbers.some((n) => !Number.isFinite(n) || n < 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["needsPct"],
        message: "Split percentages must be zero or greater",
      });
      return;
    }
    const total = numbers.reduce((a, b) => a + b, 0);
    // Percentages, not money — a float sum is fine here, and the tolerance
    // absorbs a user typing 33.33/33.33/33.34.
    if (Math.abs(total - 100) > 0.01) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["needsPct"],
        message: `The three percentages must add up to 100 (they add up to ${total})`,
      });
    }
  });

export type HouseholdProfileInput = z.infer<typeof householdProfileSchema>;

/**
 * One household member.
 *
 * Birth YEAR only, never a full date (ADR-033 rejected alternative): every
 * age-based rule reads age to whole-year resolution, so a full date would store
 * strictly more PII to answer exactly the same questions.
 *
 * The upper bound is the CURRENT year, checked here rather than in the DB —
 * a Postgres CHECK cannot call a non-immutable function, so the schema's
 * 1900–2200 range is the backstop and this is the real guard. A birth year in
 * the future would make a member's age negative and quietly poison every
 * age-based rule.
 */
export const householdMemberSchema = z
  .object({
    label: z.string().trim().min(1, "Name is required").max(80),
    birthYear: optionalNumeric,
    isDependent: z.boolean().optional(),
  })
  .refine((v) => intInRange(v.birthYear, BIRTH_YEAR_MIN, new Date().getUTCFullYear()), {
    path: ["birthYear"],
    message: `Birth year must be between ${BIRTH_YEAR_MIN} and this year`,
  });

export type HouseholdMemberInput = z.infer<typeof householdMemberSchema>;

/** How long a snooze may run. A year is "not this year"; beyond that, dismiss. */
const SNOOZE_MAX_DAYS = 365;

/**
 * Dismiss or snooze one recommendation (P15-34).
 *
 * `subjectKey` is `''` for a whole-rule dismissal — empty string rather than
 * `null` because it is half of a UNIQUE index and Postgres NULLs are never equal
 * (see [recommendation-dismissals.ts](../../db/schema/recommendation-dismissals.ts)).
 * It is NOT validated as a UUID: most subjects are account or category ids, but
 * some rules key on a composite string, and rejecting those here would silently
 * make them un-dismissable.
 *
 * `snoozeDays` blank means "dismiss indefinitely". The bound exists because a
 * snooze longer than a year is a dismissal with extra steps, and an unbounded
 * one would let a stray keystroke silence a rule until 4023.
 */
export const dismissRecommendationSchema = z
  .object({
    ruleId: z.string().trim().min(1, "Missing rule"),
    subjectKey: z.string().trim().max(200).optional().or(z.literal("")),
    snoozeDays: optionalNumeric,
  })
  .refine((v) => intInRange(v.snoozeDays, 1, SNOOZE_MAX_DAYS), {
    path: ["snoozeDays"],
    message: `Snooze must be between 1 and ${SNOOZE_MAX_DAYS} days`,
  });

export type DismissRecommendationInput = z.infer<typeof dismissRecommendationSchema>;
