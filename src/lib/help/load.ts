import type { GlossaryEntry, GlossaryTermId } from "./glossary.ts";
import { HELP_ROUTE_GROUPS, type HelpGroup, type HelpRoute } from "./routes.ts";
import type { HelpEntry } from "./types.ts";

/**
 * Lazy help loading for the panel (PLAN20 P20-05).
 *
 * The panel must not import [registry.ts](./registry.ts): that would put all
 * 33 pages' help into the chrome's client bundle. Instead each nav group's
 * content module is a dynamic `import()`, so the bundler splits it into its own
 * chunk and the browser fetches only the group of the page being explained.
 */

/** One loader per content module; each becomes its own chunk. */
const LOADERS: Readonly<Record<HelpGroup, () => Promise<readonly HelpEntry[]>>> = {
  overview: async () => (await import("./content/overview.ts")).OVERVIEW_HELP,
  accounts: async () => (await import("./content/accounts.ts")).ACCOUNTS_HELP,
  investing: async () => (await import("./content/investing.ts")).INVESTING_HELP,
  analysis: async () => (await import("./content/analysis.ts")).ANALYSIS_HELP,
  planning: async () => (await import("./content/planning.ts")).PLANNING_HELP,
  settings: async () => (await import("./content/settings.ts")).SETTINGS_HELP,
};

/** Each pattern's group, built once at module load. */
const GROUP_OF: ReadonlyMap<HelpRoute, HelpGroup> = new Map(
  (Object.keys(HELP_ROUTE_GROUPS) as HelpGroup[]).flatMap((group) =>
    HELP_ROUTE_GROUPS[group].map((route): [HelpRoute, HelpGroup] => [route, group]),
  ),
);

/**
 * Load the help entry for one route pattern.
 *
 * @param route - A pattern from `resolveHelpRoute()`.
 * @returns The entry, or `null` when its group's module has none for this
 *   route. A failed chunk load also resolves to `null`: the panel then says
 *   there is no help, which is calmer than an error for a convenience feature.
 */
export async function loadHelpEntry(route: HelpRoute): Promise<HelpEntry | null> {
  const group = GROUP_OF.get(route);
  if (group === undefined) return null;
  try {
    const entries = await LOADERS[group]();
    return entries.find((entry) => entry.route === route) ?? null;
  } catch {
    return null;
  }
}

/**
 * Load the glossary definitions an entry names, in the entry's order.
 *
 * The glossary is its own chunk too, fetched only when the open entry lists
 * terms, so the chrome never carries every definition.
 *
 * @param ids - The entry's `terms`.
 * @returns The definitions, or an empty list when the chunk fails to load
 *   (the panel then shows the entry without its terms section).
 */
export async function loadGlossaryTerms(
  ids: readonly GlossaryTermId[],
): Promise<readonly GlossaryEntry[]> {
  if (ids.length === 0) return [];
  try {
    const { GLOSSARY } = await import("./glossary.ts");
    return ids.map((id) => GLOSSARY[id]);
  } catch {
    return [];
  }
}
