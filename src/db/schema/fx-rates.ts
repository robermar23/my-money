import { date, numeric, pgTable, primaryKey, text } from "drizzle-orm/pg-core";

/**
 * fx_rates: daily FX rate, base → quote.
 *
 * Reserved for multi-currency support. In Phase 1 with a USD-only user, this
 * table stays empty. Net-worth aggregation should consult it only when an
 * account's currency differs from the user's base currency.
 *
 * `rate` is the conversion factor: 1 unit of `base` = `rate` units of `quote`.
 */
export const fxRates = pgTable(
  "fx_rates",
  {
    date: date("date", { mode: "string" }).notNull(),
    base: text("base").notNull(),
    quote: text("quote").notNull(),
    rate: numeric("rate", { precision: 28, scale: 12 }).notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.date, table.base, table.quote] }),
  }),
);

export type FxRate = typeof fxRates.$inferSelect;
export type NewFxRate = typeof fxRates.$inferInsert;
