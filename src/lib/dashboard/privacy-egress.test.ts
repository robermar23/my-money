// @vitest-environment node
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * P13-18 — MANDATORY privacy regression for the dashboard surface
 * (ADR-029, CLAUDE.md §Privacy & Data Sovereignty).
 *
 * The dashboard is the densest financial view in the app: net worth, allocation,
 * return %, spend, forward income, and pretend P&L all land on one page. That
 * makes it the single highest-value target for an accidental leak, and it is
 * also the page most likely to attract a "just add analytics / just log the slow
 * card" change later. So the guarantee is pinned by a static source audit (no DB,
 * no network of its own), which fails loudly the moment:
 *
 *   1. any module under `src/lib/dashboard/` or `src/components/dashboard/`, or
 *      the dashboard page itself, gains an egress dependency — an HTTP client
 *      (`axios`/`undici`/`node-fetch`/`got`), an analytics/telemetry SDK, or one
 *      of the market-data / Plaid clients under `@/lib/prices/` + `@/lib/plaid/`;
 *   2. any of them makes an outbound request or names an external host;
 *   3. any of them hands a financial figure to a logger — every field the loader
 *      composes is financial data, and CLAUDE.md is explicit that it is never
 *      logged; or
 *   4. the loader loses its `server-only` guard, which is what keeps the composed
 *      figures out of a client bundle in the first place.
 *
 * The dashboard *composes* existing library functions and never fetches anything
 * itself (ADR-029 §2), so "zero egress" here is an architectural property, not a
 * coincidence — this test is what keeps it one. Mirrors the Phase 11 watchlist
 * and Phase 12 search egress audits (same comment-stripping static-scan posture).
 */

/** This directory — `src/lib/dashboard`. */
const LIB_DIR = __dirname;
/** The dumb card components — `src/components/dashboard`. */
const COMPONENT_DIR = join(__dirname, "..", "..", "components", "dashboard");
/** The page that assembles them — `src/app/page.tsx`. */
const PAGE = join(__dirname, "..", "..", "app", "page.tsx");

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

/** Every non-test source file on the dashboard surface. */
function dashboardModulePaths(): readonly string[] {
  const inDir = (dir: string): string[] =>
    readdirSync(dir)
      .filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f))
      .map((f) => join(dir, f));
  return [...inDir(LIB_DIR), ...inDir(COMPONENT_DIR), PAGE];
}

