import { relations, sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  check,
  index,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { watchlistItems } from "./watchlist-items.ts";

/**
 * price_targets: a "tell me when SYMBOL crosses $X, up or down" rule attached to
 * a watchlist item (Phase 11, ADR-026).
 *
 * **One-shot.** A target fires exactly once: when the latest close satisfies the
 * direction (`above` ⇒ close ≥ threshold; `below` ⇒ close ≤ threshold) the
 * `evaluate-price-targets` job writes an `alerts` row and sets `active = false`
 * + `triggered_at`/`triggered_price`. It does NOT re-arm automatically (avoids
 * nightly nagging on a symbol parked past its threshold); the user re-arms by
 * re-activating/editing the target. `'price_target'` is added to the `alerts`
 * type CHECK but is deliberately NOT a member of `RULE_ALERT_TYPES` — like
 * `backup_failure`, it is exempt from the anomaly resolve-sweep.
 *
 * Cadence is once-daily: the evaluator is chained off `fetch-prices-daily` so it
 * always reads the freshest close with no race. Real-time/intraday alerting is a
 * deferred, env-gated Open Item — see ADR-026.
 *
 * Targets attach to a watchlist item (not a free-floating symbol) so the UI has
 * a home and symbol/asset_class are inherited; `onDelete: cascade` — a target
 * dies with its watch row.
 */
export const priceTargets = pgTable(
  "price_targets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    watchlistItemId: uuid("watchlist_item_id")
      .notNull()
      .references((): AnyPgColumn => watchlistItems.id, { onDelete: "cascade" }),
    /** 'above' fires at/over the threshold; 'below' fires at/under it. */
    direction: text("direction").notNull(),
    /** Target price per unit. */
    threshold: numeric("threshold", { precision: 18, scale: 8 }).notNull(),
    /** False once fired (one-shot) or user-paused. */
    active: boolean("active").notNull().default(true),
    /** Stamped when the target fires. */
    triggeredAt: timestamp("triggered_at", { withTimezone: true, mode: "date" }),
    /** The close that satisfied the target. */
    triggeredPrice: numeric("triggered_price", { precision: 18, scale: 8 }),
    /** Optional user label, e.g. 'sell target', 'buy the dip'. */
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => ({
    // FK index for the watchlist-item → targets join (postgres-best-practices).
    watchlistItemIdIdx: index("price_targets_watchlist_item_id_idx").on(table.watchlistItemId),
    // Partial index drives the evaluator's "scan active targets" pass cheaply.
    activeIdx: index("price_targets_active_idx")
      .on(table.watchlistItemId)
      .where(sql`${table.active} = true`),
    directionCheck: check(
      "price_targets_direction_check",
      sql`${table.direction} IN ('above', 'below')`,
    ),
  }),
);

export const priceTargetsRelations = relations(priceTargets, ({ one }) => ({
  watchlistItem: one(watchlistItems, {
    fields: [priceTargets.watchlistItemId],
    references: [watchlistItems.id],
  }),
}));

export type PriceTarget = typeof priceTargets.$inferSelect;
export type NewPriceTarget = typeof priceTargets.$inferInsert;
