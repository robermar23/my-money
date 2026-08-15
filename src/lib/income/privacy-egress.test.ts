// @vitest-environment node
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { MaterializeContributionsResult } from "@/worker/jobs/materialize-contributions.ts";
import { describe, expect, it } from "vitest";

/**
 * P14-20 — MANDATORY privacy regression for the income surface
 * (ADR-030/031, CLAUDE.md §Privacy & Data Sovereignty).
 *
 * Gross pay is the **most sensitive data class the app has ever stored**. A
 * balance says what you have; a paycheck says what you earn, and it is the one
 * figure a person is least willing to see leave their machine. Phase 14 adds it
 * on the explicit promise that it stays in local Postgres, so that promise gets
 * a test that fails loudly the moment:
 *
 *   1. any income module, the two contribution jobs, or the `/settings/income`
 *      surface gains an egress dependency — an HTTP client, an analytics SDK, a
 *      market-data fetcher, or the Plaid client;
 *   2. any of them makes an outbound request or names an external host;
 *   3. any of them hands a figure to a logger — gross, contribution, and match
 *      amounts are financial data, which CLAUDE.md says is never logged; or
 *   4. the **injection seam breaks**: the income library must never reach for a
 *      price fetcher itself. `planContributions` takes a `PriceLookup`, and the
 *      job supplies one that reads the local `prices` table. That is what makes
 *      "no new egress class" (PLAN14 header) structurally true rather than a
 *      claim — the only outbound call anywhere near a contribution is the
 *      pre-existing nightly price fetch, which sends a ticker and never a dollar.
 *
 * Static source audit, mirroring the Phase 11 watchlist, Phase 12 search, and
 * Phase 13 dashboard egress tests (same comment-stripping posture, so the JSDoc
 * that documents these guarantees cannot trip the scan that enforces them).
 */

/** This directory — `src/lib/income`. */
const LIB_DIR = __dirname;
const SRC = join(__dirname, "..", "..");
/** The management surface where a gross figure is entered and displayed. */
const SETTINGS_DIR = join(SRC, "app", "settings", "income");
/** The two jobs that read a paycheck and write contributions. */
const JOBS: readonly string[] = [
  join(SRC, "worker", "jobs", "materialize-contributions.ts"),
  join(SRC, "worker", "jobs", "backfill-contributions.ts"),
];
/** The boundary validation for both. */
const SCHEMA = join(SRC, "lib", "schemas", "income.ts");

/**
 * Read a source file with block + line comments stripped, so the scan covers
 * executable code only — not the JSDoc that legitimately names the identifiers
 * this test forbids.
 */
function code(path: string): string {
  return readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

/** Non-test sources in a directory. */
function inDir(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f))
    .map((f) => join(dir, f));
}

/** Every non-test source file that touches income data. */
function incomeModulePaths(): readonly string[] {
  return [...inDir(LIB_DIR), ...inDir(SETTINGS_DIR), ...JOBS, SCHEMA];
}

