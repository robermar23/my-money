import { relations } from "drizzle-orm";
import { numeric, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { accounts } from "./accounts.ts";
import { assetClassEnum, quantityUnitEnum } from "./enums.ts";

/**
 * Holdings: positions inside investment/crypto_ira/property accounts.
 *
 * Per CLAUDE.md §Schema Invariants:
 *   - asset_class is a discriminated enum, not a free-text string
 *   - quantity_unit is constrained to known units
 *   - NUMERIC for quantity (28,8) handles crypto coins + troy ounces precisely
 *
 * One row per (account, symbol). To "edit a position" you update the row in
 * place; lot-level cost basis is a Phase 5 concern.
 */
export const holdings = pgTable(
  "holdings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    /** Ticker for equity/crypto, 'XAU'/'XAG' for metals, 'CASH' or '' for cash holdings. */
    symbol: text("symbol").notNull(),
    quantity: numeric("quantity", { precision: 28, scale: 8 }).notNull(),
    quantityUnit: quantityUnitEnum("quantity_unit").notNull(),
    assetClass: assetClassEnum("asset_class").notNull(),
    /** Optional — IRA gold often has no recorded cost basis. */
    costBasis: numeric("cost_basis", { precision: 18, scale: 2 }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => ({
    accountSymbolUnique: uniqueIndex("holdings_account_symbol_unique").on(
      table.accountId,
      table.symbol,
    ),
  }),
);

export const holdingsRelations = relations(holdings, ({ one }) => ({
  account: one(accounts, {
    fields: [holdings.accountId],
    references: [accounts.id],
  }),
}));

export type Holding = typeof holdings.$inferSelect;
export type NewHolding = typeof holdings.$inferInsert;
