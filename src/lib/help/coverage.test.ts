// @vitest-environment node
import { pageRoutes } from "@/__test-support__/page-routes.ts";
import { describe, expect, it } from "vitest";
import { UNNAVIGATED_ROUTES } from "../nav/manifest.ts";
import { HELP_ENTRIES } from "./registry.ts";
import { HELP_ROUTES } from "./routes.ts";

/*
 * PLAN20 P20-03 — every page explains itself. A new page without a help entry
 * fails here, exactly as a page missing from the nav fails resolve.test.ts.
 * `/login` is the one exception: it renders without the chrome, so there is
 * no `?` to press.
 */

/** Values that appear more than once, for a readable failure. */
function duplicates(values: readonly string[]): string[] {
  return values.filter((v, i) => values.indexOf(v) !== i);
}

describe("help coverage", () => {
  it("has a help route for every page except the unnavigated ones", async () => {
    const pages = (await pageRoutes()).filter((r) => !UNNAVIGATED_ROUTES.includes(r));
    expect(pages.length).toBeGreaterThan(30);
    const listed: readonly string[] = HELP_ROUTES;

    expect(pages.filter((r) => !listed.includes(r))).toEqual([]);
  });

  it("lists no route that is not a page", async () => {
    const pages = await pageRoutes();

    expect(HELP_ROUTES.filter((r) => !pages.includes(r))).toEqual([]);
  });

  it("has exactly one entry per help route", () => {
    const routes = HELP_ENTRIES.map((e) => e.route);

    expect(duplicates(routes)).toEqual([]);
    expect(duplicates(HELP_ROUTES)).toEqual([]);
    expect(HELP_ROUTES.filter((r) => !routes.includes(r))).toEqual([]);
  });

  it("gives every entry a title and a one-line summary", () => {
    for (const entry of HELP_ENTRIES) {
      expect(entry.title.trim(), entry.route).not.toBe("");
      expect(entry.summary.trim(), entry.route).not.toBe("");
      expect(entry.summary, entry.route).not.toContain("\n");
    }
  });
});
