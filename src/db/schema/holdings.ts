import { relations, sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  check,
  index,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { accounts } from "./accounts.ts";
import { assetClassEnum, quantityUnitEnum } from "./enums.ts";
import { holdingLots } from "./holding-lots.ts";
import { securities } from "./securities.ts";

/**
 * Holdings: positions inside investment/crypto_ira/property accounts.
 *
 * Per CLAUDE.md §Schema Invariants:
 *   - asset_class is a discriminated enum, not a free-text string
 *   - quantity_unit is constrained to known units
 *   - NUMERIC for quantity (28,8) handles crypto coins + troy ounces precisely
 *
 * One row per (account, symbol). To "edit a position" you update the row in
 * place.
 *
 * Phase 5 (ADR-012) added three NULLABLE/defaulted columns:
 *   - `security_id`  — FK to securities metadata (NULL for hand-typed symbols).
 *   - `source`       — 'manual' | 'plaid'; a Plaid holdings sync never clobbers
 *                      a manual position's curated fields blindly.
 *   - `cost_basis_overridden_at` — sticky-manual watermark (mirrors
 *                      transactions.category_overridden_at); a sync that returns
 *                      no/low-confidence cost basis must not overwrite a
 *                      user-entered one.
 * Lot-level cost basis lives in the child `holding_lots` table; when lots exist
 * the resolved basis is their sum (src/lib/investments/lots.ts).
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
    /** Optional — IRA gold often has no recorded cost basis. Aggregate fallback when no lots exist. */
    costBasis: numeric("cost_basis", { precision: 18, scale: 2 }),
    /** Security metadata link (Plaid securities). NULL for hand-typed symbols. */
    securityId: uuid("security_id").references((): AnyPgColumn => securities.id, {
      onDelete: "set null",
    }),
    /** 'manual' | 'plaid'. */
    source: text("source").notNull().default("manual"),
    /** Set when the user owns the cost basis; Plaid sync then skips overwriting it. */
    costBasisOverriddenAt: timestamp("cost_basis_overridden_at", {
      withTimezone: true,
      mode: "date",
    }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => ({
    accountSymbolUnique: uniqueIndex("holdings_account_symbol_unique").on(
      table.accountId,
      table.symbol,
    ),
    // FK index for security joins (postgres-best-practices: schema-foreign-key-indexes).
    securityIdIdx: index("holdings_security_id_idx").on(table.securityId),
    sourceCheck: check("holdings_source_check", sql`${table.source} IN ('manual', 'plaid')`),
  }),
);

export const holdingsRelations = relations(holdings, ({ one, many }) => ({
  account: one(accounts, {
    fields: [holdings.accountId],
    references: [accounts.id],
  }),
  security: one(securities, {
    fields: [holdings.securityId],
    references: [securities.id],
  }),
  lots: many(holdingLots),
}));

export type Holding = typeof holdings.$inferSelect;
export type NewHolding = typeof holdings.$inferInsert;
