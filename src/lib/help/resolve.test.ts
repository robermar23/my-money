// @vitest-environment node
import { describe, expect, it } from "vitest";
import { helpFor } from "./registry.ts";
import { resolveHelpRoute } from "./resolve.ts";
import { HELP_ROUTES } from "./routes.ts";

/** A concrete path for a pattern: each `<id>` becomes a distinct UUID-shaped segment. */
function concrete(pattern: string): string {
  let n = 0;
  return pattern.replace(/<id>/g, () => `0000000${++n}-aaaa-4bbb-8ccc-dddddddddddd`);
}

describe("resolveHelpRoute", () => {
  it("resolves every pattern's concrete path to that pattern, not its parent's", () => {
    for (const pattern of HELP_ROUTES) {
      expect(resolveHelpRoute(concrete(pattern)), pattern).toBe(pattern);
    }
  });

  it("prefers a literal segment over a dynamic one", () => {
    expect(resolveHelpRoute("/accounts/new")).toBe("/accounts/new");
    expect(resolveHelpRoute("/watchlist/new")).toBe("/watchlist/new");
    expect(resolveHelpRoute("/accounts/abc")).toBe("/accounts/<id>");
  });

  it("resolves a flow step to its own entry", () => {
    expect(resolveHelpRoute("/accounts/a1/import/b2/preview")).toBe(
      "/accounts/<id>/import/<id>/preview",
    );
    expect(resolveHelpRoute("/accounts/a1/import/b2")).toBe("/accounts/<id>/import/<id>");
    expect(resolveHelpRoute("/settings/connections/p1/map")).toBe("/settings/connections/<id>/map");
  });

  it("ignores query strings, hashes, and a trailing slash", () => {
    expect(resolveHelpRoute("/transactions?q=coffee")).toBe("/transactions");
    expect(resolveHelpRoute("/plan/cashflow#calendar")).toBe("/plan/cashflow");
    expect(resolveHelpRoute("/accounts/")).toBe("/accounts");
    expect(resolveHelpRoute("/?from=login")).toBe("/");
  });

  it("returns null for a path with no help, and never throws", () => {
    for (const path of [
      "/login",
      "/nope",
      "/accounts/a1/unknown",
      "/accounts/a1/import/b2/preview/extra",
      "/accounts//import",
      "accounts",
    ]) {
      expect(() => resolveHelpRoute(path)).not.toThrow();
      expect(resolveHelpRoute(path), path).toBeNull();
    }
  });
});

describe("helpFor", () => {
  it("returns the entry whose route the path resolves to", () => {
    expect(helpFor("/analysis/category/c1")?.route).toBe("/analysis/category/<id>");
    expect(helpFor("/")?.route).toBe("/");
  });

  it("returns null when the path resolves to nothing", () => {
    expect(helpFor("/login")).toBeNull();
  });
});
