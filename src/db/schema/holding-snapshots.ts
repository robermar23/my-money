import { relations } from "drizzle-orm";
import {
  type AnyPgColumn,
  date,
  index,
  numeric,
  pgTable,
  primaryKey,
  text,
  uuid,
} from "drizzle-orm/pg-core";
import { holdings } from "./holdings.ts";

/**
 * holding_snapshots: end-of-day value for each individual position (Phase 9,
 * ADR-019).
 *
 * This is `account_snapshots` one level down — it breaks an investment account's
 * daily value into its constituent holdings, which `account_snapshots` cannot.
 * That per-position history is what powers value-over-time sliced by asset class
 * / account / security, the performance layer (TWR/XIRR), and per-security
 * drill-down (PLAN9 Batch 3/4).
 *
 * One row per `(holding_id, date)`. Written nightly by the
 * compute-snapshots-daily worker in the SAME pass that values the account (no
 * extra price reads), and seeded by the best-effort `backfillHoldingSnapshots`
 * one-shot (P9-03). Idempotent via the composite PK + `ON CONFLICT DO UPDATE`.
 *
 * Per CLAUDE.md §Money: `value`/`cost_basis` are NUMERIC(18,2), `quantity` is
 * NUMERIC(28,8) (handles crypto coins + troy ounces). `cost_basis` is nullable
 * (resolved basis is unknown for some positions — gain/loss renders "—").
 * `currency` is the account's currency so multi-currency aggregation can convert
 * through `fx_rates` at the snapshot's date.
 */
export const holdingSnapshots = pgTable(
  "holding_snapshots",
  {
    holdingId: uuid("holding_id")
      .notNull()
      .references((): AnyPgColumn => holdings.id, { onDelete: "cascade" }),
    date: date("date", { mode: "string" }).notNull(),
    quantity: numeric("quantity", { precision: 28, scale: 8 }).notNull(),
    /** quantity × close on this date, in the account's currency. */
    value: numeric("value", { precision: 18, scale: 2 }).notNull(),
    /** Resolved cost basis on this date (lots-aware, P5-07). Null when unknown. */
    costBasis: numeric("cost_basis", { precision: 18, scale: 2 }),
    currency: text("currency").notNull().default("USD"),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.holdingId, table.date] }),
    // Cross-holding "all positions on day D" slices (per-asset-class / per-sector
    // series). The FK + per-holding read are covered by the PK's leading column.
    dateIdx: index("holding_snapshots_date_idx").on(table.date),
  }),
);

export const holdingSnapshotsRelations = relations(holdingSnapshots, ({ one }) => ({
  holding: one(holdings, {
    fields: [holdingSnapshots.holdingId],
    references: [holdings.id],
  }),
}));

export type HoldingSnapshot = typeof holdingSnapshots.$inferSelect;
export type NewHoldingSnapshot = typeof holdingSnapshots.$inferInsert;
