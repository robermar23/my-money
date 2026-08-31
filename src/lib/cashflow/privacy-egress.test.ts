// @vitest-environment node
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { buildNotification } from "@/lib/alerts/notify.ts";
import { CASHFLOW_ALERT_TYPES } from "@/lib/alerts/rules.ts";
import { payeeKey } from "@/lib/cashflow/payee-key.ts";
import type { DetectObligationsWeeklyResult } from "@/worker/jobs/detect-obligations-weekly.ts";
import type { ProjectCashFlowDailyResult } from "@/worker/jobs/project-cashflow-daily.ts";
import { describe, expect, it } from "vitest";
import {
  type AmountChangeInput,
  type MissedOccurrenceInput,
  type ShortfallInput,
  obligationAmountChangedAlerts,
  obligationMissedAlerts,
  projectedShortfallAlerts,
} from "./alerts.ts";

/**
 * P16-36 — MANDATORY privacy regression for the cash-flow surface
 * (PLAN16 §Privacy, ADR-015/036/038, CLAUDE.md §Privacy & Data Sovereignty).
 *
 * Phase 16's stated egress budget is the same absolute Phase 15 set: **zero**.
 * Nothing in `src/lib/cashflow/` makes an outbound request on any code path,
 * and unlike a price fetcher there is no legitimate one to make. Everything the
 * detector needs — the payee text, the dates, the amounts — is already in this
 * household's Postgres, and every tolerance it applies is a constant checked
 * into this repo.
 *
 * That absolute is what makes an **allowlist** possible, and this file uses one
 * for the same reason [advice/privacy-egress.test.ts](../advice/privacy-egress.test.ts)
 * does: a denylist fails open — it catches `axios` because somebody thought of
 * `axios`, and misses next year's HTTP client — while an allowlist fails closed.
 * Any import that is not already known-local trips the test, and whoever adds it
 * has to justify it here, in the diff, where it gets read.
 *
 * Phase 16 also carries a temptation Phase 15 did not, and the plan names it
 * (PLAN16 §Explicitly rejected): a hosted **biller / merchant-enrichment API**
 * would identify recurring vendors far better than local string work. It would
 * also ship this household's complete payee list — landlord, therapist, the
 * people they Venmo — to a third party. There is a test below asserting the
 * detector recognizes no brand at all, so the day someone adds a vocabulary the
 * failure is loud rather than a quiet quality improvement.
 *
 * Three further promises get pinned here:
 *
 *   1. **No balance, projection figure, safe-to-spend value, or obligation
 *      amount reaches a logger.** These land in `docker logs` and terminal
 *      scrollback, which is the same leak as printing the balance.
 *   2. **The three new alert types' `detail` never rides the notification
 *      email** (ADR-015). A shortfall alert may say one exists; it may never
 *      carry the number. Their `title` is checked too — Phase 16 is the first
 *      phase whose titles embed a *user-authored label*, which names a real
 *      vendor and in the P2P cases a real person.
 *   3. **The two new jobs report counts.** Money is a string end-to-end in this
 *      codebase (CLAUDE.md §Money), so a result type whose every field is a
 *      `number` cannot carry a dollar figure — the guarantee is structural, and
 *      it stops typechecking the day someone adds `shortfall: string`.
 *
 * Static source audit, with the same comment-stripping posture as every phase
 * before it, so the JSDoc documenting these guarantees cannot trip the scan that
 * enforces them.
 */

/** The zero-egress core: the pure engine, its DB readers, and its writers. */
const CASHFLOW_DIR = __dirname;
const SRC = join(__dirname, "..", "..");
/** The projection surface and the candidate-review surface. */
const PAGE_DIR = join(SRC, "app", "plan", "cashflow");
const REVIEW_DIR = join(PAGE_DIR, "review");
/** The two unattended jobs (P16-26/27) — the only writers that run without a user. */
const DETECT_JOB = join(SRC, "worker", "jobs", "detect-obligations-weekly.ts");
const PROJECT_JOB = join(SRC, "worker", "jobs", "project-cashflow-daily.ts");
/** Boundary validation for every new input. */
const SCHEMA = join(SRC, "lib", "schemas", "cashflow.ts");
/** The dashboard tile and the settings form. */
const CARD = join(SRC, "components", "dashboard", "cashflow-card.tsx");
const SETTINGS_FORM = join(SRC, "app", "settings", "household", "cashflow-settings.tsx");
/** The two new tables. */
const OBLIGATIONS_SCHEMA = join(SRC, "db", "schema", "scheduled-obligations.ts");
const OCCURRENCES_SCHEMA = join(SRC, "db", "schema", "obligation-occurrences.ts");
/** The normalizer the detector groups by — outside the core, so audited by name. */
const NORMALIZE = join(SRC, "lib", "importers", "normalize.ts");

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

