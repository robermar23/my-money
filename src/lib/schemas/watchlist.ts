import { z } from "zod";
import { isoDateSchema, quantitySchema } from "./account.ts";

/**
 * Watchlist & price-target validation (Phase 11, ADR-025/026).
 *
 * Every server-action boundary parses through these (CLAUDE.md §Zod). Money and
 * quantity stay strings end-to-end (NUMERIC, never float); the schemas only
 * validate shape — arithmetic happens later through `Money`.
 */

/**
 * Watchable asset classes — the price-fetchable subset, mirroring the
 * `watchlist_items_asset_class_check` constraint. Cash/property have no price
 * source, so they can't be watched.
 */
export const WATCHLIST_ASSET_CLASSES = ["equity", "crypto", "physical_metal"] as const;

export const PRICE_TARGET_DIRECTIONS = ["above", "below"] as const;

/**
 * A per-unit price/quantity string with up to 8 decimal places — the scale of
 * `pretend_unit_cost`/`threshold` (NUMERIC(18,8)). Looser than the 2dp
 * `moneyAmountSchema` because a crypto/metal unit price is finer-grained.
 */
const pricePerUnitSchema = z
  .string()
  .trim()
  .min(1, "Required")
  .regex(/^\d+(\.\d{1,8})?$/, "Use up to eight decimal places");

/**
 * Create/edit a watchlist item. `symbol` is uppercased; `asset_class` is
 * restricted to the fetchable subset. The three `pretend_*` fields are
 * all-present (a coherent paper position) or all-absent (watch-only) — the same
 * invariant the DB CHECK enforces, surfaced here as a friendly field error.
 *
 * Optional fields arrive from `FormData` as `""` when blank; we normalize those
 * to `undefined` so the action can write SQL NULLs.
 */
export const createWatchlistItemSchema = z
  .object({
    symbol: z
      .string()
      .trim()
      .min(1, "Symbol is required")
      .max(20, "Symbol is too long")
      .transform((s) => s.toUpperCase()),
    assetClass: z.enum(WATCHLIST_ASSET_CLASSES),
    label: z
      .string()
      .trim()
      .max(120)
      .optional()
      .or(z.literal(""))
      .transform((v) => (v ? v : undefined)),
    pretendQuantity: quantitySchema
      .optional()
      .or(z.literal(""))
      .transform((v) => (v ? v : undefined)),
    pretendUnitCost: pricePerUnitSchema
      .optional()
      .or(z.literal(""))
      .transform((v) => (v ? v : undefined)),
    pretendPurchasedAt: isoDateSchema
      .optional()
      .or(z.literal(""))
      .transform((v) => (v ? v : undefined)),
    currency: z.string().trim().length(3, "Use a 3-letter currency code").default("USD"),
    notes: z
      .string()
      .trim()
      .max(2000)
      .optional()
      .or(z.literal(""))
      .transform((v) => (v ? v : undefined)),
  })
  .refine(
    (d) => {
      const present = [d.pretendQuantity, d.pretendUnitCost, d.pretendPurchasedAt].filter(
        (v) => v !== undefined,
      ).length;
      return present === 0 || present === 3;
    },
    {
      message:
        "A pretend position needs quantity, unit cost, and purchase date together — or leave all three blank to just watch.",
      path: ["pretendQuantity"],
    },
  );

export type CreateWatchlistItemInput = z.infer<typeof createWatchlistItemSchema>;

/** Edit reuses the create shape (same fields, same invariants). */
export const updateWatchlistItemSchema = createWatchlistItemSchema;

/** A one-shot above/below price target attached to a watchlist item. */
export const createPriceTargetSchema = z.object({
  direction: z.enum(PRICE_TARGET_DIRECTIONS),
  threshold: pricePerUnitSchema,
  note: z
    .string()
    .trim()
    .max(120)
    .optional()
    .or(z.literal(""))
    .transform((v) => (v ? v : undefined)),
});

export type CreatePriceTargetInput = z.infer<typeof createPriceTargetSchema>;
