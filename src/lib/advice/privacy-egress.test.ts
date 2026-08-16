// @vitest-environment node
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { buildNotification } from "@/lib/alerts/notify.ts";
import type { EvaluateAdviceResult } from "@/worker/jobs/evaluate-advice.ts";
import { describe, expect, it } from "vitest";

/**
 * P15-39 — MANDATORY privacy regression for the guidance surface
 * (ADR-032/033/034, CLAUDE.md §Privacy & Data Sovereignty).
 *
 * Phase 15 is the first phase whose stated egress budget is **exactly zero**.
 * Earlier phases could say "no NEW egress class" and point at an audited price
 * fetcher; the advice layer has no legitimate outbound call at all, because
 * every benchmark it applies — statutory limits, reserve multipliers, the
 * needs/wants split — is a constant checked into this repo (PLAN15 §Privacy).
 *
 * That absolute makes a stronger test possible than the denylists used in
 * Phases 11–14, and this file uses it: `src/lib/advice/` is audited against an
 * **allowlist** of module specifiers. A denylist fails open — it catches
 * `axios` because someone thought of `axios`, and misses next year's HTTP
 * client entirely. An allowlist fails closed: any import that is not already
 * known-local trips the test, and the person adding it has to justify it here.
 *
 * It also pins the two PII promises Phase 15 made to get household data at all:
 *
 *   1. **Household members are not searchable** (ADR-033 §7). `label` is a
 *      person's name — the most identifying string in the database — and the
 *      ⌘K palette is the one surface that exists to fan a substring across
 *      every table. It must not reach this one.
 *   2. **Guidance figures never ride the notification email** (ADR-015). An
 *      advice alert's `detail` carries a reserve gap and an APR; the email is a
 *      doorbell that carries a count.
 *
 * Static source audit, mirroring the Phase 11/12/13/14 egress tests (same
 * comment-stripping posture, so the JSDoc documenting these guarantees cannot
 * trip the scan that enforces them).
 */

/** This directory — `src/lib/advice`, the pure engine plus its two DB readers. */
const ADVICE_DIR = __dirname;
const RULES_DIR = join(__dirname, "rules");
const SRC = join(__dirname, "..", "..");
/** The delivery surface. */
const PLAN_DIR = join(SRC, "app", "plan");
/** The entry surface for the new PII — names and birth years. */
const HOUSEHOLD_DIR = join(SRC, "app", "settings", "household");
/** The nightly job that turns guidance into alerts. */
const JOB = join(SRC, "worker", "jobs", "evaluate-advice.ts");
/** Boundary validation for every new input. */
const SCHEMA = join(SRC, "lib", "schemas", "advice.ts");
/** The ⌘K palette: its route handler and the query module behind it. */
const SEARCH_ROUTE = join(SRC, "app", "api", "search", "route.ts");
const SEARCH_GLOBAL = join(SRC, "lib", "search", "global.ts");
/** The household schema, where the "no trigram index" comment has to survive. */
const HOUSEHOLD_SCHEMA = join(SRC, "db", "schema", "household.ts");

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

/** Non-test sources in a directory. */
function inDir(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => /\.tsx?$/.test(f) && !/\.(?:test|fixture)\.tsx?$/.test(f))
    .map((f) => join(dir, f));
}

/** The pure engine and its loaders — the zero-egress core. */
function adviceCorePaths(): readonly string[] {
  return [...inDir(ADVICE_DIR), ...inDir(RULES_DIR)];
}

/** Everything that touches guidance or household data, core included. */
function allGuidancePaths(): readonly string[] {
  return [
    ...adviceCorePaths(),
    ...inDir(PLAN_DIR),
    ...inDir(HOUSEHOLD_DIR),
    JOB,
    SCHEMA,
    join(SRC, "components", "dashboard", "advice-card.tsx"),
    join(SRC, "components", "guidance-disclaimer.tsx"),
  ];
}

/** Every module specifier a file imports, side-effect imports included. */
function importsOf(src: string): readonly string[] {
  const specifiers = [
    ...src.matchAll(/\bfrom\s*["']([^"']+)["']/g),
    ...src.matchAll(/^\s*import\s*["']([^"']+)["']/gm),
    ...src.matchAll(/\brequire\s*\(\s*["']([^"']+)["']\s*\)/g),
    ...src.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g),
  ];
  return specifiers.map((m) => m[1] as string);
}

