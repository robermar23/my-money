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
export const HELP_ROUTES = [
  // Overview
  "/",
  "/alerts",
  // Accounts
  "/accounts",
  "/accounts/new",
  "/accounts/<id>",
  "/accounts/<id>/import",
  "/accounts/<id>/import/<id>",
  "/accounts/<id>/import/<id>/preview",
  "/transactions",
  // Investing
  "/investments",
  "/investments/performance",
  "/investments/forecast",
  "/investments/security/<id>",
  "/watchlist",
  "/watchlist/new",
  "/watchlist/<id>",
  "/watchlist/<id>/edit",
  // Analysis
  "/analysis",
  "/analysis/networth",
  "/analysis/category/<id>",
  "/analysis/budgets",
  "/analysis/review",
  // Planning
  "/plan",
  "/plan/cashflow",
  "/plan/cashflow/review",
  "/plan/sinking",
  // Settings
  "/settings/categories",
  "/settings/connections",
  "/settings/connections/<id>/map",
  "/settings/connections/<id>/progress",
  "/settings/household",
  "/settings/income",
  "/settings/instance",
] as const;

/** A route pattern with a help entry. */
export type HelpRoute = (typeof HELP_ROUTES)[number];
