import type { CategoryRule } from "@/db/schema/index.ts";

/**
 * The resolved category for a matched transaction (ADR-018).
 *
 * `categoryId` is the structured FK (the source of truth for analytics);
 * `name` is the human-readable cache written to the legacy `category` text
 * column. `categoryId` is nullable to tolerate a legacy rule that hasn't been
 * linked to a category yet (the backfill links them) — in that case the name
 * still flows through so behavior degrades gracefully rather than dropping the
 * categorization entirely.
 */
export interface MatchedCategory {
  readonly categoryId: string | null;
  readonly name: string;
}

/**
 * In-process regex cache keyed by `${pattern}|||${flags}` so repeated rule
 * application doesn't recompile.
 *
 * Cleared via `clearRegexCache` (only used in tests and after a rule edit if
 * the same flags+pattern is reused with new semantics — unlikely).
 */
const REGEX_CACHE = new Map<string, RegExp>();

function compile(pattern: string, flags: string): RegExp | null {
  const key = `${pattern}|||${flags}`;
  const cached = REGEX_CACHE.get(key);
  if (cached) return cached;
  try {
    const re = new RegExp(pattern, flags);
    REGEX_CACHE.set(key, re);
    return re;
  } catch {
    // Invalid regex — defensive: the write path should have caught this, but
    // a malformed rule snuck into the DB shouldn't crash the importer.
    return null;
  }
}

export function clearRegexCache(): void {
  REGEX_CACHE.clear();
}

/**
 * Validate a regex at write time. Returns null when valid, error string when not.
 */
export function validateRegex(pattern: string, flags: string): string | null {
  try {
    // RegExp throws on invalid pattern or invalid flag chars.
    new RegExp(pattern, flags);
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}

/**
 * Apply rules to a single transaction; return the first matching category
 * (in priority order, then created_at). Returns null if nothing matches.
 *
 * Callers should pre-sort `rules` by (priority asc, createdAt asc) so the
 * inner loop is a simple sequential scan.
 *
 * Returns a `MatchedCategory` ({ categoryId, name }) rather than a bare string
 * (ADR-018): callers persist `categoryId` as the source of truth and `name` as
 * the legacy text cache.
 */
export function matchCategory(
  name: string,
  memo: string | null,
  rules: readonly CategoryRule[],
): MatchedCategory | null {
  for (const rule of rules) {
    if (!rule.enabled) continue;
    const re = compile(rule.pattern, rule.flags);
    if (!re) continue;
    const subject = rule.field === "memo" ? (memo ?? "") : name;
    if (re.test(subject)) return { categoryId: rule.categoryId, name: rule.category };
  }
  return null;
}

/**
 * Sort rules into the canonical evaluation order. The DB-side index covers
 * `enabled`, but we sort here to avoid relying on DB-driver ordering.
 */
export function sortRules(rules: readonly CategoryRule[]): CategoryRule[] {
  return [...rules].sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return a.createdAt.getTime() - b.createdAt.getTime();
  });
}
