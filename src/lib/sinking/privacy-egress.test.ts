// @vitest-environment node
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { buildNotification } from "@/lib/alerts/notify.ts";
import type { AlertType } from "@/lib/alerts/rules.ts";
import type { SearchResultKind } from "@/lib/search/global.ts";
import { searchPages } from "@/lib/search/pages.ts";
import { pgDumpArgs } from "@/worker/jobs/backup-database-daily.ts";
import { describe, expect, it } from "vitest";

/**
 * P18-33 — MANDATORY privacy regression for the sinking-fund surface
 * (PLAN18 §Privacy, ADR-043 §5, ADR-015, CLAUDE.md §Privacy & Data
 * Sovereignty).
 *
 * Phase 18's egress budget is the same absolute as Phases 15 and 16: **zero**.
 * Nothing under `src/lib/sinking/` makes an outbound request on any code path,
 * and there is no legitimate one to make — every figure in the phase is
 * `amount × elapsed ÷ total` over rows this household typed in or confirmed, and
 * every threshold is a constant checked into this repo.
 *
 * ── Why this file is a transitive walk and not a one-directory scan ───────
 * [advice/privacy-egress.test.ts](../advice/privacy-egress.test.ts) and
 * [cashflow/privacy-egress.test.ts](../cashflow/privacy-egress.test.ts) audit
 * their own directory against an import allowlist, which is the right shape for
 * a layer whose modules mostly import each other. This layer is different in one
 * specific way: [loader.ts](./loader.ts) composes the advice phase's
 * `loadFinancialSnapshot` on purpose (ADR-046 consequence 1), so the sinking
 * fund's real dependency graph is **most of the advice layer plus the schema
 * barrel** — 60-odd files, reached through four hops. An allowlist of direct
 * imports would pass while something four hops down grew a `fetch`. So this
 * resolves `@/…` and relative specifiers for real and walks the closure, then
 * scans every file it reaches.
 *
 * The closure is also why the package allowlist is so short. Six specifiers get
 * in, every one of them local by construction, and a seventh fails this test
 * wherever in the graph it appears.
 *
 * ── The new thing this phase has to defend ───────────────────────────────
 * `planned_expenses.label` and `.notes` are the first household-authored free
 * text since Phase 15, and the most sensitive in the app: *"Fertility
 * treatment"*, *"Dad's care home deposit"*, *"divorce lawyer retainer"*. A
 * balance leaking is embarrassing. These leaking is a different category. There
 * are exactly four ways text gets off this box, and this file closes all four:
 *
 *   1. **An outbound request** — the walk above.
 *   2. **A logger.** `docker logs` and terminal scrollback are a channel; a
 *      label in them is a leak with no network call involved. Zero `console.*`
 *      in the layer and on its surface, and no logger call anywhere in the
 *      closure that names a PII identifier.
 *   3. **The alert email**, which ADR-015 makes content-free. The phase adds no
 *      alert type at all (PLAN18 §Open Items — a sinking-fund alert is
 *      deliberately deferred to Round 16), and the mailer cannot reach the
 *      table.
 *   4. **The search index.** P18-00 decided *not* to index these rows, and a
 *      decision nobody enforces is a decision somebody undoes. The route is
 *      indexed; the rows are not, and the two assertions below say which is
 *      which so the distinction survives.
 *
 * Static source audit with the comment-stripping posture every phase before it
 * used, so the JSDoc documenting these guarantees — including the paragraph
 * above, which names `notes` and `fetch` in the same breath — cannot trip the
 * scan that enforces them.
 */

const SINKING_DIR = __dirname;
const SRC = resolve(__dirname, "..", "..");
/** The entry surface: the manager page, its form, its actions, its view models. */
const PAGE_DIR = join(SRC, "app", "plan", "sinking");
/** Boundary validation for the one form that accepts free text. */
const SCHEMA = join(SRC, "lib", "schemas", "planned-expense.ts");
/** The table itself. */
const TABLE = join(SRC, "db", "schema", "planned-expenses.ts");
/** The mailer, and the module that builds every alert title and detail. */
const NOTIFY = join(SRC, "lib", "alerts", "notify.ts");
const ALERT_RULES = join(SRC, "lib", "alerts", "rules.ts");
/** The row-level search index — accounts, categories, securities, transactions. */
const SEARCH_GLOBAL = join(SRC, "lib", "search", "global.ts");

/**
 * Read a source file with block + line comments stripped, so the scan covers
 * executable code only.
 */
