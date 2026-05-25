import { relations } from "drizzle-orm";
import { date, numeric, pgTable, primaryKey, uuid } from "drizzle-orm/pg-core";
import { accounts } from "./accounts.ts";

/**
 * account_snapshots: end-of-day balance for each account.
 *
 * THE most important table per IDEAS.md §6 — this is what makes net-worth-over-time
 * queries trivial. One row per (account_id, date). Written nightly by the
 * compute-snapshots-daily worker job; also written immediately when a user
 * records a manual balance.
 */
export const accountSnapshots = pgTable(
  "account_snapshots",
  {
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    date: date("date", { mode: "string" }).notNull(),
    /**
     * The account's "value" on this date, in the account's currency.
     * For depository/credit_card: the manually-entered or imported balance.
     * For investment/crypto_ira: sum of holdings priced at the most-recent close.
     * For loan: -1 * remaining principal (liabilities reduce net worth).
     * For property: most-recent manual valuation.
     */
    balance: numeric("balance", { precision: 18, scale: 2 }).notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.accountId, table.date] }),
  }),
);

export const accountSnapshotsRelations = relations(accountSnapshots, ({ one }) => ({
  account: one(accounts, {
    fields: [accountSnapshots.accountId],
    references: [accounts.id],
  }),
}));

export type AccountSnapshot = typeof accountSnapshots.$inferSelect;
export type NewAccountSnapshot = typeof accountSnapshots.$inferInsert;