describe("P13-18 — the dashboard is local-only (zero egress)", () => {
  /** Clients + SDKs that must never appear on the dashboard surface. */
  const FORBIDDEN_IMPORTS: readonly RegExp[] = [
    /\baxios\b/,
    /\bundici\b/,
    /node-fetch/,
    /\bgot\b/,
    /@\/lib\/prices\//, // Yahoo/CoinGecko fetchers — egress lives there, not here
    /@\/lib\/plaid\//, // the Plaid client + tokens: never on a render path
    /yahoo-finance/i,
    /coingecko/i,
    /\bplaid\b/,
    // Analytics/telemetry SaaS — banned app-wide, doubly so on the money page.
    /posthog/i,
    /mixpanel/i,
    /amplitude/i,
    /segment/i,
    /@sentry\//i,
    /datadog/i,
    /google-analytics|gtag/i,
  ];

  it("audits a non-empty set of dashboard modules", () => {
    // Guards against the whole suite silently passing if the directories move.
    const paths = dashboardModulePaths();
    expect(paths.length).toBeGreaterThan(10);
    expect(paths.some((p) => p.endsWith("loader.ts"))).toBe(true);
    expect(paths.some((p) => p.endsWith("page.tsx"))).toBe(true);
  });

  it("no dashboard module imports an HTTP client, price/Plaid fetcher, or analytics SDK", () => {
    for (const path of dashboardModulePaths()) {
      // Inspect import/require statements only — a bare identifier elsewhere is
      // harmless; an *import* is what introduces the dependency.
      const importLines = code(path)
        .split("\n")
        .filter((line) => /\b(?:import|require)\b/.test(line))
        .join("\n");
      for (const pattern of FORBIDDEN_IMPORTS) {
        expect(importLines, `${path} imports forbidden ${pattern.source}`).not.toMatch(pattern);
      }
    }
  });

  it("no dashboard module makes an outbound request or names an external host", () => {
    for (const path of dashboardModulePaths()) {
      const src = code(path);
      expect(src, `${path} calls fetch() against an absolute URL`).not.toMatch(
        /fetch\s*\(\s*[`'"]https?:\/\//,
      );
      // App-relative hrefs (`/investments`, `/accounts/${id}`) carry no scheme,
      // so the deep links the cards DO have never match this.
      expect(src, `${path} references an external host`).not.toMatch(
        /https?:\/\/(?!localhost|127\.0\.0\.1)/,
      );
      expect(src, `${path} embeds a remote <script>/<img> source`).not.toMatch(
        /<(?:script|img|iframe)[^>]+src=["'`]https?:/i,
      );
    }
  });
});

describe("P13-18 — no dashboard figure reaches a logger", () => {
  /** Identifiers that are (or directly carry) money on the dashboard surface. */
  const FINANCIAL_IDENTIFIERS: readonly RegExp[] = [
    /\bbalance\b/i,
    /\bnetWorth\b/i,
    /\btotal\b/i,
    /\bamount\b/i,
    /\bvalue\b/i,
    /\bspend\b/i,
    /\bbudget\b/i,
    /\btwr\b/i,
    /\bgain\b/i,
    /\bforward12mo\b/i,
    /\byieldOnCost\b/i,
    /\bdelta\b/i,
    /\bsymbol\b/i,
  ];

  it("the surface makes no logger calls at all", () => {
    // The dashboard renders; it has nothing to say to stdout. Keeping the count
    // at zero is both the simplest rule and the safest one — every figure that
    // passes through here is financial, so there is no "safe" thing to log.
    for (const path of dashboardModulePaths()) {
      const calls = code(path).match(/console\.\w+\s*\(/g) ?? [];
      expect(calls, `${path} logs from the dashboard surface`).toEqual([]);
    }
  });

  it("would catch a figure being logged if one were ever added", () => {
    // Belt-and-braces: if a logger call is ever introduced, this is the assertion
    // that has to be reckoned with rather than deleted wholesale above.
    for (const path of dashboardModulePaths()) {
      const src = code(path);
      const loggerCalls = src.match(/console\.\w+\([^)]*\)/g) ?? [];
      for (const call of loggerCalls) {
        for (const pattern of FINANCIAL_IDENTIFIERS) {
          expect(call, `${path} logs a financial identifier: ${call}`).not.toMatch(pattern);
        }
      }
    }
  });
});

describe("P13-18 — the loader stays server-only", () => {
  it("imports `server-only`, so composed figures cannot enter a client bundle", () => {
    // The loader holds every figure at once. `server-only` is a build-time
    // tripwire: importing it from a client component fails `next build` rather
    // than shipping the numbers to the browser.
    expect(readFileSync(join(LIB_DIR, "loader.ts"), "utf8")).toMatch(
      /^import ["']server-only["'];/m,
    );
  });

  it("keeps the client island free of loader data (it takes only the range)", () => {
    // `range-toggle.tsx` is the sole 'use client' file in the card set. It must
    // stay a navigation control — a client component that accepted card data
    // would serialize those figures into the RSC payload.
    const toggle = readFileSync(join(COMPONENT_DIR, "range-toggle.tsx"), "utf8");
    expect(toggle).toMatch(/["']use client["']/);
    expect(code(join(COMPONENT_DIR, "range-toggle.tsx"))).not.toMatch(/@\/lib\/dashboard\/loader/);
  });
});
