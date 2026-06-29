import { type AnyColumn, type SQL, or, sql } from "drizzle-orm";
import { escapeLikeWildcards } from "./term.ts";

/**
 * Trigram search predicates (Phase 12, ADR-028).
 *
 * Thin builders over Drizzle's `sql` template that produce **parameterized**
 * trigram predicates — the search term is always a bound parameter, never
 * concatenated into raw SQL. Each `ILIKE` predicate is index-backed by the
 * `gin_trgm_ops` GIN indexes added in migration `0017`.
 *
 * The caller passes a *normalized* term (from `sanitizeSearchTerm`). These
 * helpers apply LIKE-escaping internally for the `ILIKE` path; `similarityRank`
 * uses the term as-is so the trigram score is not perturbed by escape chars.
 */

/**
 * A case-insensitive substring match: `column ILIKE '%term%'`.
 *
 * The `%term%` operand is built in JS (with wildcards escaped) and bound as a
 * single parameter, so user `%`/`_` match literally. `ESCAPE '\'` is Postgres'
 * default LIKE escape char, stated explicitly for clarity. On NULL columns the
 * predicate is NULL (i.e. false in a WHERE) — exactly what we want.
 *
 * @param column - The text column to match (may be nullable).
 * @param term - A normalized, non-empty search term.
 * @returns A parameterized `SQL` predicate for use in `where(...)`.
 */
export function trigramIlike(column: AnyColumn, term: string): SQL {
  const pattern = `%${escapeLikeWildcards(term)}%`;
  return sql`${column} ILIKE ${pattern} ESCAPE '\'`;
}

/**
 * OR-combine {@link trigramIlike} across several columns — the "match the term
 * in name OR memo" shape. Returns `undefined` for an empty column list so it
 * composes cleanly inside `and(...)`.
 *
 * @param columns - One or more text columns to match against.
 * @param term - A normalized, non-empty search term.
 * @returns A parameterized `SQL` predicate, or `undefined` if no columns given.
 */
export function trigramIlikeAny(columns: readonly AnyColumn[], term: string): SQL | undefined {
  if (columns.length === 0) return undefined;
  return or(...columns.map((c) => trigramIlike(c, term)));
}

/**
 * A `similarity(column, term)` expression for `ORDER BY … DESC` ranking of the
 * palette's capped result groups (most-similar first). Uses the raw normalized
 * term (no LIKE escaping). NULL columns rank last under `DESC NULLS LAST`.
 *
 * @param column - The text column to score.
 * @param term - A normalized, non-empty search term.
 * @returns An `SQL` expression yielding a `real` similarity score.
 */
export function similarityRank(column: AnyColumn, term: string): SQL<number> {
  return sql<number>`similarity(${column}, ${term})`;
}
