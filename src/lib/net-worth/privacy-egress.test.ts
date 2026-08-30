// @vitest-environment node
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Money } from "@/lib/money/money.ts";
import { describe, expect, it } from "vitest";
import type { AmortizingLiability } from "./debt-principal.ts";
import { type DecomposeInput, decomposeNetWorth } from "./decompose.ts";
import type { DiagnosticAccount, DiagnosticInvestmentTxn } from "./diagnostics.ts";
import { type EndpointBreakdown, type EndpointItem, endpointsFor } from "./endpoints.ts";
import type { FlowTxn } from "./flow-types.ts";
import { summarySentence } from "./summary.ts";

/**
 * P17-27 — MANDATORY privacy regression for the net-worth attribution surface
 * (PLAN17 §Privacy, ADR-015/039, CLAUDE.md §Privacy & Data Sovereignty).
 *
 * Phase 17's egress budget is the same absolute as Phases 15 and 16: **zero**.
 * Nothing under `src/lib/net-worth/` makes or transitively imports an outbound
 * call on any code path, and — as with cash flow — there is no legitimate one to
 * make. Every figure the decomposition produces is a function of rows that
 * already exist in this household's Postgres, and every tolerance it applies is
 * a constant checked into this repo.
 *
 * That absolute is what makes an **allowlist** possible, and this file uses one
 * for the reason [cashflow/privacy-egress.test.ts](../cashflow/privacy-egress.test.ts)
 * and [advice/privacy-egress.test.ts](../advice/privacy-egress.test.ts) do: a
 * denylist fails open — it catches `axios` because somebody thought of `axios`,
 * and misses next year's HTTP client — while an allowlist fails closed.
 *
 * ── The temptation this phase carries, named ───────────────────────────────
 * Cash flow's was a hosted biller directory. Attribution's is a **benchmark**:
 * "your portfolio returned 4.1%, the S&P returned 6.2%" is one fetch away and
 * would make the `investment_return` rung markedly more useful. It is also the
 * exact shape of a request that says *this household holds these positions* to
 * a third party, one page load at a time. The `^GSPC` closes this phase might
 * want are **already cached** in `prices` by the nightly job (ADR-021), so the
 * rule is not "no benchmark ever" — it is that a benchmark arrives through the
 * existing price pipeline or not at all. There is a structural assertion below
 * that no module here reaches `@/lib/prices/`.
 *
 * Four further promises get pinned here:
 *
 *   1. **No balance, rung amount, delta or residual reaches a logger.** These
 *      land in `docker logs` and terminal scrollback, which is the same leak as
 *      printing the balance. Zero logger calls is the only rule simple enough
 *      to hold.
 *   2. **No diagnostic carries a payee string.** Diagnostics deliberately name
 *      *accounts* — "Sunwest Mortgage has no repayment terms" is the fix
 *      instruction, and an unnamed account is not actionable. They must never
 *      name a *merchant* or *person*, which is what `FlowTxn.name` holds and
 *      what the pairing and boundary rules read. The line between the two is
 *      asserted in both directions below.
 *   3. **This phase adds NO alert type**, so it contributes nothing at all to
 *      the content-free notification email (ADR-015). Asserted against the
 *      `AlertType` union rather than by inspection, so adding one later trips
 *      this rather than quietly widening the email's surface.
 *   4. **Nothing is stored** (ADR-039 §3). The phase creates no new PII because
 *      it creates no rows: no table, no migration, no job. A stored
 *      decomposition would be a second copy of a household's financial history
 *      with its own retention and its own backup exposure.
 *
 * Static source audit, with the same comment-stripping posture as every phase
 * before it, so the JSDoc documenting these guarantees cannot trip the scan that
 * enforces them.
 */

/** The zero-egress core: the pure rungs, the diagnostics, and the one DB reader. */
const NET_WORTH_DIR = __dirname;
const SRC = join(__dirname, "..", "..");
/** The attribution page and its client island. */
const PAGE_DIR = join(SRC, "app", "analysis", "networth");
/** The one-sentence pointer on `/analysis` (P17-23). */
const SENTENCE = join(SRC, "app", "analysis", "net-worth-sentence.tsx");
/** The waterfall's palette — the only other file this phase touched under `app/`. */
const CHART_COLORS = join(SRC, "app", "analysis", "chart-colors.ts");
/** The alert union, read to prove this phase did not extend it. */
const ALERT_RULES = join(SRC, "lib", "alerts", "rules.ts");

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

