// @vitest-environment node
import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { allDestinations } from "../nav/resolve.ts";
import { GLOSSARY, type GlossaryTermId } from "./glossary.ts";
import { HELP_ENTRIES } from "./registry.ts";
import type { HelpBlock, HelpEntry, HelpText } from "./types.ts";

/*
 * PLAN20 P20-09 / P20-11 — the copy rules that a test can check.
 *
 * The rest (second person, no tax advice, every claim sourced from the shipped
 * code) is applied in review. What is mechanical is enforced here, so a later
 * edit cannot quietly break it:
 *
 *   - every page has written help, not a placeholder;
 *   - 150–300 words a page. More than that means the page needs fixing, not
 *     more text (PLAN20 Open Items);
 *   - help stands on its own: no link or path into `docs/` (gate 3);
 *   - no dollar figure: help never states a number the app computes (Hard
 *     boundary #1), and a static figure would read as one;
 *   - the glossary uses the pages' own words, and every term is used.
 */

const MIN_WORDS = 150;
const MAX_WORDS = 300;

/** Every string a run of help text holds. */
function textOf(text: HelpText): string {
  return typeof text === "string"
    ? text
    : text.map((span) => (typeof span === "string" ? span : span.strong)).join("");
}

/** Every string one block renders. */
function blockText(block: HelpBlock): string[] {
  switch (block.kind) {
    case "paragraph":
    case "callout":
      return [textOf(block.text)];
    case "steps":
      return block.items.map(textOf);
    case "definition":
      return [block.term, textOf(block.text)];
  }
}

/** Every string an entry renders in its body, summary and headings included. */
function entryText(entry: HelpEntry): string[] {
  return [
    entry.summary,
    ...entry.sections.flatMap((s) => [s.heading, ...s.blocks.flatMap(blockText)]),
  ];
}

function wordCount(entry: HelpEntry): number {
  return entryText(entry).join(" ").split(/\s+/).filter(Boolean).length;
}

/** Concatenated UI source the glossary's words must appear in. */
async function uiSource(): Promise<string> {
  const roots = ["src/app", "src/components", "src/lib"];
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const ent of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, ent.name);
      if (ent.isDirectory()) {
        await walk(path);
      } else if (
        /\.tsx?$/.test(ent.name) &&
        !/\.test\.tsx?$/.test(ent.name) &&
        !relative("src/lib/help", path).match(/^[^.]/) &&
        !relative("src/components/help", path).match(/^[^.]/)
      ) {
        out.push(await readFile(path, "utf8"));
      }
    }
  };
  for (const root of roots) await walk(root);
  return out.join("\n").toLowerCase();
}

describe("help copy rules", () => {
  it("gives every page written sections, not a placeholder", () => {
    for (const entry of HELP_ENTRIES) {
      expect(entry.sections.length, entry.route).toBeGreaterThan(0);
      for (const section of entry.sections) {
        expect(section.blocks.length, `${entry.route} › ${section.heading}`).toBeGreaterThan(0);
      }
    }
  });

  it(`keeps every page between ${MIN_WORDS} and ${MAX_WORDS} words`, () => {
    const outside = HELP_ENTRIES.map((e) => [e.route, wordCount(e)] as const).filter(
      ([, n]) => n < MIN_WORDS || n > MAX_WORDS,
    );
    expect(outside).toEqual([]);
  });

  it("never points the reader at the repository docs", () => {
    for (const entry of HELP_ENTRIES) {
      for (const text of entryText(entry)) {
        expect(text, entry.route).not.toMatch(/docs\/|\.md\b|https?:/i);
      }
    }
  });

  it("states no dollar figure", () => {
    const glossaryText = Object.values(GLOSSARY).flatMap((g) => [g.means, g.tellsYou]);
    for (const text of [...HELP_ENTRIES.flatMap(entryText), ...glossaryText]) {
      expect(text).not.toMatch(/\$\s?\d/);
    }
  });

  it("links only to nav destinations, never to the page itself", () => {
    const destinations = new Set<string>(allDestinations().map((d) => d.href));
    for (const entry of HELP_ENTRIES) {
      for (const route of entry.relatedRoutes ?? []) {
        expect(destinations.has(route), `${entry.route} → ${route}`).toBe(true);
        expect(route, entry.route).not.toBe(entry.route);
      }
    }
  });
});

describe("glossary", () => {
  const ids = Object.keys(GLOSSARY) as GlossaryTermId[];

  it("names each term the way some page already prints it", async () => {
    const source = await uiSource();
    const missing = ids.filter((id) => !source.includes(GLOSSARY[id].term.toLowerCase()));
    expect(missing).toEqual([]);
  });

  it("defines every term an entry names, once per entry", () => {
    for (const entry of HELP_ENTRIES) {
      const terms = entry.terms ?? [];
      expect(new Set(terms).size, entry.route).toBe(terms.length);
      for (const id of terms) expect(GLOSSARY[id], `${entry.route} › ${id}`).toBeDefined();
    }
  });

  it("has no term that no page uses", () => {
    const used = new Set(HELP_ENTRIES.flatMap((e) => e.terms ?? []));
    expect(ids.filter((id) => !used.has(id))).toEqual([]);
  });
});
