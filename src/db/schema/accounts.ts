import { relations } from "drizzle-orm";
import { type AnyPgColumn, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { accountTypeEnum } from "./enums.ts";
import { holdings } from "./holdings.ts";
import { liabilities } from "./liabilities.ts";
import { plaidItems } from "./plaid-items.ts";
import { accountSnapshots } from "./snapshots.ts";

/**
 * Accounts: the seven account shapes from FEATURE.md (M&T checking/savings,
 * credit card, Fidelity, iTrust, Sunwest mortgage, Home).
 *
 * `currency` is the base currency of THIS account; net-worth aggregation
 * converts via fx_rates if needed (single-currency users skip the conversion).
 *
 * Phase 4 (PLAN4 P4-04) added three NULLABLE Plaid columns. Manual / file-only
 * accounts leave all three NULL; Plaid-backed accounts populate them via the
 * mapping flow (P4-13). `onDelete: 'set null'` on the Item FK is deliberate:
 * disconnecting an Item must preserve account history (transactions +
 * snapshots) — only the Plaid linkage is severed.
 */
export const accounts = pgTable("accounts", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  institution: text("institution").notNull(),
  type: accountTypeEnum("type").notNull(),
  currency: text("currency").notNull().default("USD"),
  // null = active. Set on the day the account is closed (kept for historical snapshots).
  closedAt: timestamp("closed_at", { withTimezone: true, mode: "date" }),
  /** Plaid Item this account belongs to. NULL for manual / file-only accounts. */
  plaidItemId: uuid("plaid_item_id").references((): AnyPgColumn => plaidItems.id, {
    onDelete: "set null",
  }),
  /** Plaid's `account_id` from `/accounts/get`. UNIQUE: one Plaid account → one of ours. */
  plaidAccountId: text("plaid_account_id").unique(),
  /** Last-4 mask from Plaid. Display-only. */
  plaidMask: text("plaid_mask"),
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
  plaidItem: one(plaidItems, {
    fields: [accounts.plaidItemId],
    references: [plaidItems.id],
  }),
}));

export type Account = typeof accounts.$inferSelect;
export type NewAccount = typeof accounts.$inferInsert;
