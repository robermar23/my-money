import { createHash } from "node:crypto";
import {
  type CsvColumnMapping,
  CsvParseError,
  type ParsedCsv,
  type ParsedCsvRow,
} from "./types.ts";

/**
 * Parse a CSV bank export into normalized rows.
 *
 * Per ADR-006 / CLAUDE.md §Money & Numeric Precision: amounts stay as strings.
 * We strip currency symbols and thousands separators but otherwise pass the
 * value through unmodified.
 *
 * Synthetic FITID: SHA-256 of `${postedAt}|${amount}|${name}|${memo ?? ''}`.
 * Two real transactions that happen to hash the same collide on the database's
 * UNIQUE (account_id, fitid) — the importer surfaces this as a duplicate;
 * the user can disambiguate by editing the name/memo in the source file.
 */
export function parseCsv(input: Buffer | string, mapping: CsvColumnMapping): ParsedCsv {
  const text = typeof input === "string" ? input : input.toString("utf8");
  const lines = splitLines(text);
  if (lines.length === 0) {
    throw new CsvParseError("Empty CSV");
  }

  const hasHeader = mapping.hasHeader !== false;

  // For headerless CSV (e.g. M&T Bank) we synthesize headers ("col_0", "col_1", ...)
  // by peeking at the column count of the first non-empty row. The user-supplied
  // mapping must then reference columns by numeric index string ("0", "1", ...).
  let headers: string[];
  let firstDataLineIndex: number;
  if (hasHeader) {
    const headerCells = parseCsvRow(lines[0] ?? "", 1);
    headers = headerCells.map((h) => h.trim());
    firstDataLineIndex = 1;
  } else {
    const firstNonEmpty = lines.find((l) => l.trim().length > 0) ?? "";
    const sample = parseCsvRow(firstNonEmpty, 1);
    headers = sample.map((_, i) => `col_${i}`);
    firstDataLineIndex = 0;
  }

  const dateIdx = columnIndex(headers, mapping.date, "date", hasHeader);
  const nameIdx = columnIndex(headers, mapping.name, "name", hasHeader);
  const memoIdx = mapping.memo ? columnIndex(headers, mapping.memo, "memo", hasHeader) : -1;
  const amountIdx = mapping.amount ? lookupIndex(headers, mapping.amount) : -1;
  const debitIdx = mapping.debit ? lookupIndex(headers, mapping.debit) : -1;
  const creditIdx = mapping.credit ? lookupIndex(headers, mapping.credit) : -1;

  if (amountIdx === -1 && (debitIdx === -1 || creditIdx === -1)) {
    throw new CsvParseError(
      "Column mapping must provide either `amount` or both `debit` and `credit`",
    );
  }

  const rows: ParsedCsvRow[] = [];
  for (let li = firstDataLineIndex; li < lines.length; li++) {
    const raw = lines[li];
    if (!raw || raw.trim().length === 0) continue;
    const cells = parseCsvRow(raw, li + 1);
    if (cells.every((c) => c.trim().length === 0)) continue;

    const row: Record<string, string> = {};
    for (let ci = 0; ci < Math.max(headers.length, cells.length); ci++) {
      const key = headers[ci] ?? `col_${ci}`;
      row[key] = (cells[ci] ?? "").trim();
    }

    const rawDate = (cells[dateIdx] ?? "").trim();
    const postedAt = normalizeDate(rawDate, mapping.dateFormat);
    if (!postedAt) {
      throw new CsvParseError(`Unparseable date '${rawDate}'`, li + 1);
    }

    const name = (cells[nameIdx] ?? "").trim() || "(no name)";
    const memo = memoIdx >= 0 ? (cells[memoIdx] ?? "").trim() || null : null;

    let amount: string;
    if (amountIdx >= 0) {
      const raw = (cells[amountIdx] ?? "").trim();
      amount = normalizeAmount(raw, li + 1);
    } else {
      const debit = (cells[debitIdx] ?? "").trim();
      const credit = (cells[creditIdx] ?? "").trim();
      if (debit && credit) {
        throw new CsvParseError("Row has both debit and credit populated", li + 1);
      }
      if (debit) {
        const v = normalizeAmount(debit, li + 1);
        amount = v.startsWith("-") ? v : `-${v}`;
      } else if (credit) {
        amount = normalizeAmount(credit, li + 1);
      } else {
        throw new CsvParseError("Row missing both debit and credit", li + 1);
      }
    }

    const syntheticFitid = createHash("sha256")
      .update(`${postedAt}|${amount}|${name}|${memo ?? ""}`)
      .digest("hex");

    rows.push({ postedAt, amount, name, memo, syntheticFitid, raw: row });
  }

  return { headers, rows };
}

