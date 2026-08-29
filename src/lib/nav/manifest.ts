import type { Route } from "next";

/**
 * The nav manifest — the single source of truth for every destination in the
 * app (ADR-035, PLAN_NAV §4.1).
 *
 * Four consumers read this module: the desktop top bar, the mobile accordion,
 * the per-section strip, and the ⌘K palette's `page` results. Because it
 * imports **neither React nor `next/navigation`**, it is equally importable
 * from a client island, a server component, and a route handler.
 *
 * **Adding a destination edits this file and nothing else.** The chrome
 * components never gain a hard-coded link again — and a page that is missing
 * from here fails the coverage guard in {@link ./resolve.test.ts}, so it can't
 * silently vanish from both the nav and the palette (ADR-035 rule 5).
 *
 * The manifest holds *data only*: no I/O, no counts. Dynamic badge counts are
 * resolved by the server component that renders the bar and passed down against
 * a {@link BadgeSlot} key, so a future slot is a loader line, not a refactor.
 */

/** A dynamic count rendered beside a label; resolved at render, never stored here. */
export type BadgeSlot = "alerts";

/** One navigable destination. */
export interface NavItem {
  /** Typed route literal — satisfies Next typed-routes with no cast. */
  readonly href: Route;
  readonly label: string;
  /** One-line subtitle shown in the dropdown and in ⌘K page results. */
  readonly description: string;
  /**
   * Extra path prefixes that light this item, for detail/flow routes that don't
   * live under {@link href} (e.g. `/investments/security/[id]` → Portfolio).
   */
  readonly match?: readonly string[];
  /** Exact-match only. `'/'` is the sole user — a prefix would win every path. */
  readonly exact?: boolean;
  readonly badge?: BadgeSlot;
}

/**
 * Group identifiers. `'utilities'` is not a bar trigger — it exists so the
 * right-aligned Alerts destination still resolves like any other route.
 */
export type NavGroupId =
  | "dashboard"
  | "accounts"
  | "investing"
  | "planning"
  | "settings"
  | "utilities";

export interface NavGroup {
  readonly id: NavGroupId;
  readonly label: string;
  readonly items: readonly NavItem[];
}

/**
 * The five bar groups, in render order. Each group's **first item is its
 * landing page** — clicking a trigger's primary link goes there.
 *
 * ADR-035 caps this at **six**. A seventh group means the taxonomy is wrong,
 * not that the bar needs another slot; the designated upgrade is a left
 * sidebar (PLAN_NAV §6.1), which is a re-grouping decision, not an append.
 */
export const NAV_GROUPS: readonly NavGroup[] = [
  {
    id: "dashboard",
    label: "Dashboard",
    items: [
      {
        href: "/",
        label: "Dashboard",
        description: "Net worth, spending, and this month at a glance",
        exact: true,
      },
    ],
  },
  {
    id: "accounts",
    label: "Accounts",
    items: [
      {
        href: "/accounts",
        label: "All accounts",
        description: "Every account, its balance, and its connection status",
      },
      {
        href: "/transactions",
        label: "Transactions",
        description: "Search, filter, and categorize activity across all accounts",
      },
    ],
  },
  {
    id: "investing",
    label: "Investing",
    items: [
      {
        href: "/investments",
        label: "Portfolio",
        description: "Positions, cost basis, and gain/loss",
        // Per-security detail lives outside the href prefix's own subtree
        // shape, so name it explicitly rather than relying on the prefix.
        match: ["/investments/security"],
      },
      {
        href: "/investments/performance",
        label: "Performance",
        description: "Value over time, contributions, and returns",
      },
      {
        href: "/investments/forecast",
        label: "Forecast",
        description: "Projected balances and forward income",
      },
      {
        href: "/watchlist",
        label: "Watchlist",
        description: "Symbols you track and their price targets",
      },
    ],
  },
  {
    id: "planning",
    label: "Planning",
    items: [
      {
        href: "/analysis",
        label: "Overview",
        description: "Spending and income by category and period",
      },
      {
        href: "/analysis/budgets",
        label: "Budgets",
        description: "Per-category budgets and month-to-date pacing",
      },
      {
        href: "/analysis/review",
        label: "Review queue",
        description: "Uncategorized transactions waiting on a decision",
      },
      {
        href: "/plan",
        label: "Guidance",
        description: "Household money guidance and recommended next steps",
      },
      {
        href: "/plan/cashflow",
        label: "Cash flow",
        description: "Projected daily balance, safe to spend, and the bills ahead",
      },
      {
        href: "/plan/cashflow/review",
        label: "Recurring bills",
        description: "Confirm detected bills and manage the ones you track by hand",
      },
    ],
  },
  {
    id: "settings",
    label: "Settings",
    items: [
      {
        href: "/settings/categories",
        label: "Categories",
        description: "The category tree and auto-categorization rules",
      },
      {
        href: "/settings/income",
        label: "Income",
        description: "Paychecks, employer contributions, and income sources",
      },
      {
        href: "/settings/household",
        label: "Household",
        description: "Household profile and the inputs guidance reasons from",
      },
      {
        href: "/settings/connections",
        label: "Connections",
        description: "Plaid connections, sync status, and re-authentication",
      },
    ],
  },
] as const;

/**
 * Right-aligned utilities. Modelled as a {@link NavGroup} so route resolution
 * has one uniform code path, but **deliberately excluded from
 * {@link NAV_GROUPS}** — the bar renders these separately and they never get a
 * dropdown trigger.
 *
 * Alerts is a *notification*, not a section: the badge stays permanently
 * visible rather than hiding one level down inside a group menu.
 */
export const NAV_UTILITY_GROUP: NavGroup = {
  id: "utilities",
  label: "Utilities",
  items: [
    {
      href: "/alerts",
      label: "Alerts",
      description: "Open anomalies and price triggers",
      badge: "alerts",
    },
  ],
} as const;

/** The utility items alone, for chrome that renders them without the wrapper. */
export const NAV_UTILITIES: readonly NavItem[] = NAV_UTILITY_GROUP.items;

/** Every resolvable group, bar groups first. The resolvers search this. */
export const ALL_NAV_GROUPS: readonly NavGroup[] = [...NAV_GROUPS, NAV_UTILITY_GROUP];

/**
 * Routes that intentionally live outside the manifest. `/login` is the only
 * one: it renders without the nav chrome at all (see `src/app/layout.tsx`).
 * The coverage guard allow-lists exactly this set.
 */
export const UNNAVIGATED_ROUTES: readonly string[] = ["/login"];
