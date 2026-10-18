import type { SearchResult } from "@/lib/search/global.ts";
import { MIN_SEARCH_TERM_LENGTH, sanitizeSearchTerm } from "@/lib/search/term.ts";
import { HELP_ENTRIES } from "./registry.ts";
import { resolveHelpRoute } from "./resolve.ts";
import type { HelpEntry } from "./types.ts";

/**
 * The ⌘K palette's "Help" group (PLAN20 P20-07).
 *
 * Pure, local, and synchronous, like [pages.ts](../search/pages.ts): it filters
 * the static help entries in memory with no request. It imports the whole
 * registry, so the palette loads this module with a dynamic `import()` the
 * first time it opens rather than carrying every page's help in the chrome.
 *
 * A result's `id` is the help route pattern to show. Its `href` is where to go
 * first: the pattern itself for a page with no `<id>`, or the current path for
 * one that has an `<id>`, since there is no concrete page to navigate to. The
 * palette then opens the panel on `id`.
 */

/** Ranking tiers, best first. */
const RANK = {
  titlePrefix: 0,
  titleSubstring: 1,
  term: 2,
  summary: 3,
} as const;

type Rank = (typeof RANK)[keyof typeof RANK];

/** Upper bound on help results besides the current page's. */
const MAX_HELP_RESULTS = 5;

/**
 * Score one entry against an already-lowercased term.
 *
 * @param entry - The help entry.
 * @param term - The lowercased, sanitized search term.
 * @returns A {@link Rank}, or `null` when the entry doesn't match.
 */
function rank(entry: HelpEntry, term: string): Rank | null {
  const title = entry.title.toLowerCase();
  if (title.startsWith(term)) return RANK.titlePrefix;
  if (title.includes(term)) return RANK.titleSubstring;
  if (entry.terms?.some((t) => t.toLowerCase().includes(term))) return RANK.term;
  if (entry.summary.toLowerCase().includes(term)) return RANK.summary;
  return null;
}

/**
 * The palette result for one entry.
 *
 * @param entry - The entry the result opens.
 * @param pathname - The current path, used when the entry's page has an `<id>`.
 * @param subtitle - Secondary text, or `null`.
 * @returns A `help` result.
 */
function toResult(entry: HelpEntry, pathname: string, subtitle: string | null): SearchResult {
  return {
    kind: "help",
    id: entry.route,
    title: `Help: ${entry.title}`,
    subtitle,
    href: entry.route.includes("<id>") ? pathname : entry.route,
  };
}

/**
 * Help results for the palette.
 *
 * @param rawTerm - The user-entered query, unsanitized.
 * @param pathname - The current path.
 * @param limit - Maximum matches besides the current page's (default 5).
 * @returns The current page's help first (whatever the query, so it is always
 *   one Enter away), then entries whose title, glossary terms, or summary match
 *   the query, best first.
 */
export function searchHelp(
  rawTerm: string,
  pathname: string,
  limit: number = MAX_HELP_RESULTS,
): SearchResult[] {
  const currentRoute = resolveHelpRoute(pathname);
  const current = HELP_ENTRIES.find((entry) => entry.route === currentRoute);
  const results: SearchResult[] = current ? [toResult(current, pathname, "This page")] : [];

  const sanitized = sanitizeSearchTerm(rawTerm);
  if (sanitized === null || sanitized.length < MIN_SEARCH_TERM_LENGTH) return results;
  const term = sanitized.toLowerCase();

  const scored: { readonly rank: Rank; readonly entry: HelpEntry }[] = [];
  for (const entry of HELP_ENTRIES) {
    if (entry === current) continue;
    const score = rank(entry, term);
    if (score !== null) scored.push({ rank: score, entry });
  }
  // Stable sort keeps nav order within a tier.
  scored.sort((a, b) => a.rank - b.rank);
  for (const { entry } of scored.slice(0, limit)) results.push(toResult(entry, pathname, null));
  return results;
}
