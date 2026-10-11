// @vitest-environment node
import { readFile, readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { HELP_ENTRIES } from "./registry.ts";
import { TOUR_ANCHORS, type TourDefinition } from "./types.ts";

/*
 * PLAN20 P20-17 — the anchor guard. A tour step points at a `data-tour`
 * attribute in page markup; when the page changes and the attribute goes, the
 * step would silently vanish (the engine skips a missing anchor). This scan
 * catches that in CI, and the reverse too: an attribute no tour uses is
 * clutter in the page.
 *
 * A static source scan, like features-doc.test.ts: no browser, no database.
 * It therefore only sees literal attributes, so `data-tour={…}` is rejected.
 */

/** The roots page markup lives under. */
const ROOTS = ["src/app", "src/components"];

/** A literal anchor attribute in source. */
const LITERAL = /data-tour="([^"]*)"/g;
/** Any anchor attribute, literal or not. */
const ANY = /data-tour=/g;
const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Where each anchor literal is written, as `file:line`. */
type Sites = Map<string, string[]>;

/** Every non-test `.tsx` file under the markup roots. */
async function markupFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  for (const ent of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, ent.name);
    if (ent.isDirectory()) files.push(...(await markupFiles(path)));
    else if (ent.name.endsWith(".tsx") && !ent.name.endsWith(".test.tsx")) files.push(path);
  }
  return files;
}

/**
 * The anchor literals in one file, and any attribute that is not a literal.
 *
 * @param source - The file's text.
 * @param file - Its path, for messages.
 */
function scanAnchors(
  source: string,
  file: string,
): { readonly literals: [string, string][]; readonly dynamic: string[] } {
  const literals: [string, string][] = [];
  const dynamic: string[] = [];
  source.split("\n").forEach((line, i) => {
    const site = `${file}:${i + 1}`;
    const found = [...line.matchAll(LITERAL)];
    for (const m of found) literals.push([m[1] ?? "", site]);
    if ([...line.matchAll(ANY)].length > found.length) dynamic.push(site);
  });
  return { literals, dynamic };
}

/** Every anchor literal in the markup, and every non-literal attribute. */
async function scanMarkup(): Promise<{ sites: Sites; dynamic: string[] }> {
  const sites: Sites = new Map();
  const dynamic: string[] = [];
  for (const root of ROOTS) {
    for (const path of await markupFiles(root)) {
      const file = relative(process.cwd(), path).split(sep).join("/");
      const scan = scanAnchors(await readFile(path, "utf8"), file);
      dynamic.push(...scan.dynamic);
      for (const [anchor, site] of scan.literals)
        sites.set(anchor, [...(sites.get(anchor) ?? []), site]);
    }
  }
  return { sites, dynamic };
}

const TOURS: readonly (TourDefinition & { readonly route: string })[] = HELP_ENTRIES.flatMap((e) =>
  e.tour ? [{ ...e.tour, route: e.route }] : [],
);
const STEP_ANCHORS: ReadonlySet<string> = new Set(
  TOURS.flatMap((t) => t.steps.map((s) => s.anchor)),
);
const DECLARED: readonly string[] = TOUR_ANCHORS;

describe("the scanner", () => {
  it("finds literal anchors and flags computed ones", () => {
    const scan = scanAnchors(
      ['<div data-tour="cash-chart">', "<p data-tour={anchor}>", "<b>"].join("\n"),
      "x.tsx",
    );
    expect(scan.literals).toEqual([["cash-chart", "x.tsx:1"]]);
    expect(scan.dynamic).toEqual(["x.tsx:2"]);
  });
});

describe("tour anchors", () => {
  it("are declared once each, in kebab-case", () => {
    expect(new Set(DECLARED).size).toBe(DECLARED.length);
    expect(DECLARED.filter((a) => !KEBAB.test(a))).toEqual([]);
  });

  it("are all used by some tour step", () => {
    expect(DECLARED.filter((a) => !STEP_ANCHORS.has(a))).toEqual([]);
  });

  it("each appear in page markup, written in exactly one place", async () => {
    const { sites } = await scanMarkup();
    const missing = [...STEP_ANCHORS].filter((a) => !sites.has(a));
    const repeated = [...sites].filter(([, where]) => where.length > 1);
    expect(missing).toEqual([]);
    expect(repeated).toEqual([]);
  });

  it("leave no attribute in the markup that no tour uses", async () => {
    const { sites } = await scanMarkup();
    expect([...sites.keys()].filter((a) => !STEP_ANCHORS.has(a))).toEqual([]);
  });

  it("are written as literals the scan can see", async () => {
    const { dynamic } = await scanMarkup();
    expect(dynamic).toEqual([]);
  });
});

describe("tours (the Batch 5 authoring rules)", () => {
  it("have unique ids and positive whole versions", () => {
    const ids = TOURS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const t of TOURS) expect(Number.isInteger(t.version) && t.version > 0, t.id).toBe(true);
  });

  it("have three to six steps, none repeating an anchor", () => {
    for (const t of TOURS) {
      expect(t.steps.length, t.route).toBeGreaterThanOrEqual(3);
      expect(t.steps.length, t.route).toBeLessThanOrEqual(6);
      expect(new Set(t.steps.map((s) => s.anchor)).size, t.route).toBe(t.steps.length);
    }
  });

  it("keep each step to two sentences, with no dollar figure", () => {
    for (const t of TOURS) {
      for (const s of t.steps) {
        const sentences = s.body.split(/(?<=[.!?])\s+/).filter(Boolean);
        expect(sentences.length, `${t.route} › ${s.title}`).toBeLessThanOrEqual(2);
        expect(`${s.title} ${s.body}`, t.route).not.toMatch(/\$\s?\d/);
      }
    }
  });
});
