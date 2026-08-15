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
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { holdings } from "./holdings.ts";

/**
 * holding_lots: optional per-lot cost basis for a position (Phase 5, ADR-012).
 *
 * A holding's cost basis is RESOLVED (src/lib/investments/lots.ts) as:
 *   sum(holding_lots.cost_basis_total) when any lots exist
 *   → else holdings.cost_basis (manual or Plaid aggregate)
 *   → else null (unknown — gain/loss renders "—").
 *
 * Lots are created manually (P5-18) or from Plaid buy transactions (P5-14).
 * Per CLAUDE.md §Money: cost_basis_total is the lot's TOTAL dollars; per-unit
 * basis is derived via the Money helper at the display boundary, never stored
 * as a lossy float division.
 *
 * `source` is plain text + CHECK (not pgEnum) — same posture as
 * transactions.source / plaid_items.status.
 */
export const holdingLots = pgTable(
  "holding_lots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    holdingId: uuid("holding_id")
      .notNull()
      .references((): AnyPgColumn => holdings.id, { onDelete: "cascade" }),
    /** Acquisition date; nullable when unknown. */
    acquiredAt: date("acquired_at", { mode: "string" }),
    quantity: numeric("quantity", { precision: 28, scale: 8 }).notNull(),
    /** Total dollar basis for this lot. Per-unit = total / quantity (computed at display). */
    costBasisTotal: numeric("cost_basis_total", { precision: 18, scale: 2 }).notNull(),
    /** 'manual' | 'plaid' | 'income' (Phase 14 — a materialized 401k contribution). */
    source: text("source").notNull().default("manual"),
    /** The Plaid buy transaction that created a Plaid-derived lot; dedup key. */
    plaidInvestmentTransactionId: text("plaid_investment_transaction_id"),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => ({
    // FK index: Postgres does not auto-index FKs. Speeds list-by-holding +
    // ON DELETE CASCADE (postgres-best-practices: schema-foreign-key-indexes).
    holdingIdIdx: index("holding_lots_holding_id_idx").on(table.holdingId),
    // Partial unique: dedupe Plaid-derived lots; manual lots (NULL id) coexist.
    holdingPlaidTxnUnique: uniqueIndex("holding_lots_holding_plaid_txn_unique")
      .on(table.holdingId, table.plaidInvestmentTransactionId)
      .where(sql`${table.plaidInvestmentTransactionId} IS NOT NULL`),
    // 'income' (Phase 14, ADR-031): a lot materialized from a defined paycheck
    // contribution. Source-scoping is the double-count guard — the contribution
    // job reads and writes ONLY these rows and never touches manual/plaid lots.
    sourceCheck: check(
      "holding_lots_source_check",
      sql`${table.source} IN ('manual', 'plaid', 'income')`,
    ),
  }),
);

export const holdingLotsRelations = relations(holdingLots, ({ one }) => ({
  holding: one(holdings, {
    fields: [holdingLots.holdingId],
    references: [holdings.id],
  }),
}));

export type HoldingLot = typeof holdingLots.$inferSelect;
export type NewHoldingLot = typeof holdingLots.$inferInsert;
