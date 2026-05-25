import { date, numeric, pgTable, primaryKey, text } from "drizzle-orm/pg-core";

/**
 * prices: daily close for any tracked symbol.
 *
 * Per CLAUDE.md §Schema Invariants: PRIMARY KEY (symbol, date) — exactly one
 * row per symbol per day. Populated by the daily price-fetch worker (Phase 2);
 * empty in Phase 1.
 *
 * `source` is informational ('yfinance' | 'coingecko' | 'alpha_vantage' | 'manual')
 * so we can debug stale or anomalous prices.
 */
export const prices = pgTable(
  "prices",
  {
    symbol: text("symbol").notNull(),
    date: date("date", { mode: "string" }).notNull(),
    close: numeric("close", { precision: 18, scale: 8 }).notNull(),
    source: text("source").notNull().default("manual"),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.symbol, table.date] }),
  }),
);

export type Price = typeof prices.$inferSelect;
export type NewPrice = typeof prices.$inferInsert;
