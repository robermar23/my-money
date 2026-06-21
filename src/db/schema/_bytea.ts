import { customType } from "drizzle-orm/pg-core";

/**
 * Shared `bytea` column type.
 *
 * Drizzle's standard column types don't include `bytea` directly; this maps to a
 * Node `Buffer` on read so callers get raw file bytes back. Extracted from
 * `import-batches.ts` (Phase 10, P10-02) so both the import re-parse cache and
 * the asset-documents store share one definition.
 *
 * Storing file bytes in Postgres (rather than the filesystem) keeps the single
 * `pg_dump` backup property — restoring the dump re-derives every stored file
 * with no separate mount to back up (CLAUDE.md §Backup Discipline).
 */
export const bytea = customType<{ data: Buffer; default: false }>({
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
