import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseQfx } from "./parse.ts";
import { QfxParseError } from "./types.ts";

function fixture(name: string): Buffer {
  const url = new URL(`./__fixtures__/${name}`, import.meta.url);
  return readFileSync(fileURLToPath(url));
}

describe("parseQfx — M&T checking (OFX 1.x SGML)", () => {
  const parsed = parseQfx(fixture("mt-checking.qfx"));

  it("reads OFX 1.x header", () => {
    expect(parsed.header.version).toBe("1");
    expect(parsed.header.encoding).toBe("USASCII");
  });

  it("extracts exactly one statement", () => {
    expect(parsed.statements).toHaveLength(1);
  });

  it("preserves statement period + currency + account id", () => {
    const stmt = parsed.statements[0];
    expect(stmt?.currency).toBe("USD");
    expect(stmt?.periodStart).toBe("2026-02-01");
    expect(stmt?.periodEnd).toBe("2026-02-28");
    expect(stmt?.accountId).toBe("XXXXXX1234");
  });

  it("extracts the ledger balance for reconciliation", () => {
    const stmt = parsed.statements[0];
    expect(stmt?.ledgerBalance?.amount).toBe("1639.40");
    expect(stmt?.ledgerBalance?.asOf).toBe("2026-02-28");
  });

  it("extracts all 5 transactions with exact string amounts", () => {
    const stmt = parsed.statements[0];
    expect(stmt?.transactions).toHaveLength(5);
    const amounts = stmt?.transactions.map((t) => t.amount);
    expect(amounts).toEqual(["2500.00", "-87.42", "-450.00", "-23.18", "-300.00"]);
  });

  it("captures FITID, name, memo, and trnType per transaction", () => {
    const t = parsed.statements[0]?.transactions[0];
    expect(t?.fitid).toBe("2026020300001");
    expect(t?.name).toBe("EMPLOYER PAYROLL");
    expect(t?.memo).toBe("PAYROLL DEPOSIT");
    expect(t?.trnType).toBe("DIRECTDEP");
    expect(t?.postedAt).toBe("2026-02-03");
  });

  it("captures CHECKNUM when present", () => {
    const check = parsed.statements[0]?.transactions[2];
    expect(check?.checkNum).toBe("1287");
    expect(check?.trnType).toBe("CHECK");
  });

  it("returns null memo when <MEMO> is absent", () => {
    const t = parsed.statements[0]?.transactions[1]; // Wegmans
    expect(t?.memo).toBeNull();
  });
});

describe("parseQfx — Chase credit card (CCSTMTRS)", () => {
  const parsed = parseQfx(fixture("chase-credit-card.qfx"));

  it("extracts a credit-card statement via CCSTMTRS", () => {
    expect(parsed.statements).toHaveLength(1);
    expect(parsed.statements[0]?.accountId).toBe("XXXXXXXXXXXX9876");
  });

  it("preserves the sign convention: debits negative, payments positive", () => {
    const txns = parsed.statements[0]?.transactions ?? [];
    expect(txns[0]?.amount).toBe("-42.99"); // Amazon purchase
    expect(txns[2]?.amount).toBe("500.00"); // Payment received
  });

  it("ledger balance is negative for a credit card with outstanding balance", () => {
    expect(parsed.statements[0]?.ledgerBalance?.amount).toBe("-311.51");
  });
});

describe("parseQfx — OFX 2.x XML (AMEX)", () => {
  const parsed = parseQfx(fixture("amex-ofx2.ofx"));

  it("detects OFX 2.x via the <?xml header", () => {
    expect(parsed.header.version).toBe("2");
  });

  it("extracts both transactions with the right amounts", () => {
    const txns = parsed.statements[0]?.transactions ?? [];
    expect(txns).toHaveLength(2);
    expect(txns[0]?.fitid).toBe("AMEX20260207ABC");
    expect(txns[1]?.amount).toBe("-58.40");
  });
});

describe("parseQfx — error handling", () => {
  it("throws on missing OFX root", () => {
    expect(() => parseQfx("just some text, no OFX in sight")).toThrow(QfxParseError);
  });

  it("throws on missing <FITID> inside a STMTTRN", () => {
    const broken = `OFXHEADER:100
DATA:OFXSGML
VERSION:102

<OFX>
<BANKMSGSRSV1>
<STMTTRNRS>
<STMTRS>
<CURDEF>USD
<BANKTRANLIST>
<DTSTART>20260201
<DTEND>20260228
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20260205
<TRNAMT>-1.00
<NAME>NO FITID HERE
</STMTTRN>
</BANKTRANLIST>
<LEDGERBAL>
<BALAMT>-1.00
<DTASOF>20260228
</LEDGERBAL>
</STMTRS>
</STMTTRNRS>
</BANKMSGSRSV1>
</OFX>`;
    expect(() => parseQfx(broken)).toThrow(/FITID/);
  });

  it("throws on non-numeric TRNAMT", () => {
    const broken = `OFXHEADER:100
DATA:OFXSGML

<OFX>
<BANKMSGSRSV1>
<STMTTRNRS>
<STMTRS>
<CURDEF>USD
<BANKTRANLIST>
<DTSTART>20260201
<DTEND>20260228
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20260205
<TRNAMT>not-a-number
<FITID>X1
<NAME>BAD AMOUNT
</STMTTRN>
</BANKTRANLIST>
<LEDGERBAL>
<BALAMT>0
<DTASOF>20260228
</LEDGERBAL>
</STMTRS>
</STMTTRNRS>
</BANKMSGSRSV1>
</OFX>`;
    expect(() => parseQfx(broken)).toThrow(/TRNAMT/);
  });
});

describe("parseQfx — determinism", () => {
  it("two parses of the same buffer produce structurally equal output", () => {
    const buf = fixture("mt-checking.qfx");
    const a = parseQfx(buf);
    const b = parseQfx(buf);
    expect(a).toEqual(b);
  });
});
