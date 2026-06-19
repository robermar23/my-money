import { z } from "zod";

export const ACCOUNT_TYPES = [
  "depository",
  "credit_card",
  "investment",
  "crypto_ira",
  "loan",
  "property",
] as const;

export const ASSET_CLASSES = ["equity", "crypto", "physical_metal", "cash", "property"] as const;

export const QUANTITY_UNITS = ["shares", "coin", "troy_oz", "usd"] as const;

/** Validates form input from FormData (everything arrives as strings). */
export const moneyAmountSchema = z
  .string()
  .trim()
  .min(1, "Amount is required")
  .regex(/^-?\d+(\.\d{1,2})?$/, "Use up to two decimal places (e.g. 1234.56)");

/** Looser regex for quantities: 8 decimal places for crypto/metals. */
export const quantitySchema = z
  .string()
  .trim()
  .min(1, "Quantity is required")
  .regex(/^-?\d+(\.\d{1,8})?$/, "Use up to eight decimal places");

/** YYYY-MM-DD date string. Stored as Postgres `date`. */
export const isoDateSchema = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use a YYYY-MM-DD date");

/** Annual rate as a decimal fraction string (e.g. "0.065" for 6.5%). */
export const annualRateSchema = z
  .string()
  .trim()
  .regex(/^\d+(\.\d+)?$/, "Use a decimal fraction (e.g. 0.065 for 6.5%)")
  .refine((s) => Number(s) >= 0 && Number(s) <= 1, {
    message: "Rate must be between 0 and 1 (e.g. 0.065 for 6.5%)",
  });

export const createAccountSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(120),
  institution: z.string().trim().min(1, "Institution is required").max(120),
  type: z.enum(ACCOUNT_TYPES),
  currency: z.string().trim().length(3, "Use a 3-letter currency code").default("USD"),
});

export type CreateAccountInput = z.infer<typeof createAccountSchema>;

/**
 * Edit an existing account. Same field set as create (P7-01). The server action
 * enforces that `type`/`currency` are only applied when the account has no data
 * (changing them after data exists corrupts valuation/aggregation).
 */
export const updateAccountSchema = createAccountSchema;

export type UpdateAccountInput = z.infer<typeof updateAccountSchema>;

export const recordBalanceSchema = z.object({
  date: isoDateSchema,
  balance: moneyAmountSchema,
});

export const upsertHoldingSchema = z.object({
  symbol: z.string().trim().min(1, "Symbol is required").max(20),
  quantity: quantitySchema,
  quantityUnit: z.enum(QUANTITY_UNITS),
  assetClass: z.enum(ASSET_CLASSES),
  costBasis: moneyAmountSchema.optional().or(z.literal("")),
});

export const createMortgageSchema = z.object({
  name: z.string().trim().min(1).max(120),
  principalAtOrigination: moneyAmountSchema,
  annualRate: annualRateSchema,
  termMonths: z.coerce.number().int().positive().max(600),
  startDate: isoDateSchema,
});

export const recordPropertyValueSchema = z.object({
  date: isoDateSchema,
  value: moneyAmountSchema,
});

/** A single cost-basis lot entered manually (Phase 5, P5-18). */
export const upsertLotSchema = z.object({
  /** Acquisition date; optional (unknown for some inherited/old positions). */
  acquiredAt: isoDateSchema.optional().or(z.literal("")),
  quantity: quantitySchema,
  costBasisTotal: moneyAmountSchema,
});
