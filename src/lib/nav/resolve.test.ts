import { readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ALL_NAV_GROUPS, NAV_GROUPS, type NavItem, UNNAVIGATED_ROUTES } from "./manifest.ts";
import { allDestinations, isCurrent, resolveActive, sectionItemsFor } from "./resolve.ts";

/**
 * Resolver coverage for the nav manifest (NAV-03, NAV-04).
 *
 * Two jobs. First, prove the longest-prefix rules in {@link resolveActive} —
 * the only real logic in the nav, and the part that silently mis-fires when a
 * sibling route ships. Second, the **coverage guard**: every `page.tsx` under
 * `src/app` must resolve to exactly one group, so a future page can never fall
 * out of both the bar and the palette unnoticed (ADR-035 rule 5).
 */

/** Look an item up by href, failing loudly if the manifest ever drops it. */
function itemAt(href: string): NavItem {
  for (const group of ALL_NAV_GROUPS) {
    for (const item of group.items) {
      if (item.href === href) return item;
    }
  }
  throw new Error(`manifest has no item for ${href}`);
}

describe("resolveActive", () => {
  it("resolves a group landing page to its own item", () => {
    const match = resolveActive("/accounts");
    expect(match?.group.id).toBe("accounts");
    expect(match?.item.href).toBe("/accounts");
  });

  it("prefers the longest prefix over a shorter parent", () => {
    // Both `/investments` and `/investments/performance` match; longer wins.
    const match = resolveActive("/investments/performance");
    expect(match?.group.id).toBe("investing");
    expect(match?.item.href).toBe("/investments/performance");
  });

  it("falls back to the parent when no deeper item claims the path", () => {
    // `/analysis/category/[id]` is not under `/analysis/budgets`, so Overview
    // wins — the case that breaks under naive first-match ordering.
    const match = resolveActive("/analysis/category/9f3c");
    expect(match?.group.id).toBe("analysis");
    expect(match?.item.href).toBe("/analysis");
  });

  it("treats '/' as exact so it never wins another path", () => {
    expect(resolveActive("/")?.item.href).toBe("/");
    expect(resolveActive("/transactions")?.item.href).toBe("/transactions");
    expect(resolveActive("/plan")?.item.href).toBe("/plan");
  });

  it("respects segment boundaries, not bare string prefixes", () => {
    // A hypothetical sibling must not be swallowed by `/analysis/budgets`.
    const match = resolveActive("/analysis/budgets-archive");
    expect(match?.item.href).toBe("/analysis");
  });

  it("honours explicit match[] prefixes", () => {
    const match = resolveActive("/investments/security/abc-123");
    expect(match?.group.id).toBe("investing");
    expect(match?.item.href).toBe("/investments");
  });

  it.each([
    ["/accounts/new", "/accounts"],
    ["/accounts/1234", "/accounts"],
    ["/accounts/1234/import", "/accounts"],
    ["/accounts/1234/import/5678/preview", "/accounts"],
    ["/watchlist/new", "/watchlist"],
    ["/watchlist/abc/edit", "/watchlist"],
    ["/settings/connections/item-1/map", "/settings/connections"],
    ["/settings/connections/item-1/progress", "/settings/connections"],
    ["/analysis/review", "/analysis/review"],
    ["/investments/forecast", "/investments/forecast"],
  ])("resolves detail/flow route %s to %s", (pathname, expected) => {
    expect(resolveActive(pathname)?.item.href).toBe(expected);
  });

  it("returns null for routes deliberately outside the manifest", () => {
    expect(resolveActive("/login")).toBeNull();
    expect(resolveActive("/nope/not/a/route")).toBeNull();
  });

  it("resolves the Alerts utility even though it is not a bar group", () => {
    const match = resolveActive("/alerts");
    expect(match?.group.id).toBe("utilities");
    expect(match?.item.badge).toBe("alerts");
    expect(NAV_GROUPS.some((g) => g.id === "utilities")).toBe(false);
  });

  it("tolerates a trailing slash and a query string", () => {
    expect(resolveActive("/accounts/")?.item.href).toBe("/accounts");
    expect(resolveActive("/analysis?from=2026-01-01")?.item.href).toBe("/analysis");
  });
});

describe("sectionItemsFor", () => {
  it("returns the group's siblings for a multi-item group", () => {
    const items = sectionItemsFor("/investments/forecast");
    expect(items.map((i) => i.href)).toEqual([
      "/investments",
      "/investments/performance",
      "/investments/forecast",
      "/watchlist",
    ]);
  });

  it("returns [] for single-item groups — a one-tab strip is noise", () => {
    expect(sectionItemsFor("/")).toEqual([]);
    expect(sectionItemsFor("/alerts")).toEqual([]);
  });

  it("returns [] for an unresolved route", () => {
    expect(sectionItemsFor("/login")).toEqual([]);
  });
});

