// @vitest-environment node
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, it } from "vitest";

/**
 * P4-36 — Backend security hardening audit.
 *
 * Static-analysis regression tests that codify the §Plaid Safety Rules from
 * CLAUDE.md and the threat model in [docs/THREAT_MODEL_PLAID.md]. Each test
 * here is a grep over `src/` that fails the moment an invariant breaks:
 *
 *   1. Plaid SDK callsites — only server-side surfaces (actions / route
 *      handlers / workers), never inside a `'use client'` file.
 *   2. `process.env.PLAID_*` reads — only inside `src/lib/plaid/`.
 *   3. `decrypt(` callsites — only inside the crypto barrier and the
 *      single-allowed token reader.
 *   4. Sensitive logging — `console.log/error/warn` callsites in the Plaid
 *      surface MUST NOT include the access-token variable, the
 *      `Plaid-Verification` header, the ciphertext, or raw account masks.
 *
 * Items already covered by behavioral tests are NOT duplicated here:
 *   - Webhook body cap → [route.test.ts] (413 / 400 paths).
 *   - Webhook rate limit → [route.test.ts] (429 paths).
 *   - Ciphertext column visibility → [tokens.test.ts] visibility regression.
 *   - Webhook signature verification → [webhook-verify.test.ts].
 *
 * These are pure file-tree audits — no DB, no network. Cheap and loud.
 */

const REPO_ROOT = join(__dirname, "..", "..", "..");
const SRC_ROOT = join(REPO_ROOT, "src");

function walkTsFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkTsFiles(full, acc);
    } else if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name)) {
      acc.push(full);
    }
  }
  return acc;
}

function asRel(absolute: string): string {
  return relative(REPO_ROOT, absolute);
}

function relAllow(paths: string[]): Set<string> {
  return new Set(paths.map((p) => p.split("/").join(sep)));
}

interface Violation {
  file: string;
  line: number;
  text: string;
}

function scanLines(
  files: string[],
  predicate: (line: string, file: string) => boolean,
  options: { allowlist?: Set<string> } = {},
): Violation[] {
  const violators: Violation[] = [];
  for (const absolute of files) {
    const rel = asRel(absolute);
    if (options.allowlist?.has(rel)) continue;
    const contents = readFileSync(absolute, "utf8");
    const lines = contents.split(/\r?\n/);
    lines.forEach((line, idx) => {
      if (predicate(line, rel)) {
        violators.push({ file: rel, line: idx + 1, text: line.trim() });
      }
    });
  }
  return violators;
}

function fmt(violators: Violation[]): string {
  return violators.map((v) => `  ${v.file}:${v.line}  ${v.text}`).join("\n");
}

const ALL_TS_FILES = walkTsFiles(SRC_ROOT);

/* ---------------------------------------------------------------------------
 * Audit 1 — Plaid SDK callsites stay server-side
 * --------------------------------------------------------------------------- */

