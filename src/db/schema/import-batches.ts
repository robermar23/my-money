import { relations, sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  check,
  customType,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { accounts } from "./accounts.ts";

/**
 * Custom bytea mapping. Drizzle's standard column types don't include bytea
 * directly; we map to a Buffer on read so the worker can stream the original
 * file bytes back through the parser when re-running a `pending` batch.
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
 * import_batches: one row per uploaded QFX / OFX / CSV file.
 *
 * Lifecycle: `pending` → (worker parses) → `previewed` → (user confirms) → `confirmed`.
 * Failed parses land in `failed`. The `parsed_payload` jsonb is the source of
 * truth for the preview page AND the confirm action — there is no "the file
 * changed between preview and confirm" race because the bytes are captured
 * once at upload time.
 *
 * `raw_file` bytea retains the upload so the worker can re-parse without
 * filesystem state; restoring this row from backup is enough to re-derive
 * every transaction it produced.
 */
export const importBatches = pgTable(
  "import_batches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references((): AnyPgColumn => accounts.id, { onDelete: "cascade" }),
    /** 'qfx' | 'csv' — extended in Phase 4 if we ever import Plaid backfills via file. */
    source: text("source").notNull(),
    filename: text("filename").notNull(),
    uploadedAt: timestamp("uploaded_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    /** 'pending' | 'previewed' | 'confirmed' | 'failed'. */
    status: text("status").notNull().default("pending"),
    /** Original file bytes — needed for the worker re-parse path; small (<few MB) per CLAUDE.md. */
    rawFile: bytea("raw_file"),
    /** Normalized rows the importer produced. Read by the preview + confirm path. */
    parsedPayload: jsonb("parsed_payload"),
    /** Header info: institution name, OFX version, currency, etc. For debugging. */
    parserMetadata: jsonb("parser_metadata"),
    statementStart: date("statement_start", { mode: "string" }),
    statementEnd: date("statement_end", { mode: "string" }),
    statementEndingBalance: numeric("statement_ending_balance", { precision: 18, scale: 2 }),
    insertedCount: integer("inserted_count").notNull().default(0),
    duplicateCount: integer("duplicate_count").notNull().default(0),
    invalidCount: integer("invalid_count").notNull().default(0),
    error: text("error"),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true, mode: "date" }),
  },
  (table) => ({
    accountUploadedAtIdx: index("import_batches_account_uploaded_at_idx").on(
      table.accountId,
      sql`${table.uploadedAt} DESC`,
    ),
    statusCheck: check(
      "import_batches_status_check",
      sql`${table.status} IN ('pending', 'previewed', 'confirmed', 'failed')`,
    ),
    sourceCheck: check("import_batches_source_check", sql`${table.source} IN ('qfx', 'csv')`),
  }),
);

export const importBatchesRelations = relations(importBatches, ({ one }) => ({
  account: one(accounts, {
    fields: [importBatches.accountId],
    references: [accounts.id],
  }),
}));

export type ImportBatch = typeof importBatches.$inferSelect;
export type NewImportBatch = typeof importBatches.$inferInsert;