describe("isCurrent", () => {
  it("marks only the winning item current, not a matching ancestor", () => {
    expect(isCurrent(itemAt("/investments/performance"), "/investments/performance")).toBe(true);
    expect(isCurrent(itemAt("/investments"), "/investments/performance")).toBe(false);
  });

  it("keeps the parent current inside its own detail routes", () => {
    expect(isCurrent(itemAt("/investments"), "/investments/security/abc")).toBe(true);
    expect(isCurrent(itemAt("/accounts"), "/accounts/1/import")).toBe(true);
  });

  it("never marks Dashboard current on a non-root path", () => {
    expect(isCurrent(itemAt("/"), "/accounts")).toBe(false);
    expect(isCurrent(itemAt("/"), "/")).toBe(true);
  });
});

describe("allDestinations", () => {
  it("flattens every group item and tags it with its group", () => {
    const all = allDestinations();
    const expected = ALL_NAV_GROUPS.reduce((n, g) => n + g.items.length, 0);
    expect(all).toHaveLength(expected);
    expect(all.find((d) => d.href === "/plan")?.groupLabel).toBe("Planning");
    expect(all.find((d) => d.href === "/alerts")?.groupId).toBe("utilities");
  });

  it("gives every destination a non-empty description for the palette", () => {
    for (const d of allDestinations()) {
      expect(d.description.length, `${d.href} needs a description`).toBeGreaterThan(0);
    }
  });

  it("has no duplicate hrefs — exactly one item owns each destination", () => {
    const hrefs = allDestinations().map((d) => d.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });
});

describe("manifest membership of the deeper /plan routes", () => {
  /**
   * The coverage guard below cannot catch a MISSING entry for these.
   *
   * It asserts every `page.tsx` resolves to some group, and longest-prefix
   * resolution means `/plan/sinking` with no manifest entry of its own still
   * resolves — to `/plan`, its parent. The page keeps working, the bar keeps
   * rendering, and the destination silently vanishes from the menu and from the
   * ⌘K palette, which ADR-035 §5 calls the escape hatch that makes the depth
   * safe. So the entry is asserted directly, by the item it must resolve to.
   */
  it.each([
    ["/plan/sinking", "Sinking funds"],
    ["/plan/cashflow", "Cash flow"],
    ["/plan/cashflow/review", "Recurring bills"],
  ])("%s owns its own manifest item, not its parent's", (route, label) => {
    const match = resolveActive(route);
    expect(match?.item.href).toBe(route);
    expect(match?.item.label).toBe(label);
    expect(allDestinations().map((d) => d.href)).toContain(route);
  });
});

describe("manifest shape (ADR-035 invariants)", () => {
  it("caps the bar at six groups", () => {
    expect(NAV_GROUPS.length).toBeLessThanOrEqual(6);
  });

  it("caps each group menu at seven items", () => {
    for (const group of ALL_NAV_GROUPS) {
      expect(group.items.length, `${group.id} menu is too deep`).toBeLessThanOrEqual(7);
    }
  });
});

/**
 * Convert a `page.tsx` path (relative to `src/app`) into the route it serves:
 * drop route groups `(marketing)` and parallel slots `@modal`, substitute a
 * sample value for dynamic segments, and strip the trailing `page.tsx`.
 */
function routeForPageFile(relativePath: string): string {
  const segments = relativePath.split(/[\\/]/).slice(0, -1);
  const parts: string[] = [];
  for (const segment of segments) {
    if (segment.startsWith("(") && segment.endsWith(")")) continue; // route group
    if (segment.startsWith("@")) continue; // parallel route slot
    parts.push(segment.startsWith("[") ? "sample-segment-value" : segment);
  }
  return `/${parts.join("/")}`;
}

/** Recursively collect every `page.tsx` under `src/app`, relative to that root. */
async function appPageFiles(): Promise<string[]> {
  const root = path.join(process.cwd(), "src", "app");
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && e.name === "page.tsx")
    .map((e) => path.relative(root, path.join(e.parentPath, e.name)));
}

describe("coverage guard: every page belongs to a group", () => {
  it("finds the app's pages at all (guards against a silently empty glob)", async () => {
    expect((await appPageFiles()).length).toBeGreaterThan(20);
  });

  it("resolves every page.tsx route to exactly one group", async () => {
    const files = await appPageFiles();
    const orphans: string[] = [];

    for (const file of files) {
      const route = routeForPageFile(file);
      if (UNNAVIGATED_ROUTES.includes(route)) continue;
      if (resolveActive(route) === null) orphans.push(`${route}  (src/app/${file})`);
    }

    expect(
      orphans,
      `These pages have no manifest entry, so they are unreachable from the nav and from ⌘K. Add them to src/lib/nav/manifest.ts (ADR-035 rule 5):\n  ${orphans.join("\n  ")}`,
    ).toEqual([]);
  });
});
