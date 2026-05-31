import { type SgmlNode, childValue, findAll, findFirst, parseSgml } from "./sgml.ts";
import {
  type OfxTransactionType,
  type OfxVersion,
  type ParsedQfx,
  type ParsedQfxBalance,
  type ParsedQfxHeader,
  type ParsedQfxStatement,
  type ParsedQfxTransaction,
  QfxParseError,
} from "./types.ts";

const VALID_TRN_TYPES = new Set<OfxTransactionType>([
  "CREDIT",
  "DEBIT",
  "INT",
  "DIV",
  "FEE",
  "SRVCHG",
  "DEP",
  "ATM",
  "POS",
  "XFER",
  "CHECK",
  "PAYMENT",
  "CASH",
  "DIRECTDEP",
  "DIRECTDEBIT",
  "REPEATPMT",
  "HOLD",
  "OTHER",
]);

const SIGNED_DECIMAL = /^-?\d+(\.\d+)?$/;

/**
 * Parse an OFX 1.x or 2.x document (QFX is OFX with a Quicken header).
 *
 * The dispatch is simple:
 *   - If the first non-whitespace character after the header is '<?xml' OR the
 *     header includes `VERSION:200/201/202/203` → OFX 2.x (XML branch).
 *   - Else → OFX 1.x (SGML branch).
 *
 * @throws QfxParseError on malformed input.
 */
export function parseQfx(input: Buffer | string): ParsedQfx {
  const text = typeof input === "string" ? input : input.toString("utf8");
  const { header, body, bodyOffset } = splitHeaderAndBody(text);

  const trimmedBody = body.trimStart();
  const isXml = trimmedBody.startsWith("<?xml") || header.version === "2";

  let root: SgmlNode;
  try {
    root = isXml ? parseXmlOfx(trimmedBody) : parseSgml(body);
  } catch (err) {
    if (err instanceof QfxParseError) {
      // Adjust offset to the original document if we have one.
      if (err.offset !== undefined) {
        throw new QfxParseError(
          err.message.replace(/\s\(offset \d+\)$/, ""),
          bodyOffset + err.offset,
        );
      }
      throw err;
    }
    throw new QfxParseError(`Body parse failed: ${(err as Error).message}`);
  }

  if (root.tag !== "OFX") {
    throw new QfxParseError(`Expected root <OFX>, got <${root.tag}>`);
  }

  const statements = extractStatements(root);
  return { header, statements };
}

interface HeaderAndBody {
  readonly header: ParsedQfxHeader;
  readonly body: string;
  readonly bodyOffset: number;
}

/**
 * Split the OFX header from its body.
 *
 * OFX 1.x: a block of `KEY:VALUE` lines, terminated by a blank line, before the
 * first `<OFX>`. OFX 2.x: an XML declaration `<?xml ?>` followed by an XML
 * processing instruction `<?OFX ?>`, then the body.
 */
function splitHeaderAndBody(text: string): HeaderAndBody {
  // Detect OFX 2.x by `<?xml` prefix (skipping BOM/whitespace).
  const trimmed = text.replace(/^﻿/, "");
  if (trimmed.trimStart().startsWith("<?xml")) {
    // OFX 2.x — try to read the optional `<?OFX ...?>` processing instruction.
    const piMatch = trimmed.match(/<\?OFX\b([^?]*)\?>/i);
    const headerFields: Record<string, string> = {};
    if (piMatch?.[1]) {
      for (const m of piMatch[1].matchAll(/(\w+)="([^"]*)"/g)) {
        if (m[1]) headerFields[m[1].toUpperCase()] = m[2] ?? "";
      }
    }
    const header: ParsedQfxHeader = {
      version: (headerFields.VERSION?.startsWith("2") ? "2" : "2") as OfxVersion,
      encoding: headerFields.ENCODING ?? null,
      charset: headerFields.CHARSET ?? null,
    };
    const bodyOffset = text.indexOf("<OFX");
    if (bodyOffset === -1) {
      throw new QfxParseError("OFX 2.x: missing <OFX> root element");
    }
    return { header, body: text.slice(bodyOffset), bodyOffset };
  }

  // OFX 1.x.
  const ofxStart = text.indexOf("<OFX>");
  if (ofxStart === -1) {
    throw new QfxParseError("Missing <OFX> root element — not a recognizable OFX file");
  }
  const headerBlock = text.slice(0, ofxStart);
  const fields: Record<string, string> = {};
  for (const line of headerBlock.split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim().toUpperCase();
    const val = line.slice(colon + 1).trim();
    if (key) fields[key] = val;
  }
  if (!fields.OFXHEADER && !fields.DATA) {
    throw new QfxParseError("OFX 1.x: header block missing OFXHEADER/DATA fields");
  }
  const header: ParsedQfxHeader = {
    version: (fields.VERSION?.startsWith("2") ? "2" : "1") as OfxVersion,
    encoding: fields.ENCODING ?? null,
    charset: fields.CHARSET ?? null,
  };
  return { header, body: text.slice(ofxStart), bodyOffset: ofxStart };
}