describe("P4-36 audit — Plaid SDK never reaches client bundles", () => {
  it("no `'use client'` file imports plaidClient or @/lib/plaid/client", () => {
    const clientFiles = ALL_TS_FILES.filter((abs) => {
      const head = readFileSync(abs, "utf8").slice(0, 200);
      return /^['"]use client['"];?/m.test(head);
    });

    const offending = scanLines(clientFiles, (line) => {
      // Any reference to plaidClient OR import path. The literal column tests
      // for an import statement, the symbol test catches inline references.
      if (/@\/lib\/plaid\/client/.test(line)) return true;
      if (/\bplaidClient\b/.test(line)) return true;
      if (/from\s+["']plaid["']/.test(line)) return true;
      return false;
    });

    if (offending.length > 0) {
      throw new Error(
        `Plaid SDK callsite found in a 'use client' file (server-only invariant violated):\n${fmt(
          offending,
        )}\n\nMove the call into a server action, route handler, or BullMQ worker.`,
      );
    }
  });

  it("the plaid npm SDK is only imported from server-side surfaces", () => {
    // The plaid SDK should be reachable from: src/lib/plaid/, src/worker/jobs/,
    // src/app/api/, server actions (src/app/**/actions.ts), and tests.
    const offending = scanLines(ALL_TS_FILES, (line, file) => {
      if (!/from\s+["']plaid["']/.test(line)) return false;
      if (/\.test\.ts$/.test(file)) return false;
      if (file.includes(`${sep}lib${sep}plaid${sep}`)) return false;
      if (file.includes(`${sep}worker${sep}jobs${sep}`)) return false;
      if (file.includes(`${sep}app${sep}api${sep}`)) return false;
      if (/actions\.ts$/.test(file)) return false;
      if (/actions\.tsx$/.test(file)) return false;
      return true;
    });

    if (offending.length > 0) {
      throw new Error(
        `Direct \`from "plaid"\` import found in a non-server-side file:\n${fmt(
          offending,
        )}\n\nRoute the call through src/lib/plaid/client.ts instead.`,
      );
    }
  });
});

/* ---------------------------------------------------------------------------
 * Audit 2 — process.env.PLAID_* is read only inside src/lib/plaid/
 * --------------------------------------------------------------------------- */

describe("P4-36 audit — PLAID_* env vars are read only from src/lib/plaid/", () => {
  it("no `process.env.PLAID_*` reference exists outside src/lib/plaid/", () => {
    const offending = scanLines(ALL_TS_FILES, (line, file) => {
      if (!/process\.env\.PLAID_/.test(line)) return false;
      if (file.includes(`${sep}lib${sep}plaid${sep}`)) return false;
      return true;
    });

    if (offending.length > 0) {
      throw new Error(
        `process.env.PLAID_* read outside src/lib/plaid/:\n${fmt(
          offending,
        )}\n\nAdd a helper in src/lib/plaid/client.ts (see plaidWebhookUrl) and call it from there.`,
      );
    }
  });
});

/* ---------------------------------------------------------------------------
 * Audit 3 — decrypt() callsites stay inside the encryption barrier
 * --------------------------------------------------------------------------- */

describe("P4-36 audit — decrypt() callsites are single-reader", () => {
  it("the AEAD `decrypt` function is only called from src/lib/plaid/tokens.ts", () => {
    // Allow the definition site, the only allowed caller (tokens.ts), and the
    // crypto test file. Test files in src/lib/plaid/ are allowed since they
    // exercise the barrier intentionally; they are explicitly listed for clarity.
    const allowlist = relAllow([
      "src/lib/crypto/aead.ts", // definition site (line: export function decrypt)
      "src/lib/crypto/aead.test.ts", // crypto-level tests of decrypt
      "src/lib/plaid/tokens.ts", // sole production caller — guarded by single-reader
      "src/lib/plaid/tokens.test.ts", // exercises tokens.ts (mentions decrypt in a comment)
      "src/lib/plaid/hardening-audit.test.ts", // this file — references decrypt() in describe + error strings
    ]);

    // Match function-call shape: `decrypt(` preceded by start-of-line,
    // whitespace, `=`, `.`, `(`, `,`, `!`, `?`, `:`, `>` — i.e. not a definition.
    // Filter out the definition `export function decrypt(` separately by
    // requiring the file is not in the allowlist.
    const offending = scanLines(
      ALL_TS_FILES,
      (line) => {
        // Skip declaration lines + import lines.
        if (/^\s*(\/\/|\*)/.test(line)) return false; // comments
        if (/function\s+decrypt\s*\(/.test(line)) return false; // definition
        if (/import\b/.test(line)) return false;
        if (/^\s*export\b/.test(line)) return false; // re-exports
        // Function-call: a `decrypt(` that isn't a name like `decryptWithKey(`.
        return /\bdecrypt\(/.test(line) && !/\bdecryptWithKey\(/.test(line);
      },
      { allowlist },
    );

    if (offending.length > 0) {
      throw new Error(
        `decrypt() called outside the allowed barrier:\n${fmt(offending)}\n\nDecryption must go through loadAccessToken in src/lib/plaid/tokens.ts. If you genuinely need a new path, add it to the allowlist here AND document why in tokens.ts.`,
      );
    }
  });
});

/* ---------------------------------------------------------------------------
 * Audit 4 — sensitive-data logging in the Plaid surface is forbidden
 * --------------------------------------------------------------------------- */

describe("P4-36 audit — Plaid surface logs do not leak secrets", () => {
  /**
   * Files to audit: src/lib/plaid/, src/app/api/plaid/, and ALL of
   * src/worker/jobs/ (P5-27 widened this from just sync-plaid-item.ts to the
   * whole jobs dir, so sync-investments-item.ts — and any future Plaid worker —
   * is covered without a per-file allowlist edit). Excludes test files (they
   * often log inputs deliberately) and the rate-limit module (IP buckets only).
   */
  const SCAN_PATHS = ALL_TS_FILES.filter((abs) => {
    const rel = asRel(abs);
    if (/\.test\.ts$/.test(rel)) return false;
    return (
      rel.startsWith(["src", "lib", "plaid"].join(sep)) ||
      rel.startsWith(["src", "app", "api", "plaid"].join(sep)) ||
      rel.startsWith(["src", "worker", "jobs"].join(sep))
    );
  });

  it("no console.log/error/warn callsite references accessToken, Plaid-Verification, or raw ciphertext", () => {
    // Collect lines that look like a logger call. Multi-line template literals
    // would need a more sophisticated parser; in practice every existing
    // console.* call in this surface is single-line.
    const forbidden = [
      /accessToken\b/,
      /access_token\b/,
      /Plaid-Verification/i,
      /accessTokenCiphertext/,
      /access_token_ciphertext/,
      /publicToken\b/,
      /public_token\b/,
    ];

    const offending = scanLines(SCAN_PATHS, (line) => {
      // Identify a console.* callsite on the same line.
      if (!/console\.(log|error|warn|info|debug)\(/.test(line)) return false;
      return forbidden.some((p) => p.test(line));
    });

    if (offending.length > 0) {
      throw new Error(
        `console.* in the Plaid surface references a secret-bearing variable:\n${fmt(
          offending,
        )}\n\nRedact the field before logging — see redactPlaidError in actions.ts for the pattern.`,
      );
    }
  });

  it("no Plaid-surface file logs a plaid_mask via console.* (last-4 leakage)", () => {
    const offending = scanLines(SCAN_PATHS, (line) => {
      if (!/console\.(log|error|warn|info|debug)\(/.test(line)) return false;
      return /\bplaidMask\b/.test(line) || /\bplaid_mask\b/.test(line);
    });

    if (offending.length > 0) {
      throw new Error(
        `plaid_mask referenced in a console.* callsite (last-4 digits):\n${fmt(
          offending,
        )}\n\nMasks are display-only; don't write them to logs that could be aggregated.`,
      );
    }
  });
});
