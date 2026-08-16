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
import { creditLines } from "./credit-lines.ts";
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
 *
 * Phase 15 (PLAN15 P15-01, ADR-033 §1) added four more NULLABLE columns, same
 * precedent again. `type` alone cannot answer Round 9's "how much on hand vs.
 * how much in medium-term savings like CD's" — every cash account is
 * `type='depository'`, so checking, savings, money-market and a CD are
 * indistinguishable. `subtype` is what makes cash tiering possible at all.
 *
 * NULL is meaningful on all four and is NEVER backfilled with a default: an
 * unset subtype must stay distinguishable from a deliberately-chosen one, so
 * the advice engine can report `unclassified` honestly instead of silently
 * treating an un-triaged account as checking.
 *
 * UNITS (read before doing arithmetic — CLAUDE.md §Money):
 *   - `apy` is a PERCENTAGE, e.g. "4.5000" = 4.5% (same convention as
 *     `retirement_contributions.match_cap_percent`).
 *   - APRs elsewhere (`liabilities.annual_rate`, `credit_lines.apr`) are
 *     decimal FRACTIONS, e.g. "0.065000" = 6.5%. The precisions differ on
 *     purpose so the two are hard to confuse: percent ⇒ numeric(7,4),
 *     fraction ⇒ numeric(8,6).
 *
 * `tax_treatment` describes the CONTAINER so the savings waterfall can ORDER it
 * (ADR-034 §4). It drives no tax math whatsoever — reaffirming ADR-030's
 * "`pretax` is a label only" (CLAUDE.md §Domain Scope: no tax engine, ever).
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
    /**
     * Cash-account subtype (Phase 15). NULL = unclassified — the advice engine
     * reports that account's balance as `unclassified` rather than guessing.
     * Only meaningful for `type='depository'`. text+CHECK per ADR-033.
     */
    subtype: text("subtype"),
    /** Annual percentage yield as a PERCENTAGE ("4.5000" = 4.5%). See header. */
    apy: numeric("apy", { precision: 7, scale: 4 }),
    /** CD maturity. Only meaningful when `subtype='cd'`; NULL otherwise. */
    maturityDate: date("maturity_date", { mode: "string" }),
    /**
     * Tax container for waterfall ORDERING only — drives no math (see header).
     * NULL = unclassified.
     */
    taxTreatment: text("tax_treatment"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => ({
    // NULL-tolerant: only constrains personal_asset rows that set a category.
    assetCategoryCheck: check(
      "accounts_asset_category_check",
      sql`${table.assetCategory} IS NULL OR ${table.assetCategory} IN ('vehicle', 'watercraft', 'jewelry', 'collectible', 'other')`,
    ),
    // NULL-tolerant, exactly like assetCategoryCheck above: an unclassified
    // account is legal, a misspelled subtype is not (ADR-033 §1).
    subtypeCheck: check(
      "accounts_subtype_check",
      sql`${table.subtype} IS NULL OR ${table.subtype} IN ('checking', 'savings', 'money_market', 'cd', 'cash_management')`,
    ),
    taxTreatmentCheck: check(
      "accounts_tax_treatment_check",
      sql`${table.taxTreatment} IS NULL OR ${table.taxTreatment} IN ('taxable', 'tax_deferred', 'roth', 'hsa')`,
    ),
    // APY is a percentage (see header). The 0–100 bound catches the most likely
    // data-entry error — entering a fraction (0.045) or a wildly wrong figure.
    apyRangeCheck: check(
      "accounts_apy_range_check",
      sql`${table.apy} IS NULL OR (${table.apy} >= 0 AND ${table.apy} <= 100)`,
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
  // The revolving twin of `liability` (Phase 15). A `credit_card` account has
  // zero or one; every other account type has none.
  creditLine: one(creditLines, {
    fields: [accounts.id],
    references: [creditLines.accountId],
  }),
  plaidItem: one(plaidItems, {
    fields: [accounts.plaidItemId],
    references: [plaidItems.id],
  }),
}));

export type Account = typeof accounts.$inferSelect;
export type NewAccount = typeof accounts.$inferInsert;

/**
 * Cash-account subtypes (Phase 15, ADR-033 §1 — mirrors the CHECK above).
 *
 * Ordered loosely by liquidity, which is also the order the cash-tiering rule
 * reads them in: `checking`/`cash_management` are operating cash, `savings`/
 * `money_market` are reserve, `cd` is medium-term.
 */
export const ACCOUNT_SUBTYPES = [
  "checking",
  "savings",
  "money_market",
  "cd",
  "cash_management",
] as const;
export type AccountSubtype = (typeof ACCOUNT_SUBTYPES)[number];

/**
 * Tax containers, for waterfall ORDERING only (mirrors the CHECK above).
 * These drive no tax computation — see the file header.
 */
export const ACCOUNT_TAX_TREATMENTS = ["taxable", "tax_deferred", "roth", "hsa"] as const;
export type AccountTaxTreatment = (typeof ACCOUNT_TAX_TREATMENTS)[number];