describe("P15-39 — the advice engine imports nothing that could reach the network", () => {
  /**
   * The complete set of non-relative specifiers `src/lib/advice/` may import.
   *
   * Every entry is local by construction: Postgres access, in-repo pure math,
   * and the two type-only imports the alert mapper needs. There is no HTTP
   * client, no SDK, and no price fetcher — and no way to add one without
   * editing this list, which is the point.
   */
  const ALLOWED_SPECIFIERS: readonly string[] = [
    // Packages.
    "decimal.js", // the mandated money arithmetic (CLAUDE.md §Money)
    "drizzle-orm", // query builder; the driver is the app's existing pool
    "server-only", // a build-time guard, not a runtime dependency
    // In-repo modules.
    "@/db/client.ts",
    "@/db/schema/index.ts",
    "@/db/schema/accounts.ts",
    "@/db/schema/categories.ts",
    "@/lib/money/money.ts",
    "@/lib/analytics/spending.ts",
    "@/lib/analytics/forecast.ts",
    "@/lib/analytics/range.ts",
    "@/lib/mortgage/amortization.ts",
    "@/lib/alerts/rules.ts",
  ];

  it("audits a non-empty set of advice modules", () => {
    // Guards against the whole suite passing vacuously if a directory moves.
    const paths = adviceCorePaths();
    expect(paths.length).toBeGreaterThan(20);
    for (const expected of ["snapshot.ts", "engine.ts", "payoff.ts", "constants.ts", "plan.ts"]) {
      expect(
        paths.some((p) => p.endsWith(expected)),
        `missing ${expected}`,
      ).toBe(true);
    }
    // The rules themselves, which are what actually produce the numbers.
    expect(paths.filter((p) => p.includes("rules")).length).toBeGreaterThan(7);
  });

  it("imports only from the allowlist — anything new must be justified here", () => {
    for (const path of adviceCorePaths()) {
      for (const specifier of importsOf(code(path))) {
        if (specifier.startsWith(".")) continue; // within the advice layer
        expect(
          ALLOWED_SPECIFIERS,
          `${path} imports "${specifier}", which is not on the zero-egress allowlist`,
        ).toContain(specifier);
      }
    }
  });

  it("never calls fetch, and names no external host", () => {
    // Not "no fetch to an absolute URL" as in earlier phases — no fetch at all.
    // The advice layer has no legitimate outbound call, so zero is checkable.
    for (const path of adviceCorePaths()) {
      const src = code(path);
      expect(src, `${path} calls fetch()`).not.toMatch(/\bfetch\s*\(/);
      expect(src, `${path} constructs an HTTP request`).not.toMatch(
        /\bnew\s+(?:XMLHttpRequest|WebSocket|EventSource)\b|\bnavigator\.sendBeacon\b/,
      );
      expect(src, `${path} references an external host`).not.toMatch(
        /https?:\/\/(?!localhost|127\.0\.0\.1)/,
      );
    }
  });

  it("no guidance surface reaches the network either", () => {
    // The pages and the job are thinner, so a denylist suffices there — they
    // legitimately import React, Next, and the component library.
    const FORBIDDEN: readonly RegExp[] = [
      /\baxios\b/,
      /\bundici\b/,
      /node-fetch/,
      /\bgot\b/,
      /@\/lib\/prices\//,
      /@\/lib\/plaid\//,
      /yahoo-finance/i,
      /coingecko/i,
      // Any hosted model — the hard "guidance is deterministic or it does not
      // ship" boundary from the PLAN15 header, in executable form.
      /openai/i,
      /anthropic/i,
      /@google\/gener/i,
      /langchain/i,
      /\bollama\b/i,
      // Analytics/telemetry SaaS — banned app-wide.
      /posthog/i,
      /mixpanel/i,
      /amplitude/i,
      /segment/i,
      /@sentry\//i,
      /datadog/i,
      /google-analytics|gtag/i,
    ];
    for (const path of allGuidancePaths()) {
      const src = code(path);
      const importLines = importsOf(src).join("\n");
      for (const pattern of FORBIDDEN) {
        expect(importLines, `${path} imports forbidden ${pattern.source}`).not.toMatch(pattern);
      }
      expect(src, `${path} references an external host`).not.toMatch(
        /https?:\/\/(?!localhost|127\.0\.0\.1)/,
      );
      expect(src, `${path} embeds a remote <script>/<img> source`).not.toMatch(
        /<(?:script|img|iframe)[^>]+src=["'`]https?:/i,
      );
    }
  });
});

describe("P15-39 — no guidance figure reaches a logger", () => {
  /** Identifiers that are, or directly carry, a figure about this household. */
  const FIGURE_IDENTIFIERS: readonly RegExp[] = [
    /\bbalance\w*\b/i,
    /\bincome\b/i,
    /\bnetIncome\b/i,
    /\bessential\w*\b/i,
    /\breserve\w*\b/i,
    /\bapr\b/i,
    /\bapy\b/i,
    /\bsurplus\b/i,
    /\btarget\b/i,
    /\bsuggested\w*\b/i,
    /\bcurrentValue\b/i,
    /\bimpact\b/i,
    /\brecommendation\w*\b/i,
    /\bamount\b/i,
    /\btotal\b/i,
    /\bbirthYear\b/i,
    /\blabel\b/i,
  ];

  it("the guidance surface makes no logger calls at all", () => {
    // A recommendation is a sentence about someone's money — "pay down $9,400
    // at 24.99%" in a log file is the same leak as printing the balance, and it
    // lands somewhere `docker logs` and terminal scrollback can carry it. Zero
    // is the only rule simple enough to hold.
    for (const path of allGuidancePaths()) {
      const calls = code(path).match(/console\.\w+\s*\(/g) ?? [];
      expect(calls, `${path} logs from the guidance surface`).toEqual([]);
    }
  });

  it("would catch a figure being logged if a call were ever added", () => {
    // Belt-and-braces: if a logger call is ever introduced, this is the
    // assertion that has to be reckoned with rather than deleted wholesale.
    for (const path of allGuidancePaths()) {
      for (const call of code(path).match(/console\.\w+\([^)]*\)/g) ?? []) {
        for (const pattern of FIGURE_IDENTIFIERS) {
          expect(call, `${path} logs a guidance identifier: ${call}`).not.toMatch(pattern);
        }
      }
    }
  });

  it("what the run-once entry point prints for evaluate-advice is counts only", () => {
    // `run-once.ts` DOES log — it is a CLI and has to say what it did. The
    // guarantee is a property of the result type: money is a string end-to-end
    // in this codebase (CLAUDE.md §Money), so a result whose every field is a
    // `number` cannot carry a dollar figure. This stops typechecking the day
    // someone adds `reserveGap: string` to the job's result.
    const countsOnly: Record<keyof EvaluateAdviceResult, number> = {
      detected: 0,
      created: 0,
      notified: 0,
    };
    expect(Object.values(countsOnly).every((v) => typeof v === "number")).toBe(true);

    const runOnce = code(join(SRC, "worker", "run-once.ts"));
    const adviceLogs = runOnce.match(/console\.\w+\([^;]*?evaluate-advice[^;]*?\)/gs) ?? [];
    expect(adviceLogs.length).toBeGreaterThan(0);
    for (const call of adviceLogs) {
      expect(call).not.toMatch(/\.(?:impact|amount|balance|target|suggested)\b/);
    }
  });
});

describe("P15-39 — household members are not reachable from the ⌘K palette", () => {
  it("the search layer does not import the household schema", () => {
    // ADR-033 §7. A member `label` is a person's name; the palette exists to
    // fan a substring across every table, and this is the table it must miss.
    for (const path of [SEARCH_GLOBAL, SEARCH_ROUTE]) {
      const src = code(path);
      expect(src, `${path} imports the household schema`).not.toMatch(/schema\/household/);
      expect(src, `${path} references household tables`).not.toMatch(
        /\bhouseholdMembers\b|\bhouseholdProfile\b|household_members/,
      );
    }
  });

  it("the palette searches a fixed, audited set of tables", () => {
    // Asserted positively as well: if a future phase adds a table to the
    // palette, it is this list that changes, and the diff is the review moment.
    const src = code(SEARCH_GLOBAL);
    const searched = [...src.matchAll(/\.from\(\s*(\w+)\s*\)/g)].map((m) => m[1]);
    expect(new Set(searched)).toEqual(
      new Set(["accounts", "categories", "securities", "watchlistItems", "transactions"]),
    );
  });

  it("the household schema still carries no trigram index", () => {
    // The index is what would make the name searchable, so its absence is the
    // structural half of the guarantee — the import checks above are the other.
    const src = code(HOUSEHOLD_SCHEMA);
    expect(src).not.toMatch(/gin|gin_trgm_ops|trigram/i);
  });
});

describe("P15-39 — advice alert detail never rides the notification email", () => {
  it("the notification body carries a count and a link, and no guidance figure", () => {
    const { subject, text } = buildNotification(3, "2026-08-15", "http://localhost:4000");
    const body = `${subject}\n${text}`;

    expect(body).toContain("3 new alerts");
    expect(body).toContain("/alerts");
    // Nothing from an advice `detail` payload — not the rule, not the figures.
    for (const leak of [
      "emergency_fund",
      "Guidance",
      "reserve",
      "APR",
      "$",
      "/plan",
      "recommendation",
    ]) {
      expect(body, `notification body leaked "${leak}"`).not.toContain(leak);
    }
    // The only digits are the count and the date.
    expect(body.replace(/3 new alerts|3|2026-08-15|4000/g, "")).not.toMatch(/\d/);
  });

  it("the mailer is handed a count and a date — never an alert row", () => {
    // The job's seam: `notifyNewAlerts(count, date)` has no parameter that
    // could carry a `detail`, so the guarantee holds by signature, not by care.
    const job = code(JOB);
    const notifyCalls = job.match(/notify(?:NewAlerts)?\([^)]*\)/g) ?? [];
    expect(notifyCalls.length).toBeGreaterThan(0);
    for (const call of notifyCalls) {
      expect(call, `job passes an alert payload to the mailer: ${call}`).not.toMatch(
        /\bdetail\b|\balert\b|\brow\b|\btitle\b/i,
      );
    }
  });
});
