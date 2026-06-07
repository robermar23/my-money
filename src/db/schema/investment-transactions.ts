import { relations, sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  check,
  date,
  index,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { accounts } from "./accounts.ts";
import { securities } from "./securities.ts";

/**
 * investment_transactions: the buy/sell/cash/fee/transfer stream for an
 * investment account (Phase 5, ADR-012). Distinct from the cash `transactions`
 * table — investment events carry security_id, quantity, price, and fees that
 * don't fit the cash ledger or the categorizer.
 *
 * Sign convention (CRITICAL — matches src/lib/plaid/map.ts):
 *   Plaid: positive `amount` = cash DEBITED (a buy); negative = cash CREDITED
 *   (a sell / dividend). We FLIP at the mapper boundary so `amount` follows the
 *   rest of the app: positive = inflow. The flip is Money.negate(), never
 *   Number() (CLAUDE.md §Money & Numeric Precision).
 *
 * Income breakdown (P5-09/P5-23) sums rows where subtype IN ('dividend',
 * 'interest'). Lot construction (P5-14) reads type='buy' rows.
 *
 * Dedup on (account_id, plaid_investment_transaction_id); manual rows carry a
 * NULL plaid id, so the unique index is partial.
 */
export const investmentTransactions = pgTable(
  "investment_transactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references((): AnyPgColumn => accounts.id, { onDelete: "cascade" }),
    /** Nullable — pure-cash transactions reference no security. */
    securityId: uuid("security_id").references((): AnyPgColumn => securities.id, {
      onDelete: "set null",
    }),
    /** Plaid `investment_transaction_id`; NULL for manual rows. */
    plaidInvestmentTransactionId: text("plaid_investment_transaction_id"),
    /** Plaid `type`: buy | sell | cash | fee | transfer | cancel. */
    type: text("type").notNull(),
    /** Plaid `subtype`: dividend | interest | deposit | withdrawal | … (nullable). */
    subtype: text("subtype"),
    /** Plaid `date` (trade/settle date). */
    tradeDate: date("trade_date", { mode: "string" }).notNull(),
    quantity: numeric("quantity", { precision: 28, scale: 8 }),
    price: numeric("price", { precision: 18, scale: 8 }),
    fees: numeric("fees", { precision: 18, scale: 2 }),
    /** Signed cash impact in our convention (positive = inflow). */
    amount: numeric("amount", { precision: 18, scale: 2 }).notNull(),
    name: text("name"),
    isoCurrencyCode: text("iso_currency_code").notNull().default("USD"),
    /** 'plaid' | 'manual'. */
    source: text("source").notNull(),
    /** Full Plaid payload for debug + re-derivation. */
    raw: jsonb("raw"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => ({
    // Partial unique: dedupe Plaid rows; manual rows (NULL id) coexist.
    accountPlaidIdUnique: uniqueIndex("investment_txns_account_plaid_id_unique")
      .on(table.accountId, table.plaidInvestmentTransactionId)
      .where(sql`${table.plaidInvestmentTransactionId} IS NOT NULL`),
    // Covers the per-account chronological read (also indexes the account_id FK).
    accountTradeDateIdx: index("investment_txns_account_trade_date_idx").on(
      table.accountId,
      sql`${table.tradeDate} DESC`,
    ),
    // FK index for security joins (income-by-security, position roll-ups).
    securityIdIdx: index("investment_txns_security_id_idx").on(table.securityId),
    // Partial index for the income-breakdown aggregation.
    subtypeIdx: index("investment_txns_subtype_idx")
      .on(table.subtype)
      .where(sql`${table.subtype} IS NOT NULL`),
    typeCheck: check(
      "investment_txns_type_check",
      sql`${table.type} IN ('buy', 'sell', 'cash', 'fee', 'transfer', 'cancel')`,
    ),
    sourceCheck: check("investment_txns_source_check", sql`${table.source} IN ('plaid', 'manual')`),
  }),
);

export const investmentTransactionsRelations = relations(investmentTransactions, ({ one }) => ({
  account: one(accounts, {
    fields: [investmentTransactions.accountId],
    references: [accounts.id],
  }),
  security: one(securities, {
    fields: [investmentTransactions.securityId],
    references: [securities.id],
  }),
}));

export type InvestmentTransaction = typeof investmentTransactions.$inferSelect;
export type NewInvestmentTransaction = typeof investmentTransactions.$inferInsert;
