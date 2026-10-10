// @vitest-environment node
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { db } from "@/db/client.ts";
import { accountSnapshots, accounts, transactions } from "@/db/schema/index.ts";
import { buildDemoBook } from "@/lib/demo/book.ts";
import { BOOK_TABLES, seedDemo } from "@/lib/demo/seed.ts";
import { sql } from "drizzle-orm";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * P19-36 — MANDATORY privacy regression for Phase 19 (PLAN19 §Privacy,
 * ADR-052 §6, Hard boundary #2, CLAUDE.md §Privacy & Data Sovereignty).
 *
 * Phase 19 adds the first surface whose whole purpose is to be shown to a
 * stranger: `/settings/instance` is built to be pasted into a public issue. And
 * it is the phase that makes the app adoptable by people who never read
 * CLAUDE.md, so "no telemetry" has to stop being a rule in a document and
 * become a test. Three blocks, one per promise:
 *
 *   1. **The instance surface cannot reach the network.** The transitive walk
 *      the sinking suite introduced (P18-33), rooted at `src/lib/instance/`,
 *      the page and the heartbeat job. Two packages beyond the database get in
 *      — `bullmq` and `ioredis`, because the page reads the worker's heartbeat
 *      from the Redis container — and nothing else, wherever it appears.
 *   2. **No telemetry, anywhere in the tree.** Not per-directory: every source
 *      file under `src/`, every dependency in `package.json`, and every package
 *      in the lockfile. Outbound calls are pinned to the files that already
 *      make them, and outbound hosts to the ones the docs already name. A new
 *      one fails here, in a diff where somebody reads it.
 *   3. **The page leaks no figure and no secret.** The real page, over the real
 *      loaders, against a database holding the demo household and an
 *      environment holding a value for every secret — and the markup contains
 *      none of either.
 *
 * Static audits use the comment-stripping posture of every suite before this
 * one, so the paragraphs documenting these guarantees (which name `fetch`,
 * Sentry and Posthog) cannot trip the scans that enforce them.
 */

const SRC = resolve(__dirname, "..", "..");
const ROOT = resolve(SRC, "..");

/** Read a source file with block and line comments stripped. */
function code(path: string): string {
  return readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

function isSource(name: string): boolean {
  return /\.tsx?$/.test(name) && !/\.(?:test|spec|fixture)\.tsx?$/.test(name);
}

/** Non-test sources directly in a directory. */
function inDir(dir: string): string[] {
  return readdirSync(dir)
    .filter(isSource)
    .map((f) => join(dir, f))
    .filter((p) => statSync(p).isFile());
}

/** Non-test sources anywhere under a directory. */
function underDir(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...underDir(path));
    else if (isSource(entry.name)) out.push(path);
  }
  return out;
}

/** Repo-relative, forward-slashed — stable across platforms for messages. */
function rel(path: string): string {
  return relative(ROOT, path).replace(/\\/g, "/");
}

/**
 * Every module specifier a file imports, side-effect, re-export and dynamic
 * imports included (with the P16-36 tightening on `from`).
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
 * @throws If an in-repo specifier resolves to nothing: a silent miss would
 *   shrink the audited closure without shrinking the shipped graph.
 */
function resolveSpecifier(specifier: string, from: string): string | null {
  if (!isInRepo(specifier)) return null;
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
  files: ReadonlyMap<string, string>;
  packages: ReadonlySet<string>;
} {
  const files = new Map<string, string>();
  const packages = new Set<string>();
  const stack = [...entries];
  while (stack.length > 0) {
    const path = stack.pop() as string;
    if (files.has(path)) continue;
    // JSON (the migration journal, package.json) is data, not code.
    const src = path.endsWith(".json") ? "" : code(path);
    files.set(path, src);
    for (const specifier of importsOf(src)) {
      const resolved = resolveSpecifier(specifier, path);
      if (resolved === null) packages.add(specifier);
      else stack.push(resolved);
    }
  }
  return { files, packages };
}

/** `@/…` and relative specifiers name this repo's own modules, not packages. */
function isInRepo(specifier: string): boolean {
  return specifier.startsWith("@/") || specifier.startsWith(".");
}

/**
 * Call syntax for every browser and Node API that sends bytes off the box,
 * outside the package imports. `fetch` matches as a call or as a default
 * (`fetchImpl ?? fetch`), not as a word in an identifier.
 */
