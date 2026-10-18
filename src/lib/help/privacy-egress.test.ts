// @vitest-environment node
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * P20-31 — MANDATORY privacy regression for in-app help (PLAN20 Hard
 * boundaries #1 and #2, ADR-060, CLAUDE.md §Privacy & Data Sovereignty).
 *
 * Help is static text bundled with the app. It never reads the database, never
 * makes a request, and the only state it keeps is a per-device mark in
 * `localStorage` saying which tours were taken and whether the getting-started
 * checklist was put away. That is what makes "help states no figure of yours"
 * true by construction rather than by review, so this suite pins it:
 *
 *   1. nothing help runs (the runtime import closure of `src/lib/help/` and
 *      `src/components/help/`) imports `@/db`, a package outside a short
 *      allowlist, or a network API;
 *   2. no help component writes HTML: no `dangerouslySetInnerHTML`, no
 *      `innerHTML`, no `eval`;
 *   3. storage is touched in one module, every key starts `my-money:help:`, and
 *      the only values written are the marks `seen`, `dismissed` and `done`;
 *   4. the help copy itself interpolates nothing.
 *
 * Like the sinking-fund suite, this resolves specifiers and walks the closure,
 * because a direct-import allowlist would pass while something two hops away
 * grew a `fetch`. Type-only imports are erased at build, so the walk skips them;
 * check 1 still forbids even a type import from `@/db` in the help directories.
 */

const SRC = resolve(__dirname, "..", "..");
const LIB_HELP = __dirname;
const COMPONENT_HELP = join(SRC, "components", "help");

/** Packages help may load at runtime. Anything else needs a reason here. */
const ALLOWED_PACKAGES: ReadonlySet<string> = new Set([
  "next/link",
  "next/navigation",
  "react",
  "react-dom",
]);

/**
 * Read a source file with block and line comments stripped, so the scan covers
 * code only, not the comments that name the very things this suite forbids.
 */
function code(path: string): string {
  return readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

/** Every non-test `.ts`/`.tsx` file under a directory, recursively. */
function sourcesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sourcesUnder(path));
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(path);
  }
  return out;
}

/** The help directories' own files: the roots of the walk. */
const HELP_FILES: readonly string[] = [...sourcesUnder(LIB_HELP), ...sourcesUnder(COMPONENT_HELP)];

/** One import found in a file. */
interface Specifier {
  readonly spec: string;
  readonly typeOnly: boolean;
}

/** Every static, re-export, side-effect and dynamic import in a source file. */
function specifiers(src: string): Specifier[] {
  const found: Specifier[] = [];
  for (const m of src.matchAll(
    /\b(?:import|export)\s+(type\s+)?[^"';]*?\sfrom\s+["']([^"']+)["']/g,
  )) {
    found.push({ spec: m[2] as string, typeOnly: m[1] !== undefined });
  }
  for (const m of src.matchAll(/\bimport\s+["']([^"']+)["']/g)) {
    found.push({ spec: m[1] as string, typeOnly: false });
  }
  for (const m of src.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)) {
    found.push({ spec: m[1] as string, typeOnly: false });
  }
  return found;
}

/** A project specifier as a file path, or `null` for a package. */
function resolveLocal(spec: string, from: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = join(SRC, spec.slice(2));
  else if (spec.startsWith(".")) base = resolve(dirname(from), spec);
  else return null;
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts")]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  throw new Error(`cannot resolve ${spec} from ${relative(SRC, from)}`);
}

/** The runtime closure: every project file and package help can load. */
function runtimeClosure(): { files: Set<string>; packages: Map<string, string> } {
  const files = new Set<string>();
  const packages = new Map<string, string>();
  const queue = [...HELP_FILES];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (files.has(file)) continue;
    files.add(file);
    for (const { spec, typeOnly } of specifiers(code(file))) {
      if (typeOnly) continue;
      const local = resolveLocal(spec, file);
      if (local === null) packages.set(spec, relative(SRC, file));
      else queue.push(local);
    }
  }
  return { files, packages };
}

const CLOSURE = runtimeClosure();

