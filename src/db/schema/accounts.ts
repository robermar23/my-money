import { relations } from "drizzle-orm";
import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { accountTypeEnum } from "./enums.ts";
import { holdings } from "./holdings.ts";
import { liabilities } from "./liabilities.ts";
import { accountSnapshots } from "./snapshots.ts";

/**
 * Accounts: the seven account shapes from FEATURE.md (M&T checking/savings,
 * credit card, Fidelity, iTrust, Sunwest mortgage, Home).
 *
 * `currency` is the base currency of THIS account; net-worth aggregation
 * converts via fx_rates if needed (single-currency users skip the conversion).
 */
export const accounts = pgTable("accounts", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  institution: text("institution").notNull(),
  type: accountTypeEnum("type").notNull(),
  currency: text("currency").notNull().default("USD"),
  // null = active. Set on the day the account is closed (kept for historical snapshots).
  closedAt: timestamp("closed_at", { withTimezone: true, mode: "date" }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
});

export const accountsRelations = relations(accounts, ({ many, one }) => ({
  holdings: many(holdings),
  snapshots: many(accountSnapshots),
  liability: one(liabilities, {
    fields: [accounts.id],
    references: [liabilities.accountId],
  }),
}));

export type Account = typeof accounts.$inferSelect;
export type NewAccount = typeof accounts.$inferInsert;
