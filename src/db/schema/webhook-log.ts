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
 * webhook_log: idempotency + audit trail for Plaid webhooks.
 *
 * Per CLAUDE.md §Plaid Safety Rules: webhook handlers MUST be idempotent.
 * The dedup primitive is `idempotency_hash` — a SHA-256 over
 * `(webhook_type, webhook_code, item_id, canonical-JSON-body)`. The route
 * handler (P4-15) INSERTs ON CONFLICT (idempotency_hash) DO NOTHING; an empty
 * RETURNING is the dupe signal.
 *
 * `plaid_item_id` here is the TEXT id Plaid puts in the body (not a FK to our
 * `plaid_items.id`). Most webhooks carry one but a handful don't, hence
 * nullable. Indexed alongside `received_at DESC` so the connections-page
 * recent-activity panel (P4-28) can paginate per-Item.
 *
 * `status` lifecycle:
 *   - 'queued'    → INSERT succeeded; BullMQ job enqueued, not yet processed
 *   - 'processed' → worker finished, set `processed_at`
 *   - 'duplicate' → second-receive path explicitly recorded the dupe
 *                   (the ON CONFLICT DO NOTHING path does NOT create a row;
 *                    this status is used by P4-26 / removed-item replay
 *                    handling and any path that wants an audit row without
 *                    racing the unique constraint).
 *   - 'failed'    → job exhausted retries; `error` captures the message
 *
 * `body` jsonb is captured verbatim — a stored copy of what Plaid sent us.
 * Indispensable for debugging "we received this but the cursor didn't move"
 * incidents.
 */
export const webhookLog = pgTable(
  "webhook_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** SHA-256 hex of (webhook_type | webhook_code | item_id | canonical-JSON body). */
    idempotencyHash: text("idempotency_hash").notNull(),
    /** E.g. 'TRANSACTIONS', 'ITEM'. */
    webhookType: text("webhook_type").notNull(),
    /** E.g. 'SYNC_UPDATES_AVAILABLE', 'ERROR'. */
    webhookCode: text("webhook_code").notNull(),
    /** Plaid's item_id from the body; nullable for webhook types without one. */
    plaidItemId: text("plaid_item_id"),
    /** Verbatim body as Plaid delivered it. */
    body: jsonb("body").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    /** NULL until the enqueued job completes. */
    processedAt: timestamp("processed_at", { withTimezone: true, mode: "date" }),
    /** 'queued' | 'processed' | 'duplicate' | 'failed'. */
    status: text("status").notNull().default("queued"),
    /** Exception message when status = 'failed'. */
    error: text("error"),
  },
  (table) => ({
    idempotencyHashUnique: uniqueIndex("webhook_log_idempotency_hash_unique").on(
      table.idempotencyHash,
    ),
    plaidItemReceivedAtIdx: index("webhook_log_plaid_item_id_received_at_idx").on(
      table.plaidItemId,
      sql`${table.receivedAt} DESC`,
    ),
    statusCheck: check(
      "webhook_log_status_check",
      sql`${table.status} IN ('queued', 'processed', 'duplicate', 'failed')`,
    ),
  }),
);

export type WebhookLogEntry = typeof webhookLog.$inferSelect;
export type NewWebhookLogEntry = typeof webhookLog.$inferInsert;
