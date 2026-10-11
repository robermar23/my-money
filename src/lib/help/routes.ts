/**
 * Every route pattern that has a help entry (PLAN20 P20-02).
 *
 * A pattern is a page's path with each dynamic segment written `<id>`, the
 * same normalization the FEATURES.md guard uses. The list is kept apart from
 * the entries so that resolving a path to its pattern needs no help text:
 * the panel (P20-05) resolves first, then loads only that page's content.
 *
 * Every page under `src/app` except `/login` is listed here, and
 * [coverage.test.ts](./coverage.test.ts) fails when a page is missing.
 */

const OVERVIEW = ["/", "/alerts"] as const;

const ACCOUNTS = [
  "/accounts",
  "/accounts/new",
  "/accounts/<id>",
  "/accounts/<id>/import",
  "/accounts/<id>/import/<id>",
  "/accounts/<id>/import/<id>/preview",
  "/transactions",
] as const;

const INVESTING = [
  "/investments",
  "/investments/performance",
  "/investments/forecast",
  "/investments/security/<id>",
  "/watchlist",
  "/watchlist/new",
  "/watchlist/<id>",
  "/watchlist/<id>/edit",
] as const;

const ANALYSIS = [
  "/analysis",
  "/analysis/networth",
  "/analysis/category/<id>",
  "/analysis/budgets",
  "/analysis/review",
] as const;

const PLANNING = ["/plan", "/plan/cashflow", "/plan/cashflow/review", "/plan/sinking"] as const;

const SETTINGS = [
  "/settings/categories",
  "/settings/connections",
  "/settings/connections/<id>/map",
  "/settings/connections/<id>/progress",
  "/settings/household",
  "/settings/income",
  "/settings/instance",
] as const;

/**
 * The patterns by nav group. Each group's entries live in one content module,
 * so the panel loads only the group of the page it is on (P20-05).
 */
export const HELP_ROUTE_GROUPS = {
  overview: OVERVIEW,
  accounts: ACCOUNTS,
  investing: INVESTING,
  analysis: ANALYSIS,
  planning: PLANNING,
  settings: SETTINGS,
} as const;

/** A nav group with its own help content module. */
export type HelpGroup = keyof typeof HELP_ROUTE_GROUPS;

/** Every pattern, in nav order. */
export const HELP_ROUTES = [
  ...OVERVIEW,
  ...ACCOUNTS,
  ...INVESTING,
  ...ANALYSIS,
  ...PLANNING,
  ...SETTINGS,
] as const;

/** A route pattern with a help entry. */
export type HelpRoute = (typeof HELP_ROUTES)[number];
