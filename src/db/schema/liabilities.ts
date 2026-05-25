import { relations } from "drizzle-orm";
import { date, integer, numeric, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { accounts } from "./accounts.ts";

/**
 * Liabilities: parameters for a fixed-rate amortizing loan tied to a `loan` account.
 *
 * The current balance is COMPUTED at read time via `balanceAtMonth(...)` from
 * `src/lib/mortgage/amortization.ts` — we don't store it. This keeps the
 * source-of-truth single (you can never have drift between principal and
 * stored balance) and removes the need to recompute on every payment.
 *
 * Each `loan` account has exactly zero or one row here (FK is unique).
 */
export const liabilities = pgTable("liabilities", {
  id: uuid("id").primaryKey().defaultRandom(),
  accountId: uuid("account_id")
    .notNull()
    .unique()
    .references(() => accounts.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  principalAtOrigination: numeric("principal_at_origination", {
    precision: 18,
    scale: 2,
  }).notNull(),
  /** Annual rate as a decimal fraction (e.g. "0.065" for 6.5% APR). */
  annualRate: numeric("annual_rate", { precision: 8, scale: 6 }).notNull(),
  termMonths: integer("term_months").notNull(),
  startDate: date("start_date", { mode: "string" }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
});

export const liabilitiesRelations = relations(liabilities, ({ one }) => ({
  account: one(accounts, {
    fields: [liabilities.accountId],
    references: [accounts.id],
  }),
}));

export type Liability = typeof liabilities.$inferSelect;
export type NewLiability = typeof liabilities.$inferInsert;
