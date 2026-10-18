import { ACCOUNTS_HELP } from "./content/accounts.ts";
import { ANALYSIS_HELP } from "./content/analysis.ts";
import { INVESTING_HELP } from "./content/investing.ts";
import { OVERVIEW_HELP } from "./content/overview.ts";
import { PLANNING_HELP } from "./content/planning.ts";
import { SETTINGS_HELP } from "./content/settings.ts";
import { resolveHelpRoute } from "./resolve.ts";
import type { HelpRoute } from "./routes.ts";
import type { HelpEntry } from "./types.ts";

/**
 * The help registry: every page's entry, keyed by route pattern (ADR-059 §1).
 *
 * Content lives in one module per nav group under `./content/`, so each group's
 * writing (P20-10) is reviewable on its own. The coverage guard in
 * [coverage.test.ts](./coverage.test.ts) asserts that every page has exactly
 * one entry here.
 */

/** Every entry, in nav order. */
export const HELP_ENTRIES: readonly HelpEntry[] = [
  ...OVERVIEW_HELP,
  ...ACCOUNTS_HELP,
  ...INVESTING_HELP,
  ...ANALYSIS_HELP,
  ...PLANNING_HELP,
  ...SETTINGS_HELP,
];

/** Entries by route, built once at module load. */
const BY_ROUTE: ReadonlyMap<HelpRoute, HelpEntry> = new Map(
  HELP_ENTRIES.map((entry) => [entry.route, entry]),
);

/**
 * The help entry for the page at `pathname`.
 *
 * @param pathname - The current path; a query string, hash, or trailing slash is ignored.
 * @returns The page's entry, or `null` when the path has no help (`/login`, an
 *   unknown path). Never throws.
 */
export function helpFor(pathname: string): HelpEntry | null {
  const route = resolveHelpRoute(pathname);
  return route === null ? null : (BY_ROUTE.get(route) ?? null);
}
