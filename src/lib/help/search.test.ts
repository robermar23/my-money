// @vitest-environment node
import { describe, expect, it } from "vitest";
import { searchHelp } from "./search.ts";

describe("searchHelp", () => {
  it("offers the current page's help first, even with no query", () => {
    const [first, ...rest] = searchHelp("", "/plan/cashflow");
    expect(first).toMatchObject({
      kind: "help",
      id: "/plan/cashflow",
      title: "Help: Cash flow",
      subtitle: "This page",
      href: "/plan/cashflow",
    });
    expect(rest).toEqual([]);
  });

  it("keeps the concrete path for the current page when it has an <id>", () => {
    const [first] = searchHelp("", "/accounts/a1");
    expect(first?.id).toBe("/accounts/<id>");
    expect(first?.href).toBe("/accounts/a1");
  });

  it("offers nothing for the current page when it has no help", () => {
    expect(searchHelp("", "/login")).toEqual([]);
  });

  it("matches other pages' help by title, after the current page", () => {
    const ids = searchHelp("watch", "/").map((r) => r.id);
    expect(ids[0]).toBe("/");
    expect(ids).toContain("/watchlist");
    expect(ids.filter((id) => id === "/")).toHaveLength(1);
  });

  it("stays on the current path for a match whose page has an <id>", () => {
    const hit = searchHelp("security", "/transactions").find(
      (r) => r.id === "/investments/security/<id>",
    );
    expect(hit?.href).toBe("/transactions");
  });

  it("caps the matches", () => {
    expect(searchHelp("the", "/login", 2).length).toBeLessThanOrEqual(2);
  });
});
