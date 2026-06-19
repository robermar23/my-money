import type { ParsedCsv } from "./csv/types.ts";
import type { ParsedQfx, ParsedQfxStatement } from "./qfx/types.ts";

/**
 * Normalize a payee/name into a stable grouping key.
 *
 * Used by the "review uncategorized" queue to group raw bank descriptions, and
 * by the inline "create rule from this payee" affordance to derive a regex that
 * matches the merchant rather than one specific charge. Uppercases, replaces
 * punctuation with spaces, drops standalone number tokens (store numbers,
 * reference ids), and collapses whitespace — so "STARBUCKS #123" and
 * "Starbucks 456" both normalize to "STARBUCKS".
 *
 * @param name - The raw transaction name / payee description.
 * @returns A normalized uppercase key. Falls back to the trimmed uppercase
 *   original when normalization would otherwise empty the string (e.g. a name
 *   that is purely digits).
 */
export function normalizePayee(name: string): string {
  const cleaned = name
    .toUpperCase()
    .replace(/[^A-Z0-9 ]+/g, " ")
    .replace(/\b\d+\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length > 0 ? cleaned : name.trim().toUpperCase();
}

/**
 * NormalizedTransaction — the single shape that flows from every importer
 * source into the `transactions` table. The categorizer and the persistence
 * step both consume this; they never see the raw parser output.
 */
export interface NormalizedTransaction {
  readonly fitid: string;
  readonly postedAt: string;
  readonly amount: string;
  readonly name: string;
  readonly memo: string | null;
  /** Raw parser record, captured for `transactions.raw` jsonb. */
  readonly raw: Record<string, unknown>;
}

export interface NormalizedBatch {
  readonly source: "qfx" | "csv";
  readonly statementStart: string | null;
  readonly statementEnd: string | null;
  readonly statementEndingBalance: string | null;
  readonly currency: string;
  readonly transactions: readonly NormalizedTransaction[];
  /** Parser-specific metadata for debugging + the `parser_metadata` jsonb column. */
  readonly metadata: Record<string, unknown>;
}

/**
 * Convert a parsed QFX into the normalized shape.
 *
 * If multiple statements appear in one file (rare for individual accounts), we
 * union the transactions and take the widest period; the ending balance comes
 * from the LAST statement's <LEDGERBAL>.
 */
export function qfxToNormalized(parsed: ParsedQfx): NormalizedBatch {
  if (parsed.statements.length === 0) {
    return {
      source: "qfx",
      statementStart: null,
      statementEnd: null,
      statementEndingBalance: null,
      currency: "USD",
      transactions: [],
      metadata: { ofxVersion: parsed.header.version },
    };
  }

  const allTxns: NormalizedTransaction[] = [];
  let minStart: string | null = null;
  let maxEnd: string | null = null;
  let lastStmt: ParsedQfxStatement | undefined;

  for (const stmt of parsed.statements) {
    lastStmt = stmt;
    if (stmt.periodStart && (!minStart || stmt.periodStart < minStart)) {
      minStart = stmt.periodStart;
    }
    if (stmt.periodEnd && (!maxEnd || stmt.periodEnd > maxEnd)) {
      maxEnd = stmt.periodEnd;
    }
    for (const t of stmt.transactions) {
      allTxns.push({
        fitid: t.fitid,
        postedAt: t.postedAt,
        amount: t.amount,
        name: t.name,
        memo: t.memo,
        raw: {
          source: "qfx",
          trnType: t.trnType,
          checkNum: t.checkNum,
          fitid: t.fitid,
          accountId: stmt.accountId,
        },
      });
    }
  }

  return {
    source: "qfx",
    statementStart: minStart,
    statementEnd: maxEnd,
    statementEndingBalance: lastStmt?.ledgerBalance?.amount ?? null,
    currency: lastStmt?.currency ?? "USD",
    transactions: allTxns,
    metadata: {
      ofxVersion: parsed.header.version,
      encoding: parsed.header.encoding,
      ledgerBalanceAsOf: lastStmt?.ledgerBalance?.asOf ?? null,
      statementCount: parsed.statements.length,
      institutionAccountId: lastStmt?.accountId ?? null,
    },
  };
}

/**
 * Convert a parsed CSV into the normalized shape.
 *
 * CSV doesn't carry ledger balance or statement period — those columns stay
 * null on the import_batches row and reconciliation falls back to the
 * "no-anchor" code path.
 */
export function csvToNormalized(parsed: ParsedCsv, currency = "USD"): NormalizedBatch {
  const transactions: NormalizedTransaction[] = parsed.rows.map((r) => ({
    fitid: r.syntheticFitid,
    postedAt: r.postedAt,
    amount: r.amount,
    name: r.name,
    memo: r.memo,
    raw: {
      source: "csv",
      row: r.raw,
    },
  }));

  return {
    source: "csv",
    statementStart: null,
    statementEnd: null,
    statementEndingBalance: null,
    currency,
    transactions,
    metadata: {
      headers: parsed.headers,
      rowCount: parsed.rows.length,
    },
  };
}
