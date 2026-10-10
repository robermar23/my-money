// @vitest-environment node
import { readFile, readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { ALL_NAV_GROUPS, UNNAVIGATED_ROUTES } from "./manifest.ts";

/*
 * PLAN19 P19-34 — docs/FEATURES.md is the map of what exists. A map that misses
 * a page is the failure it was written to fix, so a new page without a line
 * there fails here. Detail routes are listed with `<id>` for the dynamic segment.
 */

const DOC = join(process.cwd(), "docs", "FEATURES.md");
const APP = join(process.cwd(), "src", "app");

/**
 * Sub-steps of a flow that FEATURES.md lists by its entry point, not on their
 * own line: the import preview, and the Plaid link wizard.
 */
const LISTED_BY_PARENT = [
  "/accounts/<id>/import/<id>",
  "/accounts/<id>/import/<id>/preview",
  "/settings/connections/<id>/map",
  "/settings/connections/<id>/progress",
  "/watchlist/new",
  "/watchlist/<id>",
  "/watchlist/<id>/edit",
];

async function pageRoutes(dir: string): Promise<string[]> {
  const routes: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) routes.push(...(await pageRoutes(path)));
    else if (entry.name === "page.tsx") {
      const rel = relative(APP, dir).split(sep).join("/");
      routes.push(`/${rel}`.replace(/\[[^\]]+\]/g, "<id>").replace(/\/$/, "") || "/");
    }
  }
  return routes;
}

/** A route is listed when it appears in backticks, alone or followed by text. */
function listed(doc: string, route: string): boolean {
  return doc.includes(`\`${route}\``) || doc.includes(`\`${route} `);
}

describe("docs/FEATURES.md", () => {
  it("lists every page in the navigation", async () => {
    const doc = await readFile(DOC, "utf8");
    const missing = ALL_NAV_GROUPS.flatMap((g) => g.items.map((i) => i.href)).filter(
      (href) => !listed(doc, href),
    );

    expect(missing).toEqual([]);
  });

  it("lists every page route, apart from steps inside a listed flow", async () => {
    const doc = await readFile(DOC, "utf8");
    const routes = await pageRoutes(APP);
    expect(routes.length).toBeGreaterThan(30);
    const missing = routes.filter(
      (r) => !UNNAVIGATED_ROUTES.includes(r) && !LISTED_BY_PARENT.includes(r) && !listed(doc, r),
    );

    expect(missing).toEqual([]);
  });

  it("links only to documents that exist", async () => {
    const doc = await readFile(DOC, "utf8");
    const targets = [...doc.matchAll(/\]\(([^)#]+\.md)/g)].map((m) => m[1] ?? "");

    for (const target of new Set(targets)) {
      await expect(readFile(join(process.cwd(), "docs", target), "utf8")).resolves.toBeTruthy();
    }
  });
});
