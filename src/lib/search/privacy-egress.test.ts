// @vitest-environment node
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * P12-20 — MANDATORY privacy regression for the search surface
 * (ADR-027 / ADR-028, CLAUDE.md §Privacy & Data Sovereignty).
 *
 * Search is a **local-only read path**: unlike the price pipeline it touches
 * **only local Postgres** — no ticker, payee, balance, or query string ever
 * leaves the box. This test pins that architectural guarantee with a static
 * source audit (no DB, no network of its own) so it fails loudly the moment:
 *
 *   1. any module under `src/lib/search/` — or the `GET /api/search` route
 *      handler that fronts it — gains an egress dependency (an HTTP client like
 *      `axios`/`undici`/`node-fetch`, or one of the market-data fetchers under
 *      `@/lib/prices/`), or makes an outbound `fetch` to an external host; or
 *   2. the palette route handler ever passes the query term `q` to a logger —
 *      a payee/ticker fragment is financial data, and CLAUDE.md §Privacy is
 *      explicit that financial data is never logged.
 *
 * Mirrors the Phase 11 watchlist privacy-egress audit (same comment-stripping
 * static-scan posture).
 */

/** This directory — `src/lib/search`. The audited search modules live here. */
const SEARCH_DIR = __dirname;

/** The palette's internal route handler: `src/app/api/search/route.ts`. */
const ROUTE = join(__dirname, "..", "..", "app", "api", "search", "route.ts");

/**
 * Read a source file with block + line comments stripped, so the scan covers
 * executable code only — not the JSDoc that legitimately documents the very
 * guarantees (and names the very identifiers) this test forbids.
 */
function code(path: string): string {
  return readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

/** Every non-test `.ts` module under `src/lib/search`, plus the route handler. */
function searchModulePaths(): readonly string[] {
  const modules = readdirSync(SEARCH_DIR)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .map((f) => join(SEARCH_DIR, f));
  return [...modules, ROUTE];
}

describe("P12-20 — the search path is local-only (zero egress)", () => {
  /** HTTP clients + market-data fetchers that must never reach a search module. */
  const FORBIDDEN_IMPORTS: readonly RegExp[] = [
    /\baxios\b/,
    /\bundici\b/,
    /node-fetch/,
    /\bgot\b/,
    /@\/lib\/prices\//, // the Yahoo/CoinGecko fetchers — egress lives there, not here
    /yahoo-finance/i,
    /coingecko/i,
  ];

  it("no search module imports an HTTP client or a price fetcher", () => {
    for (const path of searchModulePaths()) {
      // Inspect import/require statements only — a bare identifier elsewhere is
      // harmless; an *import* is the thing that introduces an egress dependency.
      const importLines = code(path)
        .split("\n")
        .filter((line) => /\b(?:import|require)\b/.test(line))
        .join("\n");
      for (const pattern of FORBIDDEN_IMPORTS) {
        expect(importLines, `${path} imports forbidden ${pattern.source}`).not.toMatch(pattern);
      }
    }
  });

  it("no search module makes an outbound HTTP request", () => {
    for (const path of searchModulePaths()) {
      const src = code(path);
      expect(src, `${path} calls fetch() against an absolute URL`).not.toMatch(
        /fetch\s*\(\s*[`'"]https?:\/\//,
      );
      // No external host literal at all (local app-relative hrefs like
      // `/accounts/${id}` carry no scheme, so they never match).
      expect(src, `${path} references an external host`).not.toMatch(
        /https?:\/\/(?!localhost|127\.0\.0\.1)/,
      );
    }
  });
});

describe("P12-20 — the palette route never logs the query term", () => {
  it("passes `q` only to the sanitizing search helper, never to a logger", () => {
    const src = code(ROUTE);

    // It must actually read `q` (otherwise the assertions below are vacuous)…
    expect(src).toMatch(/searchParams\.get\(["']q["']\)/);
    // …and forward it to globalSearch, which sanitizes + runs DB-only queries.
    expect(src).toMatch(/globalSearch\(/);

    // No logger call may reference the `q` identifier (covers `${q}`, `, q`, etc.).
    const loggerCalls = src.match(/console\.\w+\([^)]*\)/g) ?? [];
    for (const call of loggerCalls) {
      expect(call, `route logs the query term: ${call}`).not.toMatch(/\bq\b/);
    }
  });
});
