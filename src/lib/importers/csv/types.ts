/**
 * CSV importer types.
 *
 * CSV bank exports have no shared schema — every bank ships a different column
 * layout. The importer takes a user-provided column mapping so each account
 * can remember its bank's flavor.
 */

export interface CsvColumnMapping {
  /** Header name (or 0-based index as a string) of the posted-date column. */
  readonly date: string;
  /** Header name of the amount column. Negative = debit, positive = credit. */
  readonly amount: string;
  /** Header name of the merchant / payee / description column. */
  readonly name: string;
  /** Optional secondary description column. */
  readonly memo?: string;
  /**
   * When the bank exports debit and credit as two separate columns instead of
   * one signed column, supply them here; `amount` is ignored if both are set.
   */
  readonly debit?: string;
  readonly credit?: string;
  /**
   * Optional explicit date format ('MM/DD/YYYY' | 'M/D/YYYY' | 'YYYY-MM-DD').
   * Falls back to auto-detection from the first row.
   */
  readonly dateFormat?: "MM/DD/YYYY" | "YYYY-MM-DD" | "M/D/YYYY";
  /**
   * When the CSV has no header row (e.g. M&T Bank), set this to false. All
   * column references in this mapping must then be **numeric indexes** as
   * strings ("0", "1", "2", ...) since there are no header names to match.
   * Defaults to true.
   */
  readonly hasHeader?: boolean;
}

export interface ParsedCsvRow {
  /** ISO YYYY-MM-DD. */
  readonly postedAt: string;
  /** Signed string amount (always present after normalization). */
  readonly amount: string;
  readonly name: string;
  readonly memo: string | null;
  /** SHA-256 hex of `${postedAt}|${amount}|${name}|${memo ?? ''}`. */
  readonly syntheticFitid: string;
  /** Original CSV row as a map of header → value (for the `raw` jsonb column). */
  readonly raw: Readonly<Record<string, string>>;
}

export interface ParsedCsv {
  readonly headers: readonly string[];
  readonly rows: readonly ParsedCsvRow[];
}

export class CsvParseError extends Error {
  constructor(
    message: string,
    readonly line?: number,
  ) {
    super(line === undefined ? message : `${message} (line ${line})`);
    this.name = "CsvParseError";
  }
}
