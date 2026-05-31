import { sql } from "drizzle-orm";
import {
  check,
  customType,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Custom bytea mapping (same idiom as import-batches.ts:23).
 *
 * `access_token_ciphertext` holds the AEAD envelope from src/lib/crypto/aead.ts
 * (`0x01 || nonce(12) || ct || tag(16)`). Postgres stores it as raw bytes;
 * Drizzle hands us a Buffer on read.
 */
const bytea = customType<{ data: Buffer; default: false }>({
  dataType() {
    return "bytea";
  },
  fromDriver(value): Buffer {
    if (Buffer.isBuffer(value)) return value;
    if (value instanceof Uint8Array) return Buffer.from(value);
    if (typeof value === "string") return Buffer.from(value, "binary");
    throw new TypeError("Unexpected bytea driver value");
  },
});

/**
 * plaid_items: one row per Plaid Item — i.e. per connected institution.
 *
 * Two M&T accounts share a single Item (one set of credentials at M&T); the
 * credit card is a separate Item. Per ADR-008, end-of-Phase-4 we expect two
 * rows total, well inside Plaid's 100-free-Items ceiling.
 *
 * `access_token_ciphertext` MUST be read only via src/lib/plaid/tokens.ts
 * (P4-09). Other modules must not SELECT this column — codified by P4-36's
 * audit. Decryption goes through src/lib/crypto/aead.ts (ADR-009).
 *
 * `transactions_cursor` NULL = initial sync still owed. Once populated by the
 * sync worker (P4-18), it advances with each successful `/transactions/sync`
 * pagination round.
 *
 * `status` is plain text + CHECK (not pgEnum) — same posture as
 * category_rules.field. We expect to add 'historical_update_pending' later;
 * enum-add migrations are heavier than dropping a CHECK.
 */
export const plaidItems = pgTable(
  "plaid_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Plaid's `item_id` (NOT our PK). Returned by `/item/public_token/exchange`. */
    plaidItemId: text("plaid_item_id").notNull(),
    /** Plaid's `ins_xxxx` institution ID. */
    institutionId: text("institution_id").notNull(),
    /** Display name, e.g. 'M&T Bank'. */
    institutionName: text("institution_name").notNull(),
    /** AES-256-GCM envelope per ADR-009. NEVER logged. NEVER returned from server actions. */
    accessTokenCiphertext: bytea("access_token_ciphertext").notNull(),
    /** Plaid `/transactions/sync` cursor. NULL → initial sync owed. */
    transactionsCursor: text("transactions_cursor"),
    /** Plaid products we consented to, e.g. `['transactions']`. */
    productsConsented: text("products_consented").array().notNull(),
    /** 'active' | 'login_required' | 'pending_disconnect' | 'revoked' | 'removed'. */
    status: text("status").notNull().default("active"),
    /** Plaid error code from the last failure, e.g. 'ITEM_LOGIN_REQUIRED'. */
    errorCode: text("error_code"),
    /** Human-readable error from Plaid. */
    errorMessage: text("error_message"),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true, mode: "date" }),
    lastWebhookAt: timestamp("last_webhook_at", { withTimezone: true, mode: "date" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => ({
    plaidItemIdUnique: uniqueIndex("plaid_items_plaid_item_id_unique").on(table.plaidItemId),
    // Partial index — removed Items are tombstones we keep for audit; queries
    // that drive the connections UI filter by status and benefit from skipping
    // them.
    statusIdx: index("plaid_items_status_idx")
      .on(table.status)
      .where(sql`${table.status} != 'removed'`),
    statusCheck: check(
      "plaid_items_status_check",
      sql`${table.status} IN ('active', 'login_required', 'pending_disconnect', 'revoked', 'removed')`,
    ),
  }),
);

export type PlaidItem = typeof plaidItems.$inferSelect;
export type NewPlaidItem = typeof plaidItems.$inferInsert;
