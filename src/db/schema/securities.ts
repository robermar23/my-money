import { relations, sql } from "drizzle-orm";
import { boolean, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { holdings } from "./holdings.ts";
import { investmentTransactions } from "./investment-transactions.ts";

/**
 * securities: metadata for a tradable instrument, plus the canonical-symbol map
 * that joins Plaid's `security_id` to our price/holdings world (Phase 5,
 * ADR-012).
 *
 * `symbol` is the canonical key resolved at the Plaid boundary
 * (src/lib/plaid/securities.ts): `ticker_symbol` → `cusip` → `SEC:<security_id>`.
 * Tickered securities are priced by the existing daily Yahoo fetch; synthetic
 * `SEC:`-prefixed symbols are valued from Plaid's `institution_price`, written
 * into `prices` by the investments sync worker (P5-16).
 *
 * `plaid_security_id` is UNIQUE but NULLABLE (manually-created securities have
 * none); the unique index is partial so multiple NULLs are allowed.
 */
export const securities = pgTable(
  "securities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Plaid's `security_id`. NULL for manual securities. */
    plaidSecurityId: text("plaid_security_id"),
    /** Canonical symbol: ticker → cusip → 'SEC:<plaid_security_id>'. */
    symbol: text("symbol").notNull(),
    /** Plaid `ticker_symbol`, may be null. */
    tickerSymbol: text("ticker_symbol"),
    cusip: text("cusip"),
    name: text("name").notNull(),
    /** Plaid security type: equity | etf | mutual fund | cash | fixed income | derivative | other. */
    type: text("type"),
    isCashEquivalent: boolean("is_cash_equivalent").notNull().default(false),
    isoCurrencyCode: text("iso_currency_code").notNull().default("USD"),
    /** Full Plaid security payload for debug + re-derivation. */
    raw: jsonb("raw"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => ({
    // Partial unique: manual securities (NULL plaid id) coexist; Plaid ones dedupe.
    plaidSecurityIdUnique: uniqueIndex("securities_plaid_security_id_unique")
      .on(table.plaidSecurityId)
      .where(sql`${table.plaidSecurityId} IS NOT NULL`),
  }),
);

export const securitiesRelations = relations(securities, ({ many }) => ({
  holdings: many(holdings),
  investmentTransactions: many(investmentTransactions),
}));

export type Security = typeof securities.$inferSelect;
export type NewSecurity = typeof securities.$inferInsert;
