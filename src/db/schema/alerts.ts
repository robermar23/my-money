import { sql } from "drizzle-orm";
import {
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * alerts: the system of record for detected anomalies (Phase 6, ADR-015).
 *
 * Written nightly by `detect-anomalies-daily` (P6-13) from deterministic rules
 * over data already in Postgres, plus directly by the backup job on failure, and
 * by the `evaluate-price-targets` job for one-shot watchlist price targets
 * (Phase 11, ADR-026 — type `price_target`, which like `backup_failure` is NOT a
 * resolve-swept rule type).
 * Surfaced at `/alerts` (the primary, zero-third-party channel) and, if SMTP is
 * configured, nudged via a **notification-only** email that carries NO financial
 * data (P6-14) — the structured figures live in `detail` and are shown only in
 * the authenticated UI.
 *
 * `type`/`severity` are plain text + CHECK (not pgEnum) — same posture as
 * plaid_items.status: we expect to add rule types over time, and dropping a
 * CHECK is lighter than an enum-add migration.
 *
 * `dedup_hash` is the idempotency key: a standing condition (e.g. a still-broken
 * Plaid item) produces the SAME hash each night and is INSERT…ON CONFLICT DO
 * NOTHING, so it fires once, not nightly. Each rule chooses its own
 * `period_key` granularity (P6-12) so recurring-but-distinct anomalies (a new
 * large transaction) get a fresh hash while standing ones stay deduped.
 *
 * `detail` jsonb holds structured context (amount, account_id, symbol, dates).
 * **Never emailed** — only rendered in the authenticated `/alerts` page.
 */
export const alerts = pgTable(
  "alerts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Rule that fired — see the CHECK for the closed set. */
    type: text("type").notNull(),
    /** 'info' | 'warning' | 'critical'. */
    severity: text("severity").notNull().default("warning"),
    /** sha256(type | subject_id | period_key) — the once-per-condition dedup key. */
    dedupHash: text("dedup_hash").notNull(),
    /** Short human label for the list. NO raw amounts (those live in `detail`). */
    title: text("title").notNull(),
    /** Structured context for the authenticated UI only. Never emailed. */
    detail: jsonb("detail").$type<Record<string, unknown>>().notNull(),
    detectedAt: timestamp("detected_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    /** Set when the notification-only email goes out; NULL = not yet / no SMTP. */
    notifiedAt: timestamp("notified_at", { withTimezone: true, mode: "date" }),
    /** Set when the condition clears (re-detection) or the user dismisses it. */
    resolvedAt: timestamp("resolved_at", { withTimezone: true, mode: "date" }),
  },
  (table) => ({
    dedupHashUnique: uniqueIndex("alerts_dedup_hash_unique").on(table.dedupHash),
    // Drives the /alerts page (open alerts, newest first).
    openDetectedAtIdx: index("alerts_open_detected_at_idx")
      .on(sql`${table.detectedAt} DESC`)
      .where(sql`${table.resolvedAt} IS NULL`),
    typeCheck: check(
      "alerts_type_check",
      sql`${table.type} IN ('large_transaction', 'balance_drop', 'item_login_required', 'stale_snapshot', 'stale_price', 'sync_failure', 'backup_failure', 'price_target')`,
    ),
    severityCheck: check(
      "alerts_severity_check",
      sql`${table.severity} IN ('info', 'warning', 'critical')`,
    ),
  }),
);

export type Alert = typeof alerts.$inferSelect;
export type NewAlert = typeof alerts.$inferInsert;
