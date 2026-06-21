import { relations, sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { bytea } from "./_bytea.ts";
import { accounts } from "./accounts.ts";

/**
 * asset_documents: proof-of-authenticity files attached to a personal asset
 * (Phase 10, ADR-024).
 *
 * The app's first user-facing document store (the `import_batches.raw_file`
 * bytea is an internal re-parse cache, never served to the browser). Holds
 * titles, receipts, appraisals, and photos for `personal_asset` accounts.
 *
 * Storage: file bytes live in Postgres `bytea` (shared `_bytea` customType) so
 * the existing nightly `age`-encrypted `pg_dump` captures them — single backup,
 * no separate mount, restore unchanged (CLAUDE.md §Backup Discipline).
 *
 * Security (enforced at the upload/download boundary, not here):
 *   - `mime_type` is set from a magic-byte sniff, NOT the client `Content-Type`.
 *   - `filename` is sanitized (path separators stripped) before insert.
 *   - The download route serves bytes attachment-only with `nosniff` — never
 *     inline — and SVG is excluded from the upload whitelist (stored-XSS).
 *
 * One row per uploaded file. `onDelete: cascade` — documents die with the asset.
 */
export const assetDocuments = pgTable(
  "asset_documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references((): AnyPgColumn => accounts.id, { onDelete: "cascade" }),
    /** Sanitized at upload (`sanitizeFilename`). Display + download filename. */
    filename: text("filename").notNull(),
    /** Canonical MIME from the magic-byte detector — never the client header. */
    mimeType: text("mime_type").notNull(),
    /** Byte length; display + a defense-in-depth re-check against the cap. */
    sizeBytes: integer("size_bytes").notNull(),
    /** Raw file content. Bounded by the upload size cap (default 10 MB). */
    bytes: bytea("bytes").notNull(),
    /** Optional user label, e.g. "Title", "2024 appraisal". */
    description: text("description"),
    uploadedAt: timestamp("uploaded_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    // List a single asset's documents newest-first.
    accountUploadedAtIdx: index("asset_documents_account_uploaded_at_idx").on(
      table.accountId,
      sql`${table.uploadedAt} DESC`,
    ),
  }),
);

export const assetDocumentsRelations = relations(assetDocuments, ({ one }) => ({
  account: one(accounts, {
    fields: [assetDocuments.accountId],
    references: [accounts.id],
  }),
}));

export type AssetDocument = typeof assetDocuments.$inferSelect;
export type NewAssetDocument = typeof assetDocuments.$inferInsert;
