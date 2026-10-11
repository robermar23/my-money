import { HELP_ROUTES, type HelpRoute } from "./routes.ts";

/**
 * Pure path → help-route resolution (PLAN20 P20-02).
 *
 * No I/O, no React, no `next/navigation`. A concrete path matches a pattern
 * when the two have the same number of segments and every segment is either
 * equal or a `<id>` in the pattern. Each page has its own entry, so there is
 * **no prefix fallback**: `/accounts/a1/unknown` resolves to nothing rather
 * than to the account page's help.
 *
 * **The most literal pattern wins.** `/accounts/new` matches both
 * `/accounts/new` and `/accounts/<id>`; the pattern with more literal segments
 * is the more specific one, so the "add an account" page gets its own help.
 */

/** The dynamic-segment placeholder used in every pattern. */
const DYNAMIC = "<id>";

/** Each pattern pre-split into segments, built once at module load. */
const SPLIT_ROUTES: readonly (readonly [HelpRoute, readonly string[]])[] = HELP_ROUTES.map(
  (route) => [route, segments(route)] as const,
);

/**
 * Split a path into its segments; `/` has none.
 *
 * @param path - A leading-slash path with no query, hash, or trailing slash.
 * @returns The segments between slashes.
 */
function segments(path: string): string[] {
  return path === "/" ? [] : path.slice(1).split("/");
}

/**
 * Strip the query string, hash, and any trailing slash.
 *
 * @param pathname - A raw pathname, typically from `usePathname()`.
 * @returns The normalized path, or `null` when it does not start with `/`.
 */
function normalize(pathname: string): string | null {
  const path = pathname.split(/[?#]/)[0] ?? "";
  if (!path.startsWith("/")) return null;
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

/**
 * How specific a match is: its count of literal segments, or `-1` for no match.
 *
 * @param pattern - A pattern's segments.
 * @param path - The concrete path's segments.
 * @returns The literal-segment count when every segment matches, else `-1`.
 */
function score(pattern: readonly string[], path: readonly string[]): number {
  if (pattern.length !== path.length) return -1;
  let literals = 0;
  for (let i = 0; i < pattern.length; i++) {
    const want = pattern[i];
    const got = path[i];
    if (got === undefined || got === "") return -1;
    if (want === DYNAMIC) continue;
    if (want !== got) return -1;
    literals++;
  }
  return literals;
}

/**
 * Resolve a concrete path to the help route pattern that explains it.
 *
 * @param pathname - The current path; a query string, hash, or trailing slash is ignored.
 * @returns The most specific matching pattern, or `null` when no page's help
 *   applies (`/login`, an unknown path). Never throws.
 */
export function resolveHelpRoute(pathname: string): HelpRoute | null {
  const path = normalize(pathname);
  if (path === null) return null;
  const parts = segments(path);

  let best: HelpRoute | null = null;
  let bestScore = -1;
  for (const [route, pattern] of SPLIT_ROUTES) {
    const s = score(pattern, parts);
    if (s > bestScore) {
      bestScore = s;
      best = route;
    }
  }
  return best;
}