const OUTBOUND_CALLS: readonly RegExp[] = [
  /(?<![\w.$])fetch\s*\(/,
  /\?\?\s*fetch\b/,
  /\bglobalThis\.fetch\b/,
  /\bsendBeacon\b/,
  /\bXMLHttpRequest\b/,
  /\bnew\s+WebSocket\b/,
  /\bnew\s+EventSource\b/,
];

// ── 1. The instance surface ───────────────────────────────────────────────

const INSTANCE_ENTRIES: readonly string[] = [
  ...inDir(join(SRC, "lib", "instance")),
  ...inDir(join(SRC, "app", "settings", "instance")),
  join(SRC, "worker", "jobs", "heartbeat.ts"),
];
const INSTANCE_GRAPH = closure(INSTANCE_ENTRIES);

describe("P19-36 — nothing reachable from the instance surface can reach the network", () => {
  /**
   * Every package the whole closure may import.
   *
   * The database driver and its query builder; the queue library and its Redis
   * client, whose only destination is `REDIS_URL` (the compose network's own
   * Redis — the page reads the worker's heartbeat from it); the argon2 binding
   * for the password form; the session cookie; validation; React and the two
   * Next.js modules a page uses. No HTTP client, no SDK.
   */
  const ALLOWED_PACKAGES: readonly string[] = [
    "server-only", // a build-time guard, not a runtime dependency
    "drizzle-orm",
    "drizzle-orm/pg-core",
    "drizzle-orm/postgres-js",
    "postgres", // its only destination is DATABASE_URL
    "bullmq", // queue reads; its only destination is REDIS_URL
    "ioredis", // the connection bullmq uses
    "decimal.js", // the mandated money arithmetic, via the schema barrel
    "zod",
    "@node-rs/argon2", // P19-33 password change: hashing is local
    "iron-session", // the session cookie, re-issued after a password change
    "node:crypto", // random bytes and hashing, in process
    "next/headers",
    "next/link",
    "next/navigation",
    "next/cache",
    "react",
  ];

  it("audits a closure big enough to be the real graph", () => {
    const names = [...INSTANCE_GRAPH.files.keys()].map(rel);
    expect(INSTANCE_ENTRIES.length).toBeGreaterThan(6);
    expect(names.length).toBeGreaterThan(30);
    for (const expected of [
      "src/lib/instance/config-state.ts",
      "src/lib/instance/queries.ts",
      "src/app/settings/instance/page.tsx",
      "src/app/settings/instance/actions.ts",
      "src/lib/auth/change-password.ts",
      "src/lib/queue/queues.ts",
      "src/db/client.ts",
      "src/worker/jobs/heartbeat.ts",
    ]) {
      expect(names, `closure is missing ${expected}`).toContain(expected);
    }
  });

  it("imports no package outside the allowlist, anywhere in the closure", () => {
    const unknown = [...INSTANCE_GRAPH.packages].filter((p) => !ALLOWED_PACKAGES.includes(p));
    expect(unknown).toEqual([]);
  });

  it("makes no outbound call, anywhere in the closure", () => {
    const hits: string[] = [];
    for (const [path, src] of INSTANCE_GRAPH.files) {
      for (const pattern of OUTBOUND_CALLS) {
        if (pattern.test(src)) hits.push(`${rel(path)}: ${pattern.source}`);
      }
    }
    expect(hits).toEqual([]);
  });
});

// ── 2. No telemetry, tree-wide ────────────────────────────────────────────

/**
 * Package names that are telemetry, analytics, error-reporting SaaS or an
 * update check. A denylist on names — the allowlists below are what fail
 * closed; this is what gives the failure a name a reviewer recognises.
 */
const TELEMETRY_PACKAGE =
  /(?:^|[/@-])(?:sentry|posthog|segment|analytics|mixpanel|amplitude|datadog|dd-trace|newrelic|logrocket|bugsnag|rollbar|honeybadger|hotjar|fullstory|heap|plausible|umami|gtag|ga4|opentelemetry|otel|update-notifier|update-check|speed-insights|appsignal|raygun|elastic-apm)(?:$|[/@-])/i;

const ALL_SOURCES: readonly string[] = underDir(SRC);

describe("P19-36 — no telemetry, asserted over the whole tree", () => {
  it("scans the whole tree, not a sample", () => {
    expect(ALL_SOURCES.length).toBeGreaterThan(400);
  });

  it("declares no telemetry dependency in package.json", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const names = [
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
    ];
    expect(names.length).toBeGreaterThan(20);
    expect(names.filter((n) => TELEMETRY_PACKAGE.test(n))).toEqual([]);
  });

  it("installs no telemetry package, even transitively (pnpm-lock.yaml)", () => {
    const lock = readFileSync(join(ROOT, "pnpm-lock.yaml"), "utf8");
    // The `packages:` section keys every installed package as `  name@version:`.
    // (Optional peers such as Next's `@opentelemetry/api` are listed under
    // `peerDependencies` of the package that names them, which is not an install.)
    const installed = [...lock.matchAll(/^ {2}'?(@?[^@\s']+)@[^:\s]+'?:\s*$/gm)].map(
      (m) => m[1] as string,
    );
    expect(installed.length).toBeGreaterThan(100);
    expect([...new Set(installed)].filter((n) => TELEMETRY_PACKAGE.test(n))).toEqual([]);
  });

  it("imports no telemetry package from any source file", () => {
    const hits: string[] = [];
    for (const path of ALL_SOURCES) {
      for (const specifier of importsOf(code(path))) {
        if (isInRepo(specifier)) continue;
        if (TELEMETRY_PACKAGE.test(specifier)) hits.push(`${rel(path)}: ${specifier}`);
      }
    }
    expect(hits).toEqual([]);
  });

  /**
   * The packages that can open a connection off this host, and the files that
   * may import them. Each one is a documented, opt-in egress: Plaid (PLAID.md),
   * the alert email (ALERTS.md, ADR-015), and the webhook signature check,
   * which verifies against a key Plaid's own API returns. A new importer of
   * one of these — or a new network package — fails the next test.
   */
  const NETWORK_PACKAGES: Readonly<Record<string, readonly string[]>> = {
    plaid: [
      "src/app/settings/connections/actions.ts",
      "src/lib/plaid/client.ts",
      "src/lib/plaid/map.ts", // type-only
      "src/lib/plaid/webhook-verify.ts", // type-only
      "src/worker/jobs/sync-plaid-item.ts", // type-only
    ],
    "react-plaid-link": ["src/app/settings/connections/link-button.tsx"],
    nodemailer: ["src/lib/alerts/notify.ts"],
    jose: ["src/lib/plaid/webhook-verify.ts"],
  };

  /** Packages that can only ever reach a container on the compose network. */
  const LOCAL_SERVICE_PACKAGES: readonly string[] = ["postgres", "ioredis", "bullmq"];

  /** Package names that are HTTP clients or raw sockets, by any other name. */
  const NETWORK_CLIENT =
    /^(?:node:)?(?:http|https|http2|net|tls|dgram)$|^(?:axios|got|ky|undici|node-fetch|cross-fetch|isomorphic-fetch|superagent|request|needle|phin|socket\.io-client|ws|yahoo-finance2)(?:$|\/)/;

  it("imports a network-capable package only from the files that already do", () => {
    const hits: string[] = [];
    for (const path of ALL_SOURCES) {
      const name = rel(path);
      for (const specifier of importsOf(code(path))) {
        const allowed = NETWORK_PACKAGES[specifier];
        if (allowed && !allowed.includes(name)) hits.push(`${name}: ${specifier}`);
        if (NETWORK_CLIENT.test(specifier)) hits.push(`${name}: ${specifier}`);
      }
    }
    expect(hits).toEqual([]);
    expect(LOCAL_SERVICE_PACKAGES.some((p) => p in NETWORK_PACKAGES)).toBe(false);
  });

  /**
   * The files that make an outbound call outside an SDK: the two Yahoo
   * fetchers and CoinGecko (public price endpoints; only a ticker leaves —
   * the watchlist and investments suites pin that), and the ⌘K palette, which
   * calls this app's own `/api/search` by a relative URL.
   */
  const OUTBOUND_CALLERS: readonly string[] = [
    "src/lib/prices/yahoo-chart.ts",
    "src/lib/prices/yahoo-fundamentals.ts",
    "src/lib/prices/coingecko.ts",
    "src/components/command-palette.tsx",
  ];

  it("makes an outbound call only from the files that already do", () => {
    const callers = ALL_SOURCES.filter((path) => {
      const src = code(path);
      return OUTBOUND_CALLS.some((p) => p.test(src));
    }).map(rel);
    expect(callers.sort()).toEqual([...OUTBOUND_CALLERS].sort());
  });

  it("the palette's one call stays on this origin", () => {
    const palette = code(join(ROOT, "src/components/command-palette.tsx"));
    expect(palette).toMatch(/fetch\(\s*`\/api\/search/);
  });

  /**
   * Every absolute URL host in executable code. The three market-data hosts
   * are the only ones the app requests; `dashboard.plaid.com` is a link the
   * operator clicks; the SVG namespace is not a request; the rest are
   * placeholders in examples and defaults.
   */
  const ALLOWED_HOSTS: readonly string[] = [
    "query1.finance.yahoo.com",
    "query2.finance.yahoo.com",
    "api.coingecko.com",
    "dashboard.plaid.com",
    "www.w3.org",
    "localhost",
    "127.0.0.1",
  ];

  it("names no outbound host beyond the documented ones", () => {
    const hits: string[] = [];
    for (const path of ALL_SOURCES) {
      for (const m of code(path).matchAll(/https?:\/\/([a-zA-Z0-9.-]+)/g)) {
        const host = m[1] as string;
        const placeholder = /(?:^|\.)(?:example\.com|test|invalid)$/.test(host);
        if (!placeholder && !ALLOWED_HOSTS.includes(host)) hits.push(`${rel(path)}: ${host}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it("switches off Next.js's own CLI telemetry wherever `next` runs", () => {
    // `next build` and `next dev` report anonymous usage to Vercel unless this
    // is set. The Dockerfile sets it for the image; next.config.ts sets it for
    // every other machine that builds or develops — a contributor's laptop, a
    // CI runner, an operator building their own image without the Dockerfile.
    const dockerfile = readFileSync(join(ROOT, "Dockerfile"), "utf8");
    expect(dockerfile.match(/^ENV NEXT_TELEMETRY_DISABLED=1$/gm)).toHaveLength(2);
    expect(code(join(ROOT, "next.config.ts"))).toMatch(
      /process\.env\.NEXT_TELEMETRY_DISABLED\s*\?\?=\s*"1"/,
    );
  });
});

// ── 3. The page leaks no figure and no secret ─────────────────────────────

const queues = vi.hoisted(() => ({ heartbeat: [] as unknown[], backup: [] as unknown[] }));

vi.mock("@/lib/auth/require-user.ts", () => ({ requireUser: async () => ({ id: "u" }) }));
vi.mock("@/app/settings/instance/actions.ts", () => ({
  recordRestoreDrillAction: async () => {},
  changePasswordAction: async () => ({}),
}));
vi.mock("@/lib/queue/queues.ts", () => ({
  heartbeatQueue: { getJobs: async () => queues.heartbeat },
  backupDatabaseDailyQueue: { getJobs: async () => queues.backup },
}));

/**
 * One value for every secret the instance reads, each a distinctive run of
 * characters the page could not produce by accident. `DATABASE_URL` stays the
 * real test database's (the page has to query it); its password is checked
 * below instead.
 */
const SECRETS: Readonly<Record<string, string>> = {
  PLAID_CLIENT_ID: "plaidclientidZXCVBNM12345",
  PLAID_SECRET: "plaidsecretPOIUYTREWQ98765",
  SMTP_URL: "smtp://mailuserQAZ:mailpassLKJHGF@mail.private-domain.test:587",
  ALERT_EMAIL_TO: "household-owner@private-domain.test",
  BACKUP_AGE_RECIPIENT: "age1qyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqsabcdef",
  SESSION_SECRET: "sessionsecretMNBVCXZASDFGHJKL0987654321",
  MONEY_ENCRYPTION_KEY: "encryptionkeyQAZWSXEDCRFVTGB=",
  PLAID_WEBHOOK_URL: "https://hooks.private-domain.test/plaid/webhook",
};

/**
 * What must not appear, per secret. A whole value is checked as every 8-char
 * run of it; a URL is checked by its credential and host, since its scheme
 * (`smtp://`, `https://`) is shared with text the page legitimately prints.
 */
function secretFragments(): ReadonlyArray<readonly [string, string]> {
  const runs = (name: string, value: string): Array<readonly [string, string]> => {
    const out: Array<readonly [string, string]> = [];
    for (let i = 0; i + 8 <= value.length; i += 1) out.push([name, value.slice(i, i + 8)]);
    return out;
  };
  const dbPassword = new URL(process.env.DATABASE_URL ?? "postgres://x@y/z").password;
  return [
    ...runs("PLAID_CLIENT_ID", SECRETS.PLAID_CLIENT_ID ?? ""),
    ...runs("PLAID_SECRET", SECRETS.PLAID_SECRET ?? ""),
    ...runs("BACKUP_AGE_RECIPIENT", SECRETS.BACKUP_AGE_RECIPIENT ?? ""),
    ...runs("SESSION_SECRET", SECRETS.SESSION_SECRET ?? ""),
    ...runs("MONEY_ENCRYPTION_KEY", SECRETS.MONEY_ENCRYPTION_KEY ?? ""),
    ["SMTP_URL", "mailuserQAZ"],
    ["SMTP_URL", "mailpassLKJHGF"],
    ["SMTP_URL / ALERT_EMAIL_TO / PLAID_WEBHOOK_URL", "private-domain"],
    ["ALERT_EMAIL_TO", "household-owner"],
    ...(dbPassword ? [["DATABASE_URL", dbPassword] as const] : []),
  ];
}

const TODAY = "2026-10-10";
let html = "";
let leakCandidates: readonly string[] = [];

/** Every way a money string could be printed: raw, grouped, and unsigned. */
function moneyForms(raw: string): string[] {
  const unsigned = raw.replace(/^-/, "");
  const [whole = "", cents = "00"] = unsigned.split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return [unsigned, `${grouped}.${cents}`];
}

beforeAll(async () => {
  for (const [name, value] of Object.entries(SECRETS)) vi.stubEnv(name, value);
  vi.stubEnv("PLAID_ENV", "production");

  await db.execute(
    sql.raw(
      `TRUNCATE ${BOOK_TABLES.join(", ")}, prices, categories, category_groups, category_rules CASCADE`,
    ),
  );
  await seedDemo({ today: TODAY, env: { NODE_ENV: "development" } as NodeJS.ProcessEnv });

  // The worker's report is the same function over the same environment, as it
  // would be on a worker container that holds every secret.
  const { instanceConfigState } = await import("./config-state.ts");
  queues.heartbeat = [
    {
      finishedOn: Date.parse(`${TODAY}T11:59:00Z`),
      returnvalue: { config: instanceConfigState() },
    },
  ];
  queues.backup = [
    {
      finishedOn: Date.parse(`${TODAY}T04:00:30Z`),
      returnvalue: { outPath: "/backups/x.age", bytes: 1 },
    },
  ];

  const names = await db.select({ name: accounts.name, inst: accounts.institution }).from(accounts);
  const txns = await db.select({ d: transactions.name }).from(transactions);
  const balances = await db.select({ b: accountSnapshots.balance }).from(accountSnapshots);
  const book = buildDemoBook(TODAY);
  leakCandidates = [
    ...names.flatMap((r) => [r.name, r.inst]),
    ...new Set(txns.map((r) => r.d)),
    ...book.holdings.map((h) => h.symbol),
    book.plannedExpense.label,
    book.recurringBill.label,
    book.mortgage.name,
    ...balances.flatMap((r) => moneyForms(r.b)).filter((s) => s.replace(/\D/g, "").length >= 4),
  ].filter((s) => s.trim() !== "");

  const { default: InstanceSettingsPage } = await import("@/app/settings/instance/page.tsx");
  html = renderToStaticMarkup(await InstanceSettingsPage());
});

afterAll(() => {
  vi.unstubAllEnvs();
});

describe("P19-36 — /settings/instance is safe to paste into a public issue", () => {
  it("renders the real page over a populated book and a full set of secrets", () => {
    // Vacuity guards: the book is there, the page rendered its real sections,
    // and the configured subsystems read as configured.
    expect(leakCandidates.length).toBeGreaterThan(50);
    expect(html).toContain("Instance");
    expect(html).toContain("Backups");
    expect(html).not.toContain("Not configured</");
    expect(html).not.toContain("Could not be read just now");
  });

  it("shows no account name, institution, payee, holding or planned expense", () => {
    const words = leakCandidates.filter((s) => /[A-Za-z]/.test(s));
    expect(words.length).toBeGreaterThan(10);
    expect(words.filter((w) => html.includes(w))).toEqual([]);
  });

  it("shows no balance, and no dollar figure of any kind", () => {
    const figures = leakCandidates.filter((s) => !/[A-Za-z]/.test(s));
    expect(figures.length).toBeGreaterThan(20);
    expect(figures.filter((f) => html.includes(f))).toEqual([]);
    expect(html).not.toMatch(/\$\s?\d/);
  });

  it("shows no part of any secret value", () => {
    const fragments = secretFragments();
    expect(fragments.length).toBeGreaterThan(100);
    const hits = fragments.filter(([, f]) => html.includes(f)).map(([n, f]) => `${n}: ${f}`);
    expect(hits).toEqual([]);
  });
});
