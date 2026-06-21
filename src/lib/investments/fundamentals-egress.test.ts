// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * P9-08 — outbound-egress privacy assertion (ADR-020, CLAUDE.md §Privacy).
 *
 * The security-enrichment fetcher must send ONLY the ticker symbol upstream — no
 * quantities, balances, account names, or holdings. This is a static audit (a
 * grep over the fetcher source), mirroring the Plaid hardening audit: it fails
 * loudly the moment a user-data identifier appears in the market-data fetch path.
 */

const FETCHER = join(__dirname, "..", "prices", "yahoo-fundamentals.ts");
const SOURCE = readFileSync(FETCHER, "utf8");

/** Strip block + line comments so the scan covers executable code, not prose
 * (the privacy JSDoc legitimately names the very identifiers we forbid). */
const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

describe("P9-08 egress audit — fundamentals fetcher leaks no user data", () => {
  it("references no holdings/account/quantity/balance identifiers", () => {
    // Pure market-data module: it should know nothing about the user's positions.
    const forbidden: RegExp[] = [
      /\bholdings?\b/i,
      /\baccountId\b/,
      /\baccount_id\b/,
      /\baccounts\b/,
      /\bquantity\b/i,
      /\bbalance\b/i,
      /\bcostBasis\b/,
      /\bcost_basis\b/,
    ];
    const hits = forbidden.filter((p) => p.test(CODE)).map((p) => p.source);
    expect(hits, `forbidden identifier(s) in the fetcher: ${hits.join(", ")}`).toEqual([]);
  });

  it("does not import the database or schema (no path to user data)", () => {
    expect(SOURCE).not.toMatch(/@\/db\//);
    expect(SOURCE).not.toMatch(/db\/client/);
    expect(SOURCE).not.toMatch(/db\/schema/);
  });

  it("builds the request URL from the symbol parameter alone", () => {
    // The only interpolated value in the endpoint URL is the encoded symbol.
    expect(SOURCE).toMatch(/encodeURIComponent\(\s*symbol\s*,?\s*\)/);
  });
});
