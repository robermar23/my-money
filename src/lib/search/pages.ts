import { allDestinations } from "@/lib/nav/resolve.ts";
import type { SearchResult } from "./global.ts";
import { MIN_SEARCH_TERM_LENGTH, sanitizeSearchTerm } from "./term.ts";

/**
 * Page (destination) matching for the ⌘K palette (NAV-11, PLAN_NAV §4.6).
 *
 * This is the escape hatch that makes a two-level nav safe: a destination three
 * clicks deep in a dropdown is still **one keystroke away**. ADR-035 makes
 * manifest membership mandatory — enforced by the coverage guard in
 * [resolve.test.ts](../nav/resolve.test.ts) — precisely so this stays true for
 * every page the app will ever grow.
 *
 * Deliberately **pure, local, and synchronous**: it filters the in-memory nav
 * manifest, with no database query, no `pg_trgm`, and no `server-only` import.
 * So it runs in the palette island itself and paints *before* the debounced
 * record search resolves — and it costs nothing to do so.
 *
 * Type-only import of {@link SearchResult} keeps the server-only `global.ts`
 * out of the client bundle (the type is erased under `isolatedModules`).
 */

/**
 * Ranking tiers, best first — a plain const map rather than an `enum`, which
 * `isolatedModules` disallows in its `const` form and which buys nothing here.
 */
const RANK = {
  labelPrefix: 0,
  labelSubstring: 1,
  groupPrefix: 2,
  descriptionSubstring: 3,
} as const;

type Rank = (typeof RANK)[keyof typeof RANK];

/**
 * Score one destination against an already-lowercased term.
 *
 * @param label - The destination's nav label.
 * @param groupLabel - Its group's label, so "settings" surfaces that group.
 * @param description - Its one-line blurb, matched as a last resort.
 * @param term - The lowercased, sanitized search term.
 * @returns A {@link Rank}, or `null` when the destination doesn't match.
 */
function rank(label: string, groupLabel: string, description: string, term: string): Rank | null {
  const l = label.toLowerCase();
  if (l.startsWith(term)) return RANK.labelPrefix;
  if (l.includes(term)) return RANK.labelSubstring;
  if (groupLabel.toLowerCase().startsWith(term)) return RANK.groupPrefix;
  if (description.toLowerCase().includes(term)) return RANK.descriptionSubstring;
  return null;
}

/** Upper bound on page results, so records are never pushed off the screen. */
const MAX_PAGE_RESULTS = 6;

/**
 * Find the manifest destinations matching a raw search term.
 *
 * Matching is case-insensitive across the destination's label, its group label,
 * and its one-line description — so "settings" surfaces the whole Settings
 * group, and "budget" finds Planning → Budgets by either name or blurb.
 *
 * @param rawTerm - The user-entered query, unsanitized.
 * @param limit - Maximum results to return (default 6).
 * @returns Ranked page jump targets, best match first. Empty when the term is
 *   too short to search for — the same threshold the record search uses, so the
 *   two halves of the palette appear and disappear together.
 */
export function searchPages(rawTerm: string, limit: number = MAX_PAGE_RESULTS): SearchResult[] {
  const sanitized = sanitizeSearchTerm(rawTerm);
  if (sanitized === null || sanitized.length < MIN_SEARCH_TERM_LENGTH) return [];
  const term = sanitized.toLowerCase();

  const scored: { readonly rank: Rank; readonly result: SearchResult }[] = [];
  for (const destination of allDestinations()) {
    const score = rank(destination.label, destination.groupLabel, destination.description, term);
    if (score === null) continue;
    scored.push({
      rank: score,
      result: {
        kind: "page",
        // Stable, unique key — hrefs are unique across the manifest by test.
        id: destination.href,
        title: destination.label,
        subtitle: destination.groupLabel,
        href: destination.href,
      },
    });
  }

  // Stable sort by rank keeps manifest order (the curated IA order) within a
  // tier, so equally-good matches appear in the order the nav shows them.
  scored.sort((a, b) => a.rank - b.rank);
  return scored.slice(0, limit).map((s) => s.result);
}
