// @vitest-environment node
import { describe, expect, it } from "vitest";
import { isTypingTarget } from "./events.ts";
import { loadGlossaryTerms, loadHelpEntry } from "./load.ts";
import { HELP_ROUTES } from "./routes.ts";

describe("loadHelpEntry", () => {
  it("loads every route's entry from its own group's module", async () => {
    // An entry filed in the wrong content module would load as null here,
    // because the panel only fetches the module for the route's group.
    for (const route of HELP_ROUTES) {
      expect((await loadHelpEntry(route))?.route, route).toBe(route);
    }
  });
});

describe("loadGlossaryTerms", () => {
  it("returns the named definitions in the entry's order", async () => {
    const terms = await loadGlossaryTerms(["xirr", "time-weighted-return"]);
    expect(terms.map((t) => t.term)).toEqual(["Money-weighted (XIRR)", "Time-weighted return"]);
    expect(await loadGlossaryTerms([])).toEqual([]);
  });
});

describe("isTypingTarget", () => {
  it("treats form fields and contenteditable as typing, everything else not", () => {
    expect(isTypingTarget({ tagName: "INPUT" } as unknown as EventTarget)).toBe(true);
    expect(isTypingTarget({ tagName: "textarea" } as unknown as EventTarget)).toBe(true);
    expect(isTypingTarget({ tagName: "SELECT" } as unknown as EventTarget)).toBe(true);
    expect(
      isTypingTarget({ tagName: "DIV", isContentEditable: true } as unknown as EventTarget),
    ).toBe(true);
    expect(isTypingTarget({ tagName: "BUTTON" } as unknown as EventTarget)).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});
