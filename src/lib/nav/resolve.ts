import { ALL_NAV_GROUPS, type NavGroup, type NavGroupId, type NavItem } from "./manifest.ts";

/**
 * Pure route→nav resolution (ADR-035 rule 4, PLAN_NAV §4.2).
 *
 * Four functions, no I/O, no React, no `next/navigation`. This is the only part
 * of the nav that carries real logic, so it is the only part that gets Vitest
 * coverage (CLAUDE.md §Testing Philosophy: pure UI is tested sparingly).
 *
 * **Longest-prefix, not first-match**, is the whole trick.
 * `/investments/performance` matches both `/investments` and
 * `/investments/performance`; the longer wins. `/analysis/category/abc`
 * resolves to Overview and not Budgets, because it does not sit under
 * `/analysis/budgets`. And `'/'` is `exact` — as a prefix it would win every
 * path in the app.
 */

/** A resolved route: which group owns it, and which item within that group. */
export interface NavMatch {
  readonly group: NavGroup;
  readonly item: NavItem;
}

/** One manifest destination flattened out of its group, for ⌘K page results. */
export interface NavDestination extends NavItem {
  readonly groupId: NavGroupId;
  readonly groupLabel: string;
}

/**
 * Does `pathname` sit at or under `prefix`, respecting segment boundaries?
 *
 * Segment-aware so `/analysis` never claims a future `/analysis-archive` — a
 * bare `startsWith` would, and that class of bug is invisible until the sibling
 * route ships.
 *
 * @param pathname - The current path, leading-slash, no query or hash.
 * @param prefix - A manifest `href` or `match[]` entry.
 * @returns True when `pathname` equals `prefix` or is nested beneath it.
 */
function matchesPrefix(pathname: string, prefix: string): boolean {
  if (prefix === "/") return pathname === "/";
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/**
 * The length of the longest manifest prefix that claims `pathname`, or `-1`
 * when the item doesn't claim it at all.
 *
 * An `exact` item scores only on strict equality; its `href` length is still
 * used as the score so exactness and specificity rank on the same scale.
 */
function scoreItem(item: NavItem, pathname: string): number {
  if (item.exact) return pathname === item.href ? item.href.length : -1;

  let best = -1;
  if (matchesPrefix(pathname, item.href)) best = item.href.length;
  for (const prefix of item.match ?? []) {
    if (matchesPrefix(pathname, prefix) && prefix.length > best) best = prefix.length;
  }
  return best;
}

/**
 * Normalize a pathname before resolution: strip any query string / hash and any
 * trailing slash, so `/accounts/` and `/accounts?x=1` resolve like `/accounts`.
 *
 * @param pathname - A raw pathname, typically from `usePathname()`.
 * @returns The normalized path. `'/'` is preserved as-is.
 */
function normalize(pathname: string): string {
  const withoutQuery = pathname.split(/[?#]/)[0] ?? "";
  if (withoutQuery.length > 1 && withoutQuery.endsWith("/")) return withoutQuery.slice(0, -1);
  return withoutQuery === "" ? "/" : withoutQuery;
}

/**
 * Resolve a pathname to the single manifest entry that owns it, by
 * longest-prefix match across every item's `href` and `match[]` entries.
 *
 * @param pathname - The current path (query/hash and trailing slash tolerated).
 * @returns The owning group and item, or `null` for routes deliberately outside
 *   the manifest (`/login`) — callers render no nav state for those.
 */
export function resolveActive(pathname: string): NavMatch | null {
  const path = normalize(pathname);

  let best: NavMatch | null = null;
  let bestScore = -1;

  for (const group of ALL_NAV_GROUPS) {
    for (const item of group.items) {
      const score = scoreItem(item, path);
      if (score > bestScore) {
        bestScore = score;
        best = { group, item };
      }
    }
  }

  return best;
}

/**
 * The sibling destinations to render in the section strip for `pathname`.
 *
 * @param pathname - The current path.
 * @returns The resolved group's items, or `[]` when the route resolves nowhere
 *   or lands in a single-item group (Dashboard, Alerts) — a one-tab strip is
 *   noise, so the caller renders nothing.
 */
export function sectionItemsFor(pathname: string): readonly NavItem[] {
  const match = resolveActive(pathname);
  if (match === null || match.group.items.length <= 1) return [];
  return match.group.items;
}

/**
 * Is `item` the destination the user is currently on?
 *
 * Delegates to {@link resolveActive} rather than re-testing the prefix locally,
 * so a link is current only when it *wins* the longest-prefix contest — on
 * `/investments/performance`, Portfolio is not current even though its prefix
 * matches.
 *
 * @param item - A manifest item being rendered as a link.
 * @param pathname - The current path.
 * @returns True when the link should carry `aria-current="page"`.
 */
export function isCurrent(item: NavItem, pathname: string): boolean {
  return resolveActive(pathname)?.item.href === item.href;
}

/**
 * Every destination in the manifest, flattened and tagged with its group, for
 * the ⌘K palette's `page` results.
 *
 * @returns All items across all groups (utilities included), in manifest order.
 */
export function allDestinations(): readonly NavDestination[] {
  const out: NavDestination[] = [];
  for (const group of ALL_NAV_GROUPS) {
    for (const item of group.items) {
      out.push({ ...item, groupId: group.id, groupLabel: group.label });
    }
  }
  return out;
}
