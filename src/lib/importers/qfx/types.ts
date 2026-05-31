/**
 * Normalized output of the QFX/OFX parser.
 *
 * Per ADR-006: amounts are kept as strings (never round-trip through Number),
 * and dates are normalized to ISO YYYY-MM-DD. The parser performs zero numeric
 * math — that's the importer normalizer's job, working through `Money`.
 */

export type OfxVersion = "1" | "2";

export interface ParsedQfxBalance {
  /** String amount, exactly as the bank reports it. */
  readonly amount: string;
  /** ISO YYYY-MM-DD. */
  readonly asOf: string;
}

export type OfxTransactionType =
  | "CREDIT"
  | "DEBIT"
  | "INT"
  | "DIV"
  | "FEE"
  | "SRVCHG"
  | "DEP"
  | "ATM"
  | "POS"
  | "XFER"
  | "CHECK"
  | "PAYMENT"
  | "CASH"
  | "DIRECTDEP"
  | "DIRECTDEBIT"
  | "REPEATPMT"
  | "HOLD"
  | "OTHER";

export interface ParsedQfxTransaction {
  /** Posted date, ISO YYYY-MM-DD. */
  readonly postedAt: string;
  /** Signed string amount (negative = debit/outflow). */
  readonly amount: string;
  /** OFX <FITID> — institution-unique transaction id. */
  readonly fitid: string;
  /** Display name / payee. */
  readonly name: string;
  /** Optional secondary description. */
  readonly memo: string | null;
  /** Raw OFX <TRNTYPE>; "OTHER" when missing or unknown. */
  readonly trnType: OfxTransactionType;
  /** Optional check number (printed checks only). */
  readonly checkNum: string | null;
}

export interface ParsedQfxStatement {
  /** Account number from OFX <ACCTID>; nullable for credit-card statements that nest it. */
  readonly accountId: string | null;
  /** Currency from <CURDEF>; defaults to USD when absent. */
  readonly currency: string;
  /** Statement period start, ISO YYYY-MM-DD. */
  readonly periodStart: string | null;
  /** Statement period end, ISO YYYY-MM-DD. */
  readonly periodEnd: string | null;
  /** Bank ledger balance — the reconciliation anchor. */
  readonly ledgerBalance: ParsedQfxBalance | null;
  /** Available balance — informational, not used for reconciliation. */
  readonly availableBalance: ParsedQfxBalance | null;
  readonly transactions: readonly ParsedQfxTransaction[];
}

export interface ParsedQfxHeader {
  readonly version: OfxVersion;
  readonly encoding: string | null;
  readonly charset: string | null;
}

export interface ParsedQfx {
  readonly header: ParsedQfxHeader;
  readonly statements: readonly ParsedQfxStatement[];
}

export class QfxParseError extends Error {
  constructor(
    message: string,
    readonly offset?: number,
  ) {
    super(offset === undefined ? message : `${message} (offset ${offset})`);
    this.name = "QfxParseError";
  }
}
