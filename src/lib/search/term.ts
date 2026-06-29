/**
 * Search-term sanitization (Phase 12, ADR-028).
 *
 * Every user-entered search string passes through {@link sanitizeSearchTerm}
 * before it reaches a SQL predicate. The functions here are pure with no DB or
 * network dependency — they are the single guard in front of the trigram
 * matcher, so they get first-class Vitest coverage (CLAUDE.md §Testing
 * Philosophy: this guards a SQL predicate).
 *
 * Two distinct responsibilities, deliberately separate:
 *   - {@link sanitizeSearchTerm} *normalizes* (trim, collapse whitespace, length
 *     bounds). Its output is the human operand used for `similarity()` ranking.
 *   - {@link escapeLikeWildcards} *escapes* the LIKE metacharacters (`\`, `%`,
 *     `_`) for the `ILIKE` predicate only, so `50%` matches the literal "50%"
 *     rather than acting as a wildcard. `similarity()` must NOT see these
 *     escapes (they would perturb the trigram score), which is why escaping is
 *     applied at the predicate, not folded into the normalized term.
 *
 * Neither function builds SQL — interpolation is always parameterized via
 * Drizzle's `sql` template (see {@link ./predicates.ts}).
 */

/** Shortest term we run a query for. 1-char terms match almost everything. */
export const MIN_SEARCH_TERM_LENGTH = 2;

/** Upper bound on term length — a defensive cap, well past any real query. */
export const MAX_SEARCH_TERM_LENGTH = 100;

/**
 * Normalize a raw search term: trim, collapse internal whitespace runs to a
 * single space, reject anything shorter than {@link MIN_SEARCH_TERM_LENGTH}
 * (callers short-circuit to "no query" on `null`), and cap to
 * {@link MAX_SEARCH_TERM_LENGTH}.
 *
 * The result is a plain operand to be passed as a bound parameter — for
 * `similarity()` directly, or to {@link escapeLikeWildcards} for the `ILIKE`
 * predicate. It is never concatenated into raw SQL.
 *
 * @param raw - The user-entered search string (or anything, defensively).
 * @returns The normalized term, or `null` when there is effectively nothing to
 *   search for (empty / whitespace-only / too short).
 */
export function sanitizeSearchTerm(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;

  const collapsed = raw.trim().replace(/\s+/g, " ");
  if (collapsed.length < MIN_SEARCH_TERM_LENGTH) return null;

  return collapsed.slice(0, MAX_SEARCH_TERM_LENGTH);
}

/**
 * Escape the SQL LIKE/ILIKE wildcard metacharacters in a normalized term so
 * they match literally. Backslash is escaped first so the escapes we add are
 * not themselves re-escaped. The result is intended for an `ILIKE … ESCAPE '\'`
 * predicate (`\` is Postgres' default LIKE escape character).
 *
 * @param term - A normalized term (typically from {@link sanitizeSearchTerm}).
 * @returns The term with `\`, `%`, and `_` backslash-escaped.
 */
export function escapeLikeWildcards(term: string): string {
  return term.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}