describe("P20-31 — help reads nothing and sends nothing", () => {
  it("walks a non-empty closure that reaches the content and the tour", () => {
    // Guards against the suite passing vacuously if the directories move.
    const names = [...CLOSURE.files].map((f) => relative(SRC, f).replaceAll("\\", "/"));
    expect(names.length).toBeGreaterThan(25);
    expect(names).toContain("lib/help/content/planning.ts");
    expect(names).toContain("components/help/tour.tsx");
    expect(names).toContain("lib/help/local-store.ts");
  });

  it("no help file imports @/db, not even a type", () => {
    for (const file of HELP_FILES) {
      for (const { spec } of specifiers(code(file))) {
        expect(spec, `${relative(SRC, file)} imports ${spec}`).not.toMatch(/^@\/db(\/|$)/);
      }
    }
  });

  it("nothing help runs reaches the database layer", () => {
    for (const file of CLOSURE.files) {
      const rel = relative(SRC, file).replaceAll("\\", "/");
      expect(rel, "help's runtime closure reaches the database").not.toMatch(/^db\//);
      expect(code(file), `${rel} reads the database`).not.toMatch(
        /["'](?:drizzle-orm|postgres|pg|server-only)["']/,
      );
    }
  });

  it("loads only allowlisted packages", () => {
    for (const [pkg, from] of CLOSURE.packages) {
      expect(ALLOWED_PACKAGES.has(pkg), `${from} loads package ${pkg}`).toBe(true);
    }
  });

  it("makes no request of any kind and names no external host", () => {
    const NETWORK: readonly RegExp[] = [
      /\bfetch\s*\(/,
      /\bXMLHttpRequest\b/,
      /\bsendBeacon\b/,
      /\bWebSocket\b/,
      /\bEventSource\b/,
      /\bnew\s+Image\s*\(/,
      /["'](?:node:)?https?["']/,
      /\b(?:axios|undici|node-fetch)\b/,
      /https?:\/\/(?!localhost|127\.0\.0\.1)/,
    ];
    for (const file of CLOSURE.files) {
      const src = code(file);
      for (const pattern of NETWORK) {
        expect(src, `${relative(SRC, file)} matches ${pattern.source}`).not.toMatch(pattern);
      }
    }
  });
});

describe("P20-31 — help never writes HTML", () => {
  it("has no dangerouslySetInnerHTML, innerHTML or eval anywhere it runs", () => {
    const SINKS: readonly RegExp[] = [
      /dangerouslySetInnerHTML/,
      /\.(?:inner|outer)HTML\b/,
      /\binsertAdjacentHTML\b/,
      /\bdocument\.write\b/,
      /\beval\s*\(/,
      /\bnew\s+Function\s*\(/,
      /\bcreateContextualFragment\b/,
    ];
    for (const file of CLOSURE.files) {
      const src = code(file);
      for (const pattern of SINKS) {
        expect(src, `${relative(SRC, file)} matches ${pattern.source}`).not.toMatch(pattern);
      }
    }
  });

  it("help copy interpolates nothing", () => {
    // The entries and glossary are literal text. A `${…}` there could carry a
    // runtime value into the copy, which Hard boundary #1 forbids.
    const copy = [join(LIB_HELP, "glossary.ts"), ...sourcesUnder(join(LIB_HELP, "content"))];
    for (const file of copy) {
      expect(code(file), `${relative(SRC, file)} interpolates`).not.toContain("${");
    }
  });
});

describe("P20-31 — the only state is a per-device mark", () => {
  it("touches browser storage in one module, and nothing else on the device", () => {
    for (const file of CLOSURE.files) {
      const rel = relative(SRC, file).replaceAll("\\", "/");
      const src = code(file);
      expect(src, `${rel} uses sessionStorage, IndexedDB or cookies`).not.toMatch(
        /\b(?:sessionStorage|indexedDB|document\.cookie|caches)\b/,
      );
      if (rel !== "lib/help/local-store.ts") {
        expect(src, `${rel} touches localStorage directly`).not.toMatch(/\blocalStorage\b/);
      }
    }
  });

  it("writes marks only from the tour and checklist state modules", () => {
    const writers = [...CLOSURE.files]
      .filter((f) => /\bwriteMark\s*\(/.test(code(f)))
      .map((f) => relative(SRC, f).replaceAll("\\", "/"))
      .sort();
    expect(writers).toEqual([
      "lib/help/checklist-state.ts",
      "lib/help/local-store.ts",
      "lib/help/tour-state.ts",
    ]);
  });

  it("names every key under my-money:help:", () => {
    for (const file of CLOSURE.files) {
      for (const m of code(file).matchAll(/["'`](my-money:[^"'`$]*)/g)) {
        expect(m[1], relative(SRC, file)).toMatch(/^my-money:help:/);
      }
    }
  });

  describe("what a device actually stores", () => {
    const stored = new Map<string, string>();

    beforeEach(() => {
      stored.clear();
      vi.resetModules();
      vi.stubGlobal("localStorage", {
        getItem: (k: string) => stored.get(k) ?? null,
        setItem: (k: string, v: string) => void stored.set(k, String(v)),
        removeItem: (k: string) => void stored.delete(k),
        clear: () => stored.clear(),
        key: () => null,
        length: 0,
      } satisfies Storage);
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("holds tour ids, versions and a mark, and nothing else", async () => {
      const { markSeen, markDismissed } = await import("./tour-state.ts");
      const { closeChecklist } = await import("./checklist-state.ts");
      const { HELP_ENTRIES } = await import("./registry.ts");

      const tours = HELP_ENTRIES.flatMap((e) => (e.tour === undefined ? [] : [e.tour]));
      expect(tours.length).toBeGreaterThan(10);
      for (const [i, tour] of tours.entries()) {
        if (i % 2 === 0) markSeen(tour);
        else markDismissed(tour);
      }
      closeChecklist("dismissed");
      closeChecklist("done");

      expect(stored.size).toBe(tours.length + 1);
      for (const [key, value] of stored) {
        expect(key).toMatch(/^my-money:help:(?:tour:[a-z0-9-]+:v\d+|checklist)$/);
        expect(["seen", "dismissed", "done"]).toContain(value);
      }
    });
  });
});
