import { relations, sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  check,
  date,
  index,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { assetDocuments } from "./asset-documents.ts";
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
 *
 * Phase 10 (PLAN10 P10-01, ADR-023) added four NULLABLE asset columns. Only
 * `type='personal_asset'` rows populate them (vehicles/boats/jewelry/etc.);
 * every other account type leaves all four NULL. Following the nullable-Plaid-
 * column precedent: additive, no impact on existing rows.
 */
export const accounts = pgTable(
  "accounts",
  {
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
    /**
     * Personal-asset category (Phase 10). NULL for non-asset accounts; one of
     * the CHECK-constrained values for `type='personal_asset'`. text+CHECK (not a
     * pgEnum) per ADR-023 — categories may grow, and extending a CHECK is lighter
     * than an enum-add migration.
     */
    assetCategory: text("asset_category"),
    /** Free-text notes / make-model-year for an asset. Display-only, not parsed. */
    description: text("description"),
    /** Asset acquisition date. NULL when unknown (e.g. inherited items). */
    acquiredAt: date("acquired_at", { mode: "string" }),
    /** What the user paid. Drives a simple display gain/loss (not a tax figure). */
    acquisitionCost: numeric("acquisition_cost", { precision: 18, scale: 2 }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => ({
    // NULL-tolerant: only constrains personal_asset rows that set a category.
    assetCategoryCheck: check(
      "accounts_asset_category_check",
      sql`${table.assetCategory} IS NULL OR ${table.assetCategory} IN ('vehicle', 'watercraft', 'jewelry', 'collectible', 'other')`,
    ),
    // Trigram GIN indexes (Phase 12, ADR-028): fuzzy search on account name +
    // institution for the per-list filter and the ⌘K palette.
    nameTrgmIdx: index("accounts_name_trgm_idx").using("gin", sql`${table.name} gin_trgm_ops`),
    institutionTrgmIdx: index("accounts_institution_trgm_idx").using(
      "gin",
      sql`${table.institution} gin_trgm_ops`,
    ),
  }),
);

export const accountsRelations = relations(accounts, ({ many, one }) => ({
  holdings: many(holdings),
  snapshots: many(accountSnapshots),
  documents: many(assetDocuments),
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
