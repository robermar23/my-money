import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

/**
 * Shared SQL fragment helpers for schema definitions.
 *
 * Non-table module (leading underscore, like `_bytea.ts`); deliberately NOT
 * re-exported from the barrel, so it never lands in the schema namespace the
 * Drizzle client and drizzle-kit scan.
 */

/**
 * Render a `const` vocabulary tuple as the body of a SQL `IN (...)` list.
 *
 * The point is that a CHECK constraint cannot silently drift from the
 * TypeScript tuple that names its legal values (ADR-037 §3, and the reason
 * P16-01 spent a compile-time assertion on the same concern for cadences).
 * Writing the literals twice — once in a `const` tuple for the app and once in
 * a hand-typed `sql` template for the CHECK — is exactly the shape of divergence
 * that ADR is written to prevent: the two look identical at review time and
 * nothing fails when they stop being. Derived, an edit to the tuple shows up as
 * a `drizzle-kit generate` diff instead of as nothing at all.
 *
 * `sql.raw` is safe here and only here: every caller passes a compile-time
 * `as const` tuple of literals declared in this repo. Never pass user input.
 *
 * @param values - The vocabulary, e.g. `OBLIGATION_DIRECTIONS`.
 * @returns A raw SQL fragment: `'outflow', 'inflow'`.
 */
export function inList(values: readonly string[]): SQL {
  return sql.raw(values.map((value) => `'${value}'`).join(", "));
}