function code(path: string): string {
  return readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

/** Non-test, non-fixture sources in a directory. */
function inDir(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => /\.tsx?$/.test(f) && !/\.(?:test|fixture)\.tsx?$/.test(f))
    .map((f) => join(dir, f))
    .filter((p) => statSync(p).isFile());
}

/**
 * Every module specifier a file imports, side-effect and dynamic imports
 * included.
 *
 * The `from` pattern carries the P16-36 tightening — a preceding quote, word
 * character or dot disqualifies the match — so `parseIsoDate(input.from, "from")`
 * in the schedule helpers does not read as an import.
 */
function importsOf(src: string): readonly string[] {
  return [
    ...src.matchAll(/(?<!["'\w.])from\s*["']([^"']+)["']/g),
    ...src.matchAll(/^\s*import\s*["']([^"']+)["']/gm),
    ...src.matchAll(/\brequire\s*\(\s*["']([^"']+)["']\s*\)/g),
    ...src.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g),
  ].map((m) => m[1] as string);
}

/**
 * Resolve an in-repo specifier to a file, or `null` for a package.
 *
 * @param specifier - As written in the source.
 * @param from - The importing file, for relative resolution.
 * @returns An absolute path, or `null` when the specifier names a package.
 * @throws If an in-repo specifier resolves to nothing — a silent miss here would
 *   shrink the audited closure without shrinking the shipped graph, which is the
 *   one failure mode of a walk like this.
 */
function resolveSpecifier(specifier: string, from: string): string | null {
  if (!specifier.startsWith("@/") && !specifier.startsWith(".")) return null;
  const base = specifier.startsWith("@/")
    ? join(SRC, specifier.slice(2))
    : resolve(dirname(from), specifier);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts")]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  throw new Error(`${from} imports "${specifier}", which resolves to no file`);
}

/** The transitive in-repo closure, plus every package specifier reached. */
function closure(entries: readonly string[]): {
  files: readonly string[];
  packages: ReadonlySet<string>;
} {
  const sources = new Map<string, string>();
  const packages = new Set<string>();
  const stack = [...entries];
  while (stack.length > 0) {
    const path = stack.pop() as string;
    if (sources.has(path)) continue;
    const src = code(path);
    sources.set(path, src);
    for (const specifier of importsOf(src)) {
      const resolved = resolveSpecifier(specifier, path);
      if (resolved === null) packages.add(specifier);
      else stack.push(resolved);
    }
  }
  return { files: [...sources.keys()].sort(), packages };
}

/** `src/lib/sinking/` — the pure core, the reads, the writes, the assembly. */
const SINKING_CORE = inDir(SINKING_DIR);
/** Everything reachable from it, four hops of advice snapshot included. */
const GRAPH = closure(SINKING_CORE);
/** The layer plus its UI, its validation and its table — audited by name. */
const SINKING_SURFACE: readonly string[] = [...SINKING_CORE, ...inDir(PAGE_DIR), SCHEMA, TABLE];

describe("P18-33 — nothing reachable from src/lib/sinking/ can reach the network", () => {
  /**
   * Every package the whole closure may import.
   *
   * Four of the six are the Postgres driver and the query builder; one is the
   * mandated money arithmetic; one is a build-time marker with no runtime
   * behaviour. There is no HTTP client anywhere in the graph, and the only way
   * to add one is to edit this list — in a diff, where somebody reads it.
   */
  const ALLOWED_PACKAGES: readonly string[] = [
    "decimal.js", // the mandated money arithmetic (CLAUDE.md §Money)
    "drizzle-orm", // query builder
    "drizzle-orm/pg-core", // table definitions
    "drizzle-orm/postgres-js", // the adapter, over the app's existing pool
    "postgres", // the driver; its only destination is DATABASE_URL
    "server-only", // a build-time guard, not a runtime dependency
  ];

  it("audits a closure big enough to be the real graph", () => {
    // Vacuity guards. A resolver bug or a moved directory would otherwise make
    // every assertion below pass over three files.
    expect(SINKING_CORE.length).toBeGreaterThan(12);
    expect(GRAPH.files.length).toBeGreaterThan(50);
    expect(SINKING_SURFACE.length).toBeGreaterThan(SINKING_CORE.length + 4);

    const names = GRAPH.files.map((p) => relative(SRC, p).replace(/\\/g, "/"));
    for (const expected of [
      // The phase's own core.
      "lib/sinking/accrual.ts", // the identity
      "lib/sinking/costs.ts", // the two-source stream
      "lib/sinking/requirement.ts", // the total
      "lib/sinking/availability.ts", // the reserve tier
      "lib/sinking/status.ts", // the degradation levels
      "lib/sinking/queries.ts", // the reads
      "lib/sinking/mutations.ts", // the writes
      "lib/sinking/loader.ts", // the one assembly point
      // And the reason this is a transitive walk: the composed advice snapshot
      // and the schema barrel are genuinely in the graph (ADR-046 cons. 1).
      "lib/advice/snapshot.ts",
      "lib/advice/rules/emergency-fund.ts",
      "db/schema/index.ts",
      "db/client.ts",
    ]) {
      expect(names, `closure is missing ${expected}`).toContain(expected);
    }
  });

  it("imports only from the package allowlist, anywhere in the closure", () => {
    for (const specifier of GRAPH.packages) {
      expect(
        ALLOWED_PACKAGES,
        `the sinking graph reaches package "${specifier}", which is not on the zero-egress allowlist`,
      ).toContain(specifier);
    }
  });

  it("makes no outbound call of any kind, on any transitive path", () => {
    // Not "no fetch to an absolute URL" — no fetch at all, and no socket, no
    // resolver, no beacon. There is no legitimate outbound call in this graph,
    // so zero is the checkable number.
    //
    // The page surface is included rather than left to the looser denylist
    // below, because a client island is the one place in this phase where a
    // `fetch` would look ordinary: the entry form already talks to the server,
    // and it does so through a server action precisely so the household's own
    // words for a cost never become a request body somebody can redirect.
    for (const path of [...GRAPH.files, ...inDir(PAGE_DIR)]) {
      const src = code(path);
      const where = relative(SRC, path);
      expect(src, `${where} calls fetch()`).not.toMatch(/\bfetch\s*\(/);
      expect(src, `${where} opens a socket or resolver`).not.toMatch(
        /\bnode:(?:https?|net|tls|dgram|dns)\b|\brequire\(["']https?["']\)/,
      );
      expect(src, `${where} constructs a browser request`).not.toMatch(
        /\bnew\s+(?:XMLHttpRequest|WebSocket|EventSource)\b|\bnavigator\.sendBeacon\b/,
      );
      expect(src, `${where} names an external host`).not.toMatch(
        /https?:\/\/(?!localhost|127\.0\.0\.1)/,
      );
    }
  });

  it("reaches no price feed, no Plaid client, no hosted model, no analytics SaaS", () => {
    // The import allowlist already excludes all of these, so this is the
    // belt-and-braces half: it catches a bare identifier, a dynamic specifier
    // built from a template, or a string that is about to become one.
    const FORBIDDEN: readonly RegExp[] = [
      /\baxios\b/,
      /\bundici\b/,
      /node-fetch/,
      // `@/lib/prices/` is the one directory in the app that legitimately makes
      // outbound calls, so reaching into it is forbidden — with one named
      // exception, pinned by its own test below. The planned-expense zod schema
      // imports `todayIso` from `@/lib/prices/types.ts`, a two-line UTC date
      // helper that happens to live beside the fetchers because that is where
      // it was first needed. Found by this pass (P18-33): the import is inert,
      // the location is a smell, and moving it would churn six files in the one
      // directory that does egress — so the exception is narrow and asserted
      // rather than assumed.
      /@\/lib\/prices\/(?!types\.ts)/,
      /@\/lib\/plaid\//,
      /\bPlaidApi\b/,
      /yahoo-finance/i,
      /coingecko/i,
      // A hosted model is the one that would be tempting here and nowhere else
      // in the phase: "what should I be saving for?" is exactly the question an
      // LLM answers plausibly. It would also ship a list of what this household
      // is quietly saving for, which is the whole reason the app exists.
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
    for (const path of [...GRAPH.files, ...SINKING_SURFACE]) {
      const src = code(path);
      for (const pattern of FORBIDDEN) {
        expect(src, `${relative(SRC, path)} references forbidden ${pattern.source}`).not.toMatch(
          pattern,
        );
      }
      expect(src, `${relative(SRC, path)} embeds a remote <script>/<img> source`).not.toMatch(
        /<(?:script|img|iframe)[^>]+src=["'`]https?:/i,
      );
    }
  });

  it("pins the one allowed reach into the price directory as inert", () => {
    // The exception noted in the scan above. It is safe only while
    // `@/lib/prices/types.ts` stays what it is: interfaces plus `todayIso`,
    // importing NOTHING. The day it imports a fetcher — or the day somebody adds
    // a convenience `quote()` to it — the free-text entry form acquires a
    // transitive path to the network, and that is the assertion that fires.
    const pricesTypes = join(SRC, "lib", "prices", "types.ts");
    const src = code(pricesTypes);
    expect(importsOf(src), "prices/types.ts is no longer import-free").toEqual([]);
    expect(src, "prices/types.ts now calls fetch").not.toMatch(/\bfetch\s*\(/);
    expect(src, "prices/types.ts now names a host").not.toMatch(/https?:\/\//);
    // And the import is still the only thing the schema takes from there.
    const schemaImports = importsOf(code(SCHEMA)).filter((s) => s.startsWith("@/lib/prices/"));
    expect(schemaImports).toEqual(["@/lib/prices/types.ts"]);
  });

  it("keeps the test-only fixture out of shipped code", () => {
    // `round12.fixture.ts` imports the advice fixture and builds a whole
    // household. It is shared by eight test files, which is why it is not
    // inside one of them — and that is exactly what makes it reachable by
    // accident. A page that imported it would render a fictional family's costs
    // as if they were the household's.
    for (const path of [...GRAPH.files, ...SINKING_SURFACE]) {
      expect(
        importsOf(code(path)),
        `${relative(SRC, path)} imports a test fixture`,
      ).not.toContainEqual(expect.stringContaining("round12.fixture"));
    }
  });
});

describe("P18-33 — the household's free text reaches no logger", () => {
  /** Identifiers that are, or directly carry, PII or a figure. */
  const PII_IDENTIFIERS: readonly RegExp[] = [
    /\blabel\b/i,
    /\bnotes?\b/i,
    /\bamount\b/i,
    /\brequiredToday\b/i,
    /\bperMonth\b/i,
    /\bavailable\b/i,
    /\breserveTotal\b/i,
    /\bgap\b/i,
    /\bsurplus\b/i,
    /\bbalance\w*\b/i,
    /\bcost\w*\b/i,
    /\bdueDate\b/i,
  ];

  it("the sinking layer and its surface make no logger calls at all", () => {
    // "New roof" is mild. "Fertility treatment" is not, and the table cannot
    // tell them apart — which is why the rule is zero rather than a judgement
    // about which labels are sensitive. `process.stdout` is included because it
    // is the obvious way around a `console` ban.
    for (const path of [...SINKING_CORE, ...inDir(PAGE_DIR), SCHEMA, TABLE]) {
      const src = code(path);
      const where = relative(SRC, path);
      expect(src.match(/console\.\w+\s*\(/g) ?? [], `${where} logs`).toEqual([]);
      expect(src, `${where} writes to stdout/stderr directly`).not.toMatch(
        /process\.(?:stdout|stderr)\.write/,
      );
    }
  });

  it("no logger call anywhere in the closure names a cost, a label or a figure", () => {
    // The closure includes the advice snapshot and the schema barrel, which are
    // not this phase's to keep console-free forever. What they must never do is
    // log one of these identifiers — so this is the assertion that has to be
    // reckoned with rather than deleted if a logger call is ever added
    // upstream.
    for (const path of GRAPH.files) {
      for (const call of code(path).match(/console\.\w+\([^)]*\)/g) ?? []) {
        for (const pattern of PII_IDENTIFIERS) {
          expect(call, `${relative(SRC, path)} logs a PII identifier: ${call}`).not.toMatch(
            pattern,
          );
        }
      }
    }
  });
});

describe("P18-33 — planned expenses cannot reach the alert email", () => {
  it("the phase adds no alert type, so there is nothing to leak", () => {
    // PLAN18 §Open Items: a sinking-fund alert ("a cost is due in 30 days and
    // you are $600 short") is deliberately deferred — it is a forward-looking
    // input-health signal, which is Round 16's job done once across all inputs.
    // Recording that as a type-level assertion rather than a paragraph means the
    // day somebody adds one, they are sent to ADR-015 first: such an alert must
    // never name the cost, and the label is the cost's name.
    // Exhaustive over the shipped union, so adding a thirteenth alert type
    // fails `tsc` here and the author has to name it in this file.
    const everyAlertType: Record<AlertType, true> = {
      large_transaction: true,
      balance_drop: true,
      item_login_required: true,
      stale_snapshot: true,
      stale_price: true,
      sync_failure: true,
      backup_failure: true,
      price_target: true,
      advice: true,
      projected_shortfall: true,
      obligation_missed: true,
      obligation_amount_changed: true,
      // P19-06 (ADR-052): a configuration fact about the deployment. It carries
      // no figure and no name — its `detail` is the unset variable's name only.
      backup_not_configured: true,
    };
    for (const type of Object.keys(everyAlertType)) {
      expect(type, `${type} looks like a sinking-fund alert`).not.toMatch(/sinking|planned/i);
    }
  });

  it("the mailer and the alert mappers cannot see the table", () => {
    for (const path of [NOTIFY, ALERT_RULES]) {
      const src = code(path);
      const where = relative(SRC, path);
      expect(src, `${where} references planned expenses`).not.toMatch(
        /plannedExpenses|planned_expenses|planned-expenses/,
      );
      // And not by a hop either: `notify.ts` imports one package and nothing
      // in-repo, so its closure is itself.
      for (const specifier of importsOf(src)) {
        expect(specifier, `${where} imports ${specifier}`).not.toMatch(/sinking|planned/i);
      }
    }
  });

  it("the notification body carries a count and a link, and no household text", () => {
    // ADR-015, asserted behaviourally as well as structurally: the email is a
    // doorbell. A label like this one is the single worst string in the app to
    // put in front of a third-party SMTP relay, so the assertion uses one.
    const { subject, text } = buildNotification(2, "2026-10-04", "http://localhost:4000");
    const body = `${subject}\n${text}`;

    expect(body).toContain("2 new alerts");
    expect(body).toContain("/alerts");
    for (const leak of [
      "Fertility treatment",
      "Dental work",
      "New roof",
      "sinking",
      "planned",
      "$",
      "/plan",
    ]) {
      expect(body, `notification body leaked "${leak}"`).not.toContain(leak);
    }
  });
});

describe("P18-33 — the rows are not indexed, and the route is", () => {
  it("the search index has no planned-expense kind", () => {
    // P18-00's recorded decision, enforced rather than remembered. `label` and
    // `notes` are the most sensitive free text in the app, and indexing them
    // would put them one keystroke from the palette on every page — a §Privacy
    // question deserving its own pass, alongside Round 15's bus-file work which
    // raises the same concentration concern.
    const kinds: readonly SearchResultKind[] = [
      "page",
      "account",
      "category",
      "security",
      "watchlist",
      "transaction",
      "help",
    ];
    // Exhaustive by construction: this stops typechecking the day a new member
    // is added, which is the point at which somebody has to decide whether it
    // is this one. The seventh, `help` (PLAN20 P20-07), was decided: it is
    // static help text, matched in the browser, and indexes no rows.
    const exhaustive: Record<SearchResultKind, true> = {
      page: true,
      account: true,
      category: true,
      security: true,
      watchlist: true,
      transaction: true,
      help: true,
    };
    expect(Object.keys(exhaustive).sort()).toEqual([...kinds].sort());

    const src = code(SEARCH_GLOBAL);
    expect(src, "the row-level search index references planned expenses").not.toMatch(
      /plannedExpenses|planned_expenses|planned-expenses/,
    );
  });

  it("the page itself is still reachable from the palette", () => {
    // The other half of the decision, and the half a blunt "the palette must not
    // know about sinking funds" rule would have broken: the ROUTE is indexed
    // from the nav manifest (ADR-035), because a household has to be able to get
    // to the page. What is not indexed is the rows on it. Keeping both
    // assertions in one file is what stops either from being "simplified" into
    // the other.
    const titles = searchPages("sinking").map((result) => result.title);
    expect(titles).toContain("Sinking funds");
    for (const result of searchPages("sinking")) {
      expect(result.kind).toBe("page");
      expect(result.subtitle ?? "").not.toMatch(/\$|\d{4}-\d{2}-\d{2}/);
    }
  });
});

describe("P18-33 — the new table rides the existing backup", () => {
  it("pg_dump selects no table list, so a new table needs no backup change", () => {
    // Acceptance criterion 10's last clause, as an assertion rather than a
    // claim. `planned_expenses` is covered by the nightly `age`-encrypted dump
    // the moment the migration lands — and it stays covered only while the dump
    // is whole-database. A `--table` list is how a backup silently stops
    // covering the newest table, which for this app is the one failure that
    // cannot be recovered from.
    const args = pgDumpArgs("postgres://user:pw@db:5432/money");
    expect(args).toContain("--format=custom");
    for (const arg of args) {
      expect(arg, `pg_dump argv restricts which tables are dumped: ${arg}`).not.toMatch(
        /^(?:-t|-T|--table|--exclude-table|--schema|--exclude-schema)\b/,
      );
    }
  });
});