/**
 * Minimal OFX 2.x XML reader.
 *
 * OFX 2.x is well-formed XML. We avoid an XML parser dependency by re-using
 * the SGML reader: the SGML reader treats well-formed XML aggregates and
 * leaves the same way it treats SGML ones (open tag, value or children,
 * close tag). We just need to strip the `<?xml ?>` and `<?OFX ?>` PIs first.
 */
function parseXmlOfx(text: string): SgmlNode {
  const stripped = text.replace(/<\?[\s\S]*?\?>/g, "");
  return parseSgml(stripped);
}

function extractStatements(root: SgmlNode): ParsedQfxStatement[] {
  const out: ParsedQfxStatement[] = [];

  // Bank statements live in <STMTRS> (bank) or <CCSTMTRS> (credit card).
  for (const stmtTag of ["STMTRS", "CCSTMTRS"] as const) {
    for (const stmt of findAll(root, stmtTag)) {
      out.push(buildStatement(stmt));
    }
  }

  if (out.length === 0) {
    // Some banks wrap differently — try to fall back to a bare STMT.
    const fallback = findFirst(root, "STMT");
    if (fallback) out.push(buildStatement(fallback));
  }

  return out;
}

function buildStatement(stmt: SgmlNode): ParsedQfxStatement {
  const fromAcct = findFirst(stmt, "BANKACCTFROM") ?? findFirst(stmt, "CCACCTFROM");
  const accountId = fromAcct ? childValue(fromAcct, "ACCTID") : null;
  const currency = childValue(stmt, "CURDEF")?.toUpperCase() ?? "USD";

  const tranList = findFirst(stmt, "BANKTRANLIST");
  const periodStart = tranList ? parseDate(childValue(tranList, "DTSTART")) : null;
  const periodEnd = tranList ? parseDate(childValue(tranList, "DTEND")) : null;

  const transactions: ParsedQfxTransaction[] = [];
  if (tranList) {
    for (const stmtTrn of findAll(tranList, "STMTTRN")) {
      transactions.push(buildTransaction(stmtTrn));
    }
  }

  const ledgerNode = findFirst(stmt, "LEDGERBAL");
  const availNode = findFirst(stmt, "AVAILBAL");

  return {
    accountId,
    currency,
    periodStart,
    periodEnd,
    ledgerBalance: ledgerNode ? buildBalance(ledgerNode) : null,
    availableBalance: availNode ? buildBalance(availNode) : null,
    transactions,
  };
}

function buildBalance(node: SgmlNode): ParsedQfxBalance {
  const amount = childValue(node, "BALAMT");
  const asOf = parseDate(childValue(node, "DTASOF"));
  if (!amount || !SIGNED_DECIMAL.test(amount)) {
    throw new QfxParseError(`Invalid <BALAMT>: '${amount}'`);
  }
  if (!asOf) {
    throw new QfxParseError("Balance is missing <DTASOF>");
  }
  return { amount, asOf };
}

function buildTransaction(stmtTrn: SgmlNode): ParsedQfxTransaction {
  const fitid = childValue(stmtTrn, "FITID");
  if (!fitid) {
    throw new QfxParseError("STMTTRN missing <FITID>");
  }
  const amount = childValue(stmtTrn, "TRNAMT");
  if (!amount || !SIGNED_DECIMAL.test(amount)) {
    throw new QfxParseError(`Invalid <TRNAMT> in STMTTRN ${fitid}: '${amount}'`);
  }
  const postedAt = parseDate(childValue(stmtTrn, "DTPOSTED"));
  if (!postedAt) {
    throw new QfxParseError(`STMTTRN ${fitid} missing <DTPOSTED>`);
  }
  const rawType = (childValue(stmtTrn, "TRNTYPE") ?? "OTHER").toUpperCase();
  const trnType: OfxTransactionType = VALID_TRN_TYPES.has(rawType as OfxTransactionType)
    ? (rawType as OfxTransactionType)
    : "OTHER";

  const name = (childValue(stmtTrn, "NAME") ?? "").trim() || "(no name)";
  const memo = childValue(stmtTrn, "MEMO");

  return {
    postedAt,
    amount,
    fitid,
    name,
    memo: memo?.trim() ? memo.trim() : null,
    trnType,
    checkNum: childValue(stmtTrn, "CHECKNUM"),
  };
}

/**
 * OFX dates: YYYYMMDDHHMMSS[.XXX][TZ:offset] — we only need the day.
 * Returns null when the value is missing or unparseable; throws nothing.
 */
function parseDate(value: string | null): string | null {
  if (!value) return null;
  const m = value.match(/^(\d{4})(\d{2})(\d{2})/);
  if (!m) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}