describe("P14-20 — the income surface is local-only (no new egress class)", () => {
  /** Clients + SDKs that must never appear anywhere near a paycheck. */
  const FORBIDDEN_IMPORTS: readonly RegExp[] = [
    /\baxios\b/,
    /\bundici\b/,
    /node-fetch/,
    /\bgot\b/,
    /@\/lib\/prices\/(?!store)/, // the fetchers; `store.ts` is a local table read
    /@\/lib\/plaid\//, // Plaid never sees income — the user defines it, we don't pull it
    /yahoo-finance/i,
    /coingecko/i,
    /\bplaid\b/,
    // No external payroll provider, ever (PLAN14 §Hard boundary).
    /\badp\b/i,
    /\bgusto\b/i,
    /finicity/i,
    // Analytics/telemetry SaaS — banned app-wide.
    /posthog/i,
    /mixpanel/i,
    /amplitude/i,
    /segment/i,
    /@sentry\//i,
    /datadog/i,
    /google-analytics|gtag/i,
  ];

  it("audits a non-empty set of income modules", () => {
    // Guards against the whole suite silently passing if a directory moves.
    const paths = incomeModulePaths();
    expect(paths.length).toBeGreaterThan(10);
    for (const expected of ["materialize.ts", "savings-rate.ts", "queries.ts", "actions.ts"]) {
      expect(
        paths.some((p) => p.endsWith(expected)),
        `missing ${expected}`,
      ).toBe(true);
    }
    expect(paths.some((p) => p.endsWith("materialize-contributions.ts"))).toBe(true);
    expect(paths.some((p) => p.endsWith("backfill-contributions.ts"))).toBe(true);
  });

  it("no income module imports an HTTP client, market-data fetcher, or analytics SDK", () => {
    for (const path of incomeModulePaths()) {
      const importLines = code(path)
        .split("\n")
        .filter((line) => /\b(?:import|require)\b/.test(line))
        .join("\n");
      for (const pattern of FORBIDDEN_IMPORTS) {
        expect(importLines, `${path} imports forbidden ${pattern.source}`).not.toMatch(pattern);
      }
    }
  });

  it("no income module makes an outbound request or names an external host", () => {
    for (const path of incomeModulePaths()) {
      const src = code(path);
      expect(src, `${path} calls fetch()`).not.toMatch(/\bfetch\s*\(/);
      // App-relative hrefs (`/settings/income`, `/accounts/${id}`) carry no
      // scheme, so the deep links these pages DO have never match.
      expect(src, `${path} references an external host`).not.toMatch(
        /https?:\/\/(?!localhost|127\.0\.0\.1)/,
      );
      expect(src, `${path} embeds a remote <script>/<img> source`).not.toMatch(
        /<(?:script|img|iframe)[^>]+src=["'`]https?:/i,
      );
    }
  });
});

describe("P14-20 — prices reach the planner by injection, never by import", () => {
  it("no module under src/lib/income/ imports the price layer at all", () => {
    // The seam that makes the no-new-egress claim structural: the pure library
    // takes a `PriceLookup` and cannot fetch even if someone wanted it to.
    for (const path of inDir(LIB_DIR)) {
      expect(code(path), `${path} imports the price layer`).not.toMatch(/@\/lib\/prices\//);
    }
  });

  it("the job's only price dependency is the local `prices` table reader", () => {
    // `latestCloseOnOrBefore` is a SELECT against Postgres. The nightly
    // `fetch-prices-daily` is what talks to Yahoo/CoinGecko, and it is a
    // different job with its own already-audited egress.
    const job = code(JOBS[0] as string);
    const priceImports = job.match(/@\/lib\/prices\/[\w-]+/g) ?? [];
    expect(priceImports).toEqual(["@/lib/prices/store"]);
    expect(job).toMatch(/latestCloseOnOrBefore/);
  });
});

describe("P14-20 — no income figure reaches a logger", () => {
  /** Identifiers that are (or directly carry) income on this surface. */
  const INCOME_IDENTIFIERS: readonly RegExp[] = [
    /\bgross\b/i,
    /\bsalary\b/i,
    /\bpay(?:check)?\b/i,
    /\bemployee\w*\b/i,
    /\bemployer\w*\b/i,
    /\bmatch\w*\b/i,
    /\bcontribution\w*\b/i,
    /\bamount\b/i,
    /\btotal\b/i,
    /\brate\b/i,
    /\bbasis\b/i,
  ];

  it("the surface makes no logger calls at all", () => {
    // A gross-pay figure in a log file is a leak into a place backups, terminal
    // scrollback, and `docker logs` can carry it. Zero is the only rule simple
    // enough to hold — nothing here is safe to print.
    for (const path of incomeModulePaths()) {
      const calls = code(path).match(/console\.\w+\s*\(/g) ?? [];
      expect(calls, `${path} logs from the income surface`).toEqual([]);
    }
  });

  it("would catch a figure being logged if one were ever added", () => {
    // Belt-and-braces: if a logger call is ever introduced, this is the
    // assertion that has to be reckoned with rather than deleted wholesale.
    for (const path of incomeModulePaths()) {
      const loggerCalls = code(path).match(/console\.\w+\([^)]*\)/g) ?? [];
      for (const call of loggerCalls) {
        for (const pattern of INCOME_IDENTIFIERS) {
          expect(call, `${path} logs an income identifier: ${call}`).not.toMatch(pattern);
        }
      }
    }
  });

  it("what the run-once entry point prints is counts, and only counts", () => {
    // `run-once.ts` DOES log — it is a CLI and has to say what it did. It prints
    // the job's result object, so the guarantee is a property of that type:
    // money is a string end-to-end in this codebase (CLAUDE.md §Money), so a
    // result whose every field is a `number` cannot carry a dollar figure. This
    // stops typechecking the day someone adds `totalContributed: string`.
    const countsOnly: Record<keyof MaterializeContributionsResult, number> = {
      rules: 0,
      created: 0,
      priceable: 0,
      basisOnly: 0,
    };
    expect(Object.values(countsOnly).every((v) => typeof v === "number")).toBe(true);

    const runOnce = code(join(SRC, "worker", "run-once.ts"));
    const contributionLogs =
      runOnce.match(/console\.\w+\([^;]*?(?:materialize|backfill)-contributions[^;]*?\)/gs) ?? [];
    expect(contributionLogs.length).toBeGreaterThan(0);
    for (const call of contributionLogs) {
      // The processors' return values, nothing destructured out of them.
      expect(call).not.toMatch(/\.(?:gross|employee|employer|amount|total)\b/);
    }
  });
});
