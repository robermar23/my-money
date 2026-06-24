import { relations, sql } from "drizzle-orm";
import {
  check,
  date,
  index,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { assetClassEnum } from "./enums.ts";
import { priceTargets } from "./price-targets.ts";

/**
 * watchlist_items: a symbol the user FOLLOWS but does NOT own (Phase 11,
 * ADR-025).
 *
 * **Structurally excluded from net worth.** A watch row is neither an account
 * nor a holding, so `computeNetWorth`/`netWorthSeries`/allocation/performance —
 * which read only `accounts`/`holdings` and their snapshots — cannot see it.
 * Exclusion is a property of the data model, not a flag one bug away from a
 * balance error.
 *
 * Prices come from the EXISTING pipeline: `fetch-prices-daily` unions
 * `distinctWatchlistSymbols()` into its work-list (deduped against held
 * symbols), so every watched symbol gets a fresh daily close in `prices`.
 * History before today is seeded by the on-add `backfill-watchlist-symbol` job.
 * There is deliberately NO snapshot table — a watch item isn't net worth and its
 * history *is* the `prices` series; value is computed on read
 * (`pretend_quantity × latestCloseOnOrBefore`).
 *
 * The optional "pretend" position lets the user model a hypothetical buy for a
 * simple display gain/loss (same shape as the holdings gain/loss) — **never**
 * realized P&L, tax lots, or 1099 (CLAUDE.md §Domain Scope). The three
 * `pretend_*` columns are all-NULL (just watching) or all-non-NULL (a coherent
 * paper position), enforced by a CHECK.
 *
 * `asset_class` reuses the existing enum but is CHECK-restricted to the
 * price-fetchable subset (`equity`/`crypto`/`physical_metal`) — there is nothing
 * to fetch a price for on `cash`/`property`.
 */
export const watchlistItems = pgTable(
  "watchlist_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Canonical ticker, uppercased: 'AAPL', 'XAU', 'BTC'. */
    symbol: text("symbol").notNull(),
    /** Reused enum, CHECK-restricted to the fetchable subset (see below). */
    assetClass: assetClassEnum("asset_class").notNull(),
    /** Optional display name ('Apple Inc.'); free-text, display-only, not parsed. */
    label: text("label"),
    /** Pretend share/coin/oz count. NULL = watch-only (no paper position). */
    pretendQuantity: numeric("pretend_quantity", { precision: 28, scale: 8 }),
    /** Pretend price PER UNIT at purchase. Total cost derived = qty × unit cost. */
    pretendUnitCost: numeric("pretend_unit_cost", { precision: 18, scale: 8 }),
    /** Pretend purchase date; also the start of the on-add history backfill window. */
    pretendPurchasedAt: date("pretend_purchased_at", { mode: "string" }),
    currency: text("currency").notNull().default("USD"),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => ({
    // One watch row per instrument — re-adding the same symbol is an edit.
    symbolAssetClassUnique: uniqueIndex("watchlist_items_symbol_asset_class_unique").on(
      table.symbol,
      table.assetClass,
    ),
    // Only fetchable classes can be watched (cash/property have no price source).
    assetClassCheck: check(
      "watchlist_items_asset_class_check",
      sql`${table.assetClass} IN ('equity', 'crypto', 'physical_metal')`,
    ),
    // A paper position is coherent or absent — no half-specified pretend buys.
    pretendAllOrNothingCheck: check(
      "watchlist_items_pretend_all_or_nothing_check",
      sql`(${table.pretendQuantity} IS NULL) = (${table.pretendUnitCost} IS NULL)
        AND (${table.pretendQuantity} IS NULL) = (${table.pretendPurchasedAt} IS NULL)`,
    ),
    // Trigram GIN indexes (Phase 12, ADR-028): fuzzy search on ticker + label for
    // the watchlist filter + the ⌘K palette.
    symbolTrgmIdx: index("watchlist_items_symbol_trgm_idx").using(
      "gin",
      sql`${table.symbol} gin_trgm_ops`,
    ),
    labelTrgmIdx: index("watchlist_items_label_trgm_idx").using(
      "gin",
      sql`${table.label} gin_trgm_ops`,
    ),
  }),
);

export const watchlistItemsRelations = relations(watchlistItems, ({ many }) => ({
  targets: many(priceTargets),
}));

export type WatchlistItem = typeof watchlistItems.$inferSelect;
export type NewWatchlistItem = typeof watchlistItems.$inferInsert;