function lookupIndex(headers: readonly string[], key: string): number {
  // Support either a header name or a numeric index string.
  if (/^\d+$/.test(key)) {
    const i = Number.parseInt(key, 10);
    return i >= 0 && i < headers.length ? i : -1;
  }
  const target = key.trim().toLowerCase();
  for (let i = 0; i < headers.length; i++) {
    if ((headers[i] ?? "").trim().toLowerCase() === target) return i;
  }
  return -1;
}

function columnIndex(
  headers: readonly string[],
  key: string,
  label: string,
  hasHeader: boolean,
): number {
  const i = lookupIndex(headers, key);
  if (i === -1) {
    const hint = hasHeader
      ? "not found in headers"
      : 'headerless CSV requires numeric column indexes (e.g. "0", "1", "2")';
    throw new CsvParseError(`CSV column '${key}' (${label}) ${hint}`);
  }
  return i;
}

function splitLines(text: string): string[] {
  // CSV may contain quoted newlines; split smartly.
  const lines: string[] = [];
  let buf = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      // Toggle quote state, but a doubled "" inside a quoted field stays inside.
      if (inQuotes && text[i + 1] === '"') {
        buf += '""';
        i++;
        continue;
      }
      inQuotes = !inQuotes;
      buf += ch;
      continue;
    }
    if (!inQuotes && (ch === "\n" || ch === "\r")) {
      lines.push(buf);
      buf = "";
      // Skip the second char of CRLF.
      if (ch === "\r" && text[i + 1] === "\n") i++;
      continue;
    }
    buf += ch;
  }
  if (buf.length > 0) lines.push(buf);
  return lines;
}

function parseCsvRow(line: string, lineNo: number): string[] {
  const cells: string[] = [];
  let buf = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        buf += '"';
        i++;
        continue;
      }
      inQuotes = !inQuotes;
      continue;
    }
    if (ch === "," && !inQuotes) {
      cells.push(buf);
      buf = "";
      continue;
    }
    buf += ch;
  }
  if (inQuotes) {
    throw new CsvParseError("Unterminated quoted field", lineNo);
  }
  cells.push(buf);
  return cells;
}

function normalizeAmount(raw: string, lineNo: number): string {
  // Accept "$1,234.56", "(1234.56)" (accountants negative), "1234.56".
  let v = raw.replace(/[$\s]/g, "").replace(/,/g, "");
  if (!v) return "0";
  // Parens = negative.
  if (v.startsWith("(") && v.endsWith(")")) {
    v = `-${v.slice(1, -1)}`;
  }
  if (!/^-?\d+(\.\d+)?$/.test(v)) {
    throw new CsvParseError(`Invalid amount '${raw}'`, lineNo);
  }
  return v;
}

function normalizeDate(raw: string, hint?: CsvColumnMapping["dateFormat"]): string | null {
  if (!raw) return null;

  // Explicit format.
  if (hint === "YYYY-MM-DD") {
    const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
  }
  if (hint === "MM/DD/YYYY" || hint === "M/D/YYYY") {
    const m = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (!m) return null;
    return `${m[3]}-${pad2(m[1] ?? "")}-${pad2(m[2] ?? "")}`;
  }

  // Auto-detect.
  let m = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return `${m[1]}-${pad2(m[2] ?? "")}-${pad2(m[3] ?? "")}`;
  m = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${pad2(m[1] ?? "")}-${pad2(m[2] ?? "")}`;
  m = raw.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  if (m) return `${m[3]}-${pad2(m[1] ?? "")}-${pad2(m[2] ?? "")}`;
  return null;
}

function pad2(s: string): string {
  return s.length === 1 ? `0${s}` : s;
}