/** `src/lib/net-worth/` — the endpoints, the six rungs, the diagnostics, the loader. */
function netWorthCorePaths(): readonly string[] {
  return inDir(NET_WORTH_DIR);
}

/** Everything that touches a rung, a residual or an endpoint figure, core included. */
function allAttributionPaths(): readonly string[] {
  return [...netWorthCorePaths(), ...inDir(PAGE_DIR), SENTENCE, CHART_COLORS];
}

/**
 * Every module specifier a file imports, side-effect imports included.
 *
 * The `from` pattern is tightened past the P15-39 template's, for the same
 * reason P16-36 tightened it: a preceding quote, word character or dot
 * disqualifies the match, so `assertWindow(input.from, input.to, …)` — which
 * appears in half the modules here — does not read as an import of everything
 * up to the next quote.
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

describe("P17-27 — the attribution layer imports nothing that could reach the network", () => {
  /**
   * The complete set of non-relative specifiers `src/lib/net-worth/` may import.
   *
   * Every entry is local by construction: Postgres access, in-repo pure math,
   * the in-repo amortization schedule, and the in-repo holdings valuation. There
   * is no HTTP client, no SDK, no market-data vendor, and no way to add one
   * without editing this list — which is the point.
   */
  const ALLOWED_SPECIFIERS: readonly string[] = [
    // Packages.
    "decimal.js", // the mandated money arithmetic (CLAUDE.md §Money)
    "drizzle-orm", // query builder; the driver is the app's existing pool
    "server-only", // a build-time guard, not a runtime dependency
    // In-repo modules.
    "@/db/client.ts",
    "@/db/schema/categories.ts",
    "@/db/schema/index.ts",
    "@/lib/advice/types.ts", // the `InputUsed` audit-trail shape (ADR-039 §5)
    "@/lib/holdings/value.ts",
    "@/lib/investments/performance.ts",
    "@/lib/money/money.ts",
    "@/lib/mortgage/amortization.ts",
    "@/lib/schedule/occurrences.ts",
  ];

  it("audits a non-empty set of attribution modules", () => {
    // Guards against the whole suite passing vacuously if a directory moves or
    // a filter starts excluding everything.
    const paths = netWorthCorePaths();
    expect(paths.length).toBeGreaterThan(14);
    for (const expected of [
      "endpoints.ts", // the given figures — ADR-039 §1
      "boundary.ts", // what counts as crossing the household line
      "pairing.ts", // transfer detection, which reads payee text
      "saved.ts",
      "retirement.ts",
      "debt-principal.ts",
      "investment-return.ts",
      "asset-revaluation.ts",
      "decompose.ts", // the assembler and the identity
      "diagnostics.ts", // where a payee string would leak if anywhere
      "status.ts",
      "summary.ts",
      "attribution-loader.ts", // the one DB reader
      "compute.ts", // the endpoints' source of truth
    ]) {
      expect(
        paths.some((p) => p.endsWith(expected)),
        `missing ${expected}`,
      ).toBe(true);
    }
    // And the delivery surface actually resolved to files.
    expect(allAttributionPaths().length).toBeGreaterThan(paths.length + 3);
  });

  it("imports only from the allowlist — anything new must be justified here", () => {
    for (const path of netWorthCorePaths()) {
      for (const specifier of importsOf(code(path))) {
        if (specifier.startsWith(".")) continue; // within the attribution layer
        expect(
          ALLOWED_SPECIFIERS,
          `${path} imports "${specifier}", which is not on the zero-egress allowlist`,
        ).toContain(specifier);
      }
    }
  });

  it("never calls fetch, and names no external host", () => {
    // Not "no fetch to an absolute URL" as in Phases 11-14 — no fetch at all.
    // Attribution has no legitimate outbound call, so zero is checkable.
    for (const path of netWorthCorePaths()) {
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

  it("reaches no market-data fetcher, even the app's own", () => {
    // The benchmark temptation, closed structurally. `@/lib/prices/` holds the
    // Yahoo and CoinGecko clients; the nightly job is the ONLY caller, and what
    // it writes into `prices` is what this layer may read (ADR-021). A rung that
    // imported a fetcher directly would turn a page load into an outbound
    // request that names this household's positions.
    for (const path of allAttributionPaths()) {
      const importLines = importsOf(code(path)).join("\n");
      expect(importLines, `${path} imports a price fetcher`).not.toMatch(/@\/lib\/prices\//);
      expect(importLines, `${path} imports the Plaid client`).not.toMatch(/@\/lib\/plaid\//);
    }
  });

  it("no attribution surface reaches the network either", () => {
    // The page, the island and the sentence are thinner, so a denylist suffices
    // — they legitimately import React, Next and Recharts.
    const FORBIDDEN: readonly RegExp[] = [
      /\baxios\b/,
      /\bundici\b/,
      /node-fetch/,
      /\bgot\b/,
      /yahoo-finance/i,
      /coingecko/i,
      /alphavantage/i,
      // Any hosted model. A decomposition is an accounting identity with a
      // named residual; "ask a model why net worth moved" would be both an
      // egress violation and an unfalsifiable answer where a checkable one
      // already exists.
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
    for (const path of allAttributionPaths()) {
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

describe("P17-27 — no attribution figure reaches a logger", () => {
  /** Identifiers that are, or directly carry, a figure about this household. */
  const FIGURE_IDENTIFIERS: readonly RegExp[] = [
    /\bbalance\w*\b/i,
    /\bopening\b/i,
    /\bclosing\b/i,
    /\bdelta\b/i,
    /\bresidual\w*\b/i,
    /\bunexplained\b/i,
    /\bamount\b/i,
    /\bmagnitude\b/i,
    /\btotal\b/i,
    /\bnetWorth\b/i,
    /\bquantity\b/i,
    /\bprincipal\w*\b/i,
    /\bname\b/i,
    /\blabel\b/i,
  ];

  it("the attribution surface makes no logger calls at all", () => {
    // "Your net worth is $412,000 and $18,000 of the change is unexplained" in a
    // log file is the same leak as printing the balance, and it lands somewhere
    // `docker logs` and terminal scrollback can carry it. This layer has no
    // unattended caller — it runs on a page load and returns a value — so there
    // is nothing it legitimately needs to say.
    for (const path of allAttributionPaths()) {
      const calls = code(path).match(/console\.\w+\s*\(/g) ?? [];
      expect(calls, `${path} logs from the attribution surface`).toEqual([]);
    }
  });

  it("would catch a figure being logged if a call were ever added", () => {
    // Belt-and-braces: if a logger call is ever introduced, this is the
    // assertion that has to be reckoned with rather than deleted wholesale.
    for (const path of allAttributionPaths()) {
      for (const call of code(path).match(/console\.\w+\([^)]*\)/g) ?? []) {
        for (const pattern of FIGURE_IDENTIFIERS) {
          expect(call, `${path} logs an attribution identifier: ${call}`).not.toMatch(pattern);
        }
      }
    }
  });
});

describe("P17-27 — this phase adds no alert type and no stored row", () => {
  it("the AlertType union gained nothing for attribution", () => {
    // ADR-015: the notification email carries a count, a date and a link, and
    // never a figure. Phase 17 keeps that promise the strongest way available —
    // by adding no alert at all, so there is no new `detail` to leak. Asserted
    // against the union rather than by inspection, because the day someone adds
    // `"net_worth_unexplained"` the email's surface widens silently otherwise.
    const union = code(ALERT_RULES).match(/export type AlertType =[\s\S]*?;/)?.[0] ?? "";
    expect(union, "the AlertType union could not be read").toContain("large_transaction");
    for (const pattern of [
      /attribution/i,
      /net_?worth/i,
      /unexplained/i,
      /residual/i,
      /rung/i,
      /revaluation/i,
    ]) {
      expect(union, `AlertType gained an attribution member: ${pattern.source}`).not.toMatch(
        pattern,
      );
    }
  });

  it("nothing in the attribution layer imports the alert or mail machinery", () => {
    // The allowlist already forbids it for the core; this states it for the
    // whole surface and by name, so a future reader sees the intent rather than
    // inferring it from an omission.
    for (const path of allAttributionPaths()) {
      const importLines = importsOf(code(path)).join("\n");
      expect(importLines, `${path} imports the alert machinery`).not.toMatch(/@\/lib\/alerts\//);
      expect(importLines, `${path} imports the mailer`).not.toMatch(/nodemailer|@\/lib\/mail/);
    }
  });

  it("writes nothing: no INSERT, UPDATE, DELETE or job registration (ADR-039 §3)", () => {
    // The phase creates no new PII because it creates no rows. A stored
    // decomposition would also be a cache of a derivation over data the user
    // edits — recategorize one transaction and every stored row is stale — but
    // the privacy half is the one this test is for: a second copy of a
    // household's financial history carries its own retention and its own
    // backup exposure.
    for (const path of allAttributionPaths()) {
      const src = code(path);
      expect(src, `${path} writes to the database`).not.toMatch(
        /\bdb\s*\.\s*(?:insert|update|delete)\b/,
      );
      expect(src, `${path} registers a queue or a job`).not.toMatch(/\bnew\s+(?:Queue|Worker)\b/);
    }
  });
});

// ── The behavioural half: what a diagnostic may and may not name ─────────────

const CURRENCY = "USD";
const WINDOW = { from: "2026-01-01", to: "2026-03-31" } as const;

/**
 * Strings that exist ONLY in the seeded payee text. Deliberately the kinds of
 * descriptor a real book carries — a person, a clinic, a landlord — because the
 * point is not that some token is absent but that *these* are.
 */
const PAYEES = {
  therapist: "DR HALLORAN COUNSELING LLC",
  person: "VENMO PAYMENT MARISOL R",
  landlord: "RAVENSWOOD PROPERTY MGMT",
  clinic: "PLANNED PARENTHOOD OF WNY",
} as const;

/** An account name, which diagnostics DO carry — the fix instruction needs it. */
const LOAN_ACCOUNT_NAME = "Sunwest Mortgage";

function item(
  accountId: string,
  accountType: string,
  balance: string,
  accountName = accountId,
): EndpointItem {
  return { accountId, accountName, accountType, currency: CURRENCY, balance };
}

function breakdown(asOf: string, items: readonly EndpointItem[]): EndpointBreakdown {
  return {
    asOf,
    total: Money.sum(
      items.map((i) => Money.fromString(i.balance, CURRENCY)),
      CURRENCY,
    ).toString(),
    items,
  };
}

/**
 * A book that trips as many diagnostics at once as one window can:
 * uncategorized flows, an unpaired transfer, an untracked loan, a stale
 * snapshot, a manual-balance account, an unmatched investment deposit, and
 * quantity drift. Every transaction carries a payee from {@link PAYEES}.
 */
function leakyBook(): DecomposeInput {
  const opening: EndpointItem[] = [
    item("chk", "depository", "10000.00", "Everyday Checking"),
    item("mtg", "loan", "-274315.67", LOAN_ACCOUNT_NAME),
    item("brk", "investment", "50000.00", "Fidelity Brokerage"),
    item("home", "property", "412000.00", "The house"),
  ];
  const closing: EndpointItem[] = [
    item("chk", "depository", "7200.00", "Everyday Checking"),
    item("mtg", "loan", "-273421.45", LOAN_ACCOUNT_NAME),
    item("brk", "investment", "56000.00", "Fidelity Brokerage"),
    item("home", "property", "425000.00", "The house"),
  ];

  const txns: FlowTxn[] = [
    // Uncategorized — the `uncategorized` diagnostic counts it.
    {
      id: "t1",
      accountId: "chk",
      postedAt: "2026-01-14",
      amount: "-180.00",
      name: PAYEES.therapist,
      categoryId: null,
      categoryKind: null,
    },
    {
      id: "t2",
      accountId: "chk",
      postedAt: "2026-02-02",
      amount: "-95.00",
      name: PAYEES.clinic,
      categoryId: null,
      categoryKind: null,
    },
    // A transfer with no matching leg — the `unpaired_transfers` diagnostic.
    {
      id: "t3",
      accountId: "chk",
      postedAt: "2026-02-10",
      amount: "-1200.00",
      name: PAYEES.person,
      categoryId: "c-transfer",
      categoryKind: "transfer",
    },
    {
      id: "t4",
      accountId: "chk",
      postedAt: "2026-03-01",
      amount: "-1850.00",
      name: PAYEES.landlord,
      categoryId: "c-rent",
      categoryKind: "expense",
    },
  ];

  // A deposit into the brokerage with no matching withdrawal — the
  // `unmatched_investment_deposits` diagnostic. `manual`, not `income`, so it
  // is not the payroll-direct rung.
  const investmentTxns: DiagnosticInvestmentTxn[] = [
    {
      accountId: "brk",
      date: "2026-02-20",
      type: "deposit",
      subtype: null,
      amount: "3000.00",
      source: "manual",
    },
  ];

  // The loan has NO liabilities row → `untracked_loan`, which is the diagnostic
  // that names an account out loud.
  const liabilities: AmortizingLiability[] = [];

  const accounts: DiagnosticAccount[] = [
    {
      accountId: "chk",
      accountName: "Everyday Checking",
      accountType: "depository",
      hasLiabilityRow: false,
      openingSnapshotDate: WINDOW.from,
      closingSnapshotDate: WINDOW.to,
    },
    {
      accountId: "mtg",
      accountName: LOAN_ACCOUNT_NAME,
      accountType: "loan",
      hasLiabilityRow: false,
      openingSnapshotDate: WINDOW.from,
      closingSnapshotDate: WINDOW.to,
    },
    {
      accountId: "brk",
      accountName: "Fidelity Brokerage",
      accountType: "investment",
      hasLiabilityRow: false,
      openingSnapshotDate: WINDOW.from,
      closingSnapshotDate: WINDOW.to,
    },
    // A property whose value moved with no transaction behind it, last recorded
    // long before the window opened → `manual_balance_accounts` + `snapshot_gap`.
    {
      accountId: "home",
      accountName: "The house",
      accountType: "property",
      hasLiabilityRow: false,
      openingSnapshotDate: "2025-06-01",
      closingSnapshotDate: "2025-06-01",
    },
  ];

  return {
    endpoints: endpointsFor(
      breakdown(WINDOW.from, opening),
      breakdown(WINDOW.to, closing),
      CURRENCY,
    ),
    accounts,
    txns,
    liabilities,
    investmentTxns,
    // A holding with no opening quantity recorded → the ADR-039 §2 drift note.
    holdings: [
      {
        holdingId: "h1",
        accountId: "brk",
        symbol: "VTI",
        currentQuantity: "120.00000000",
        openingQuantity: null,
        openingValue: null,
      },
    ],
    firstSnapshotDate: "2020-01-01",
    currency: CURRENCY,
  };
}

describe("P17-27 — a diagnostic names accounts, never payees", () => {
  const result = decomposeNetWorth(leakyBook());

  it("trips a broad set of diagnostics, so the leak checks are not vacuous", () => {
    // Without this, a decomposition that silently produced zero diagnostics
    // would pass every assertion below by having nothing to say.
    const codes = result.diagnostics.map((d) => d.code);
    expect(codes.length).toBeGreaterThanOrEqual(4);
    for (const expected of ["uncategorized", "unpaired_transfers", "untracked_loan"] as const) {
      expect(codes, `expected the ${expected} diagnostic`).toContain(expected);
    }
  });

  it("no payee string appears anywhere in the decomposition", () => {
    // Every string the page can render, flattened: rung labels, the audit trail
    // (`InputUsed.label` / `.source` / `.value`), and every diagnostic's label
    // and detail. A payee reaching any of them would put a therapist, a clinic
    // and a person's name on a page that is about *balances*, and — worse —
    // into the one part of this app that gets screenshotted and shared.
    const rendered = JSON.stringify(result);
    for (const [role, payee] of Object.entries(PAYEES)) {
      expect(rendered, `the decomposition leaked the ${role} payee`).not.toContain(payee);
      // Tokens too: a diagnostic that "helpfully" listed the largest
      // uncategorized merchant would fail on the whole string above, but a
      // truncated or normalized one would not.
      for (const token of payee.split(/[\s.]+/).filter((t) => t.length >= 6)) {
        expect(rendered, `the decomposition leaked the token "${token}"`).not.toContain(token);
      }
    }
  });

  it("the summary sentence is the same, at every threshold", () => {
    // The sentence names a rung and a figure. It reads `result.rungs`, never the
    // flows behind them, and this pins that the indirection holds.
    const rendered = JSON.stringify(summarySentence(result, CURRENCY));
    for (const payee of Object.values(PAYEES)) {
      expect(rendered, `the summary leaked "${payee}"`).not.toContain(payee);
    }
  });

  it("but an account name IS carried, because the fix instruction needs one", () => {
    // The other half of the line, asserted on purpose. "One loan account has no
    // repayment terms" is not actionable; naming it is. This is not an
    // oversight to be hardened away later — an account name is the household's
    // own label for its own account, shown to the household on its own page,
    // and stripping it would make the diagnostic useless while protecting
    // nobody from anything.
    const untracked = result.diagnostics.find((d) => d.code === "untracked_loan");
    expect(untracked, "expected the untracked_loan diagnostic").toBeDefined();
    expect(untracked?.detail).toContain(LOAN_ACCOUNT_NAME);
  });

  it("carries no household member label", () => {
    // Phase 15 introduced named household members (`household_members.label`),
    // and Phase 17 has no business reading them: a net-worth change is a
    // household-level figure with no per-person attribution, and inventing one
    // would be both a new inference and a new thing to leak. Structural,
    // because there is nothing to test behaviourally — the layer never loads
    // them, and this is what keeps it that way.
    for (const path of allAttributionPaths()) {
      const src = code(path);
      expect(src, `${path} reads household members`).not.toMatch(
        /householdMembers|household_members/,
      );
    }
  });
});