/** `src/lib/cashflow/` — detection, projection, matching, persistence. */
function cashFlowCorePaths(): readonly string[] {
  return inDir(CASHFLOW_DIR);
}

/** Everything that touches an obligation or a projected figure, core included. */
function allCashFlowPaths(): readonly string[] {
  return [
    ...cashFlowCorePaths(),
    ...inDir(PAGE_DIR),
    ...inDir(REVIEW_DIR),
    DETECT_JOB,
    PROJECT_JOB,
    SCHEMA,
    CARD,
    SETTINGS_FORM,
    OBLIGATIONS_SCHEMA,
    OCCURRENCES_SCHEMA,
  ];
}

/**
 * Every module specifier a file imports, side-effect imports included.
 *
 * The `from` pattern is tightened past the P15-39 template's: a preceding
 * quote, word character or dot disqualifies the match, because
 * `parseIsoDate(input.from, "from")` in [project.ts](./project.ts) otherwise
 * reads as an import of everything up to the next quote. That fails loudly
 * rather than quietly, but a mandatory privacy test that cries wolf is one
 * people learn to edit around.
 */
function importsOf(src: string): readonly string[] {
  const specifiers = [
    ...src.matchAll(/(?<!["'\w.])from\s*["']([^"']+)["']/g),
    ...src.matchAll(/^\s*import\s*["']([^"']+)["']/gm),
    ...src.matchAll(/\brequire\s*\(\s*["']([^"']+)["']\s*\)/g),
    ...src.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g),
  ];
  return specifiers.map((m) => m[1] as string);
}

describe("P16-36 — the cash-flow layer imports nothing that could reach the network", () => {
  /**
   * The complete set of non-relative specifiers `src/lib/cashflow/` may import.
   *
   * Every entry is local by construction: Postgres access, in-repo pure math,
   * in-repo date expansion, and the type-only imports the alert mapper needs.
   * There is no HTTP client, no SDK, no biller directory, and no way to add one
   * without editing this list — which is the point.
   */
  const ALLOWED_SPECIFIERS: readonly string[] = [
    // Packages.
    "decimal.js", // the mandated money arithmetic (CLAUDE.md §Money)
    "drizzle-orm", // query builder; the driver is the app's existing pool
    "server-only", // a build-time guard, not a runtime dependency
    // In-repo modules.
    "@/db/client.ts",
    "@/db/schema/accounts.ts",
    "@/db/schema/categories.ts",
    "@/db/schema/index.ts",
    "@/db/schema/obligation-occurrences.ts",
    "@/db/schema/scheduled-obligations.ts",
    "@/lib/advice/cash-tiers.ts",
    "@/lib/advice/debt-terms.ts",
    "@/lib/advice/net-income.ts",
    "@/lib/advice/types.ts",
    "@/lib/alerts/rules.ts",
    "@/lib/analytics/spending.ts",
    "@/lib/household/queries.ts",
    "@/lib/importers/normalize.ts",
    "@/lib/income/queries.ts",
    "@/lib/income/schedule.ts",
    "@/lib/money/money.ts",
    // CF-A2 / ADR-047. Closed-form amortization over terms the user typed in —
    // no rate feed, no servicer lookup, no quote service. It is the same
    // function the advice layer has called for the minimum payment since Phase
    // 15, and it is arithmetic: `monthlyPayment` and `balanceAtMonth` take a
    // principal, a rate and a term and return Decimal math. If a future edit
    // ever gives this module a network shape, that is what this entry is for.
    "@/lib/mortgage/amortization.ts",
    "@/lib/schedule/cadence.ts",
    "@/lib/schedule/occurrences.ts",
  ];

  it("audits a non-empty set of cash-flow modules", () => {
    // Guards against the whole suite passing vacuously if a directory moves or
    // a filter starts excluding everything.
    const paths = cashFlowCorePaths();
    expect(paths.length).toBeGreaterThan(12);
    for (const expected of [
      "detect.ts", // the detector
      "periodicity.ts", // the cadence test
      "payee-key.ts", // the grouping key — where an enrichment call would go
      "residual.ts", // the no-double-count residual
      "project.ts", // the day walk
      "safe-to-spend.ts", // the number on the dashboard
      "loader.ts", // the one DB-reading assembly point
      "alerts.ts", // the three new alert types
      "liability-obligations.ts", // the stated loan schedule (CF-A2)
      "shortfall-close.ts", // the reserve classification (CF-B1)
    ]) {
      expect(
        paths.some((p) => p.endsWith(expected)),
        `missing ${expected}`,
      ).toBe(true);
    }
    // And the wider surface actually resolved to files.
    expect(allCashFlowPaths().length).toBeGreaterThan(paths.length + 8);
  });

  it("imports only from the allowlist — anything new must be justified here", () => {
    for (const path of cashFlowCorePaths()) {
      for (const specifier of importsOf(code(path))) {
        if (specifier.startsWith(".")) continue; // within the cash-flow layer
        expect(
          ALLOWED_SPECIFIERS,
          `${path} imports "${specifier}", which is not on the zero-egress allowlist`,
        ).toContain(specifier);
      }
    }
  });

  it("never calls fetch, and names no external host", () => {
    // Not "no fetch to an absolute URL" as in Phases 11-14 — no fetch at all.
    // The cash-flow layer has no legitimate outbound call, so zero is checkable.
    for (const path of cashFlowCorePaths()) {
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

  it("no cash-flow surface reaches the network either", () => {
    // The pages, the jobs and the card are thinner, so a denylist suffices —
    // they legitimately import React, Next, Recharts and BullMQ.
    const FORBIDDEN: readonly RegExp[] = [
      /\baxios\b/,
      /\bundici\b/,
      /node-fetch/,
      /\bgot\b/,
      /@\/lib\/prices\//,
      /@\/lib\/plaid\//,
      /yahoo-finance/i,
      /coingecko/i,
      // Any hosted model. PLAN16's header is explicit: detection is a
      // deterministic periodicity test with a stated tolerance, and if it
      // cannot decide it says so. An LLM asked "is this a subscription?" would
      // be both an egress violation and an unfalsifiable answer.
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
    for (const path of allCashFlowPaths()) {
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

describe("P16-36 — the detector recognizes no vendor", () => {
  /**
   * The structural half: neither the grouping key nor the normalizer behind it
   * carries a vocabulary. A biller directory has to live SOMEWHERE — a map, a
   * JSON import, a regex alternation of brand names — and all three would show
   * up here.
   */
  it("carries no merchant, biller or vendor vocabulary", () => {
    // `liability-obligations.ts` joins the list at CF-C1. It is the newest place
    // a vocabulary would be tempting — "these are the twenty big mortgage
    // servicers" would improve the match rate, and would also be a hard-coded
    // list of who this household banks with, one edit away from becoming a
    // lookup. What that module actually matches on is an AMOUNT band around
    // arithmetic over terms the user typed in, which needs no directory at all.
    for (const path of [
      join(CASHFLOW_DIR, "payee-key.ts"),
      join(CASHFLOW_DIR, "liability-obligations.ts"),
      NORMALIZE,
    ]) {
      const src = code(path);
      expect(src, `${path} names a vendor table`).not.toMatch(
        /\b(?:MERCHANTS?|BILLERS?|VENDORS?|BRANDS?|KNOWN_PAYEES?|SERVICERS?|LENDERS?)\b/,
      );
      // A local directory would be data, and data of that size arrives as an
      // import — the allowlist above forbids a new one, and this forbids the
      // inline form.
      expect(src, `${path} imports a data file`).not.toMatch(/\.json["']/);
    }
  });

  /**
   * The behavioural half, and the one that actually catches a regression: a
   * brand and a nonsense string of the same SHAPE must normalize identically
   * apart from the token itself. If any recognition were ever added — even a
   * "helpful" list of the twenty commonest subscriptions — the two keys would
   * stop moving together and this fails.
   */
  it("treats a household name brand exactly like a string it has never seen", () => {
    /** The tokens of `a` that differ positionally from `b`'s. */
    function divergence(a: string, b: string): readonly string[] {
      const left = a.split(" ");
      const right = b.split(" ");
      expect(left.length, `"${a}" and "${b}" tokenized differently`).toBe(right.length);
      return left.filter((token, i) => token !== right[i]);
    }

    // A global subscription brand and a nonce of the same shape: only the brand
    // token itself may differ. Anything else means something recognized it.
    expect(
      divergence(payeeKey("NETFLIX.COM 866-579-7172 CA"), payeeKey("ZQXWVUT.COM 866-579-7172 CA")),
    ).toEqual(["netflix"]);

    // And a well-known utility gets no special casing a local landlord does not.
    expect(
      divergence(payeeKey("PG&E WEB ONLINE PMT 4471"), payeeKey("QVX&Z WEB ONLINE PMT 4471")),
    ).toEqual(["pg", "e"]);
  });

  it("groups by a key derived only from the string it was handed", () => {
    // Purity, stated as a property: the same description always yields the same
    // key, with no cache, no clock and nothing learned between calls. A lookup
    // service — even a memoized one — would not survive this over a fresh name.
    const fresh = `ACME ${Math.random().toString(36).slice(2)} LLC`;
    expect(payeeKey(fresh)).toEqual(payeeKey(fresh));
    expect(payeeKey("")).toEqual(payeeKey(""));
  });
});

describe("P16-36 — no cash-flow figure reaches a logger", () => {
  /** Identifiers that are, or directly carry, a figure about this household. */
  const FIGURE_IDENTIFIERS: readonly RegExp[] = [
    /\bbalance\w*\b/i,
    /\bclosing\b/i,
    /\bopening\b/i,
    /\blowWater\w*\b/i,
    /\bsafeToSpend\b/i,
    /\bshortfall\b/i,
    /\bfloor\b/i,
    /\bexpectedAmount\b/i,
    /\bmatchedAmount\b/i,
    /\bamountDelta\b/i,
    /\bdailyRate\b/i,
    /\bresidual\w*\b/i,
    /\bcoverage\b/i,
    /\bmedian\b/i,
    /\bamount\b/i,
    /\blabel\b/i,
    /\bpayee\w*\b/i,
    /\bname\b/i,
  ];

  it("the cash-flow surface makes no logger calls at all", () => {
    // A projection is a sentence about someone's money — "$312 on March 14" in
    // a log file is the same leak as printing the balance, and it lands
    // somewhere `docker logs` and terminal scrollback can carry it. Zero is the
    // only rule simple enough to hold, and the two jobs report through their
    // return value instead (see below).
    for (const path of allCashFlowPaths()) {
      const calls = code(path).match(/console\.\w+\s*\(/g) ?? [];
      expect(calls, `${path} logs from the cash-flow surface`).toEqual([]);
    }
  });

  it("would catch a figure being logged if a call were ever added", () => {
    // Belt-and-braces: if a logger call is ever introduced, this is the
    // assertion that has to be reckoned with rather than deleted wholesale.
    for (const path of allCashFlowPaths()) {
      for (const call of code(path).match(/console\.\w+\([^)]*\)/g) ?? []) {
        for (const pattern of FIGURE_IDENTIFIERS) {
          expect(call, `${path} logs a cash-flow identifier: ${call}`).not.toMatch(pattern);
        }
      }
    }
  });

  it("what the run-once entry point prints for both jobs is counts only", () => {
    // `run-once.ts` DOES log — it is a CLI and has to say what it did. The
    // guarantee is a property of the two result types: money is a string
    // end-to-end in this codebase (CLAUDE.md §Money), so a result whose every
    // field is a `number` cannot carry a dollar figure. These two object
    // literals stop typechecking the day someone adds `shortfall: string`.
    const projectCounts: Record<keyof ProjectCashFlowDailyResult, number> = {
      materialized: 0,
      swept: 0,
      matched: 0,
      missed: 0,
      detected: 0,
      created: 0,
      resolved: 0,
      notified: 0,
    };
    const detectCounts: Record<keyof DetectObligationsWeeklyResult, number> = {
      candidates: 0,
      highConfidence: 0,
    };
    for (const counts of [projectCounts, detectCounts]) {
      expect(Object.values(counts).every((v) => typeof v === "number")).toBe(true);
    }

    const runOnce = code(join(SRC, "worker", "run-once.ts"));
    for (const job of ["project-cashflow-daily", "detect-obligations-weekly"]) {
      const logs = runOnce.match(new RegExp(`console\\.\\w+\\([^;]*?${job}[^;]*?\\)`, "gs")) ?? [];
      expect(logs.length, `run-once does not report ${job}`).toBeGreaterThan(0);
      for (const call of logs) {
        expect(call, `run-once logs a figure for ${job}: ${call}`).not.toMatch(
          /\.(?:balance|shortfall|safeToSpend|lowWater|amount|label|floor|coverage)\b/,
        );
      }
    }
  });
});

describe("P16-36 — cash-flow alert detail never rides the notification email", () => {
  const SHORTFALL: ShortfallInput = {
    status: "ok",
    horizonDays: 60,
    coverage: "0.8200",
    lowWaterMark: { date: "2026-03-14", balance: "312.00" },
    safeToSpend: {
      amount: "0.00",
      bindingDate: "2026-03-14",
      floor: "1000.00",
      clampedAtZero: true,
      shortfall: "688.00",
    },
  };
  const MISSED: MissedOccurrenceInput = {
    occurrenceId: "occ-1",
    obligationId: "ob-1",
    label: "Ravenswood Property Management",
    dueDate: "2026-03-01",
    expectedAmount: "2150.00",
    direction: "outflow",
  };
  const CHANGED: AmountChangeInput = {
    occurrenceId: "occ-2",
    obligationId: "ob-2",
    label: "Dr Halloran Therapy",
    dueDate: "2026-03-03",
    expectedAmount: "180.00",
    matchedAmount: "-260.00",
    amountDelta: "80.00",
    amountMode: "fixed",
  };

  /** Every alert Phase 16 can write, with deliberately distinctive payloads. */
  function everyCashFlowAlert() {
    return [
      ...projectedShortfallAlerts(SHORTFALL),
      ...obligationMissedAlerts([MISSED]),
      ...obligationAmountChangedAlerts([CHANGED]),
    ];
  }

  it("produces one alert of each of the three Phase 16 types", () => {
    // Vacuity guard: if the mappers ever stop firing on these inputs, the
    // leak assertions below would pass without checking anything.
    const alerts = everyCashFlowAlert();
    expect(new Set(alerts.map((a) => a.type))).toEqual(new Set(CASHFLOW_ALERT_TYPES));
  });

  it("the notification body carries a count and a link, and no cash-flow value", () => {
    // A run date deliberately unlike any date in the alerts below, so a
    // collision cannot make the leak assertions pass by accident.
    const { subject, text } = buildNotification(3, "2026-08-15", "http://localhost:4000");
    const body = `${subject}\n${text}`;

    expect(body).toContain("3 new alerts");
    expect(body).toContain("/alerts");

    // Nothing from any `detail` payload — not a date, not a figure, not an id.
    for (const alert of everyCashFlowAlert()) {
      for (const [key, value] of Object.entries(alert.detail)) {
        if (typeof value !== "string" || value.length < 3) continue;
        expect(body, `notification body leaked detail.${key} = "${value}"`).not.toContain(value);
      }
      // And not the title either. Phase 16 is the first phase whose titles
      // embed a user-authored label — a landlord, a therapist, a person — so
      // "figures live in detail" (ADR-015) is necessary but no longer
      // sufficient on its own.
      expect(body, `notification body leaked a title: ${alert.title}`).not.toContain(alert.title);
    }

    for (const leak of ["obligation", "shortfall", "projected", "$", "/plan", "Mortgage"]) {
      expect(body, `notification body leaked "${leak}"`).not.toContain(leak);
    }
    // The only digits are the count and the date.
    expect(body.replace(/3 new alerts|3|2026-08-15|4000/g, "")).not.toMatch(/\d/);
  });

  it("the mailer is handed a count and a date — never an alert row", () => {
    // The job's seam: `notify(count, date)` has no parameter that could carry a
    // `detail`, so the guarantee holds by signature rather than by care. The
    // injected `deps.notify` is typed the same way, so a test double cannot
    // widen it either.
    const job = code(PROJECT_JOB);
    const signature = job.match(/notify\?:[^;]*;/g) ?? [];
    expect(signature.length, "the job no longer declares an injectable notifier").toBe(1);
    expect(signature[0]).toBe(
      "notify?: (count: number, date: string) => Promise<{ sent: boolean }>;",
    );

    const calls = job.match(/notifyFn\([^)]*\)/g) ?? [];
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call, `job passes an alert payload to the mailer: ${call}`).not.toMatch(
        /\bdetail\b|\balert\b(?!s\.length)|\btitle\b|\bamount\b/i,
      );
    }
  });
});
