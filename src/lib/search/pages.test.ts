import { describe, expect, it } from "vitest";
import { searchPages } from "./pages.ts";

/**
 * Coverage for the palette's local page matcher (NAV-11).
 *
 * Pure input→output with no DB and no network, and it is the guarantee ADR-035
 * leans on — "every destination is one keystroke away" is only true if this
 * finds them. Same test rationale as the resolvers next door.
 */
describe("searchPages", () => {
  it("returns nothing for a term too short to search", () => {
    expect(searchPages("")).toEqual([]);
    expect(searchPages("  ")).toEqual([]);
    expect(searchPages("a")).toEqual([]);
  });

  it("matches a destination by label, case-insensitively", () => {
    const hits = searchPages("forecast");
    expect(hits.map((h) => h.href)).toContain("/investments/forecast");
    expect(searchPages("FORECAST").map((h) => h.href)).toContain("/investments/forecast");
  });

  it("tags results as pages with their group as the subtitle", () => {
    const hit = searchPages("watchlist")[0];
    expect(hit?.kind).toBe("page");
    expect(hit?.href).toBe("/watchlist");
    expect(hit?.subtitle).toBe("Investing");
  });

  it("matches a whole group by its group label", () => {
    const hrefs = searchPages("settings").map((h) => h.href);
    expect(hrefs).toContain("/settings/categories");
    expect(hrefs).toContain("/settings/connections");
  });

  it("falls back to the description when no label matches", () => {
    // No destination is labelled "amortization"-adjacent; "gain/loss" only
    // appears in Portfolio's blurb.
    const hrefs = searchPages("gain/loss").map((h) => h.href);
    expect(hrefs).toEqual(["/investments"]);
  });

  it("ranks a label prefix above a description hit", () => {
    // "Budgets" is a label; "Overview" only mentions budgeting-adjacent words.
    const hits = searchPages("budget");
    expect(hits[0]?.href).toBe("/analysis/budgets");
  });

  it("respects the result cap", () => {
    // The empty-ish term "a" is rejected; "e" too. Use a term matching many
    // descriptions and assert the cap holds.
    expect(searchPages("and", 3).length).toBeLessThanOrEqual(3);
  });

  it("returns [] when nothing matches", () => {
    expect(searchPages("zzzznotathing")).toEqual([]);
  });
});
