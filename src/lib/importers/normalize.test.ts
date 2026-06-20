import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseCsv } from "./csv/parse.ts";
import { csvToNormalized, normalizePayee, qfxToNormalized } from "./normalize.ts";
import { parseQfx } from "./qfx/parse.ts";

function fixture(rel: string): Buffer {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)));
}

describe("normalizePayee", () => {
  it("groups store-number variants of the same merchant", () => {
    expect(normalizePayee("STARBUCKS #123")).toBe("STARBUCKS");
    expect(normalizePayee("Starbucks 456")).toBe("STARBUCKS");
    expect(normalizePayee("STARBUCKS #123")).toBe(normalizePayee("Starbucks 456"));
  });

  it("uppercases, strips punctuation, and collapses whitespace", () => {
    expect(normalizePayee("  trader   joe's  ")).toBe("TRADER JOE S");
  });

  it("falls back to the trimmed original when normalization empties the string", () => {
    expect(normalizePayee("12345")).toBe("12345");
    expect(normalizePayee("  789  ")).toBe("789");
  });
});

describe("qfxToNormalized", () => {
  const qfx = parseQfx(fixture("./qfx/__fixtures__/mt-checking.qfx"));
  const norm = qfxToNormalized(qfx);

  it("preserves source + period + ending balance", () => {
    expect(norm.source).toBe("qfx");
    expect(norm.statementStart).toBe("2026-02-01");
    expect(norm.statementEnd).toBe("2026-02-28");
    expect(norm.statementEndingBalance).toBe("1639.40");
    expect(norm.currency).toBe("USD");
  });

  it("carries every transaction through with the same fitid/amount/name", () => {
    expect(norm.transactions).toHaveLength(5);
    expect(norm.transactions[0]).toMatchObject({
      fitid: "2026020300001",
      amount: "2500.00",
      name: "EMPLOYER PAYROLL",
      memo: "PAYROLL DEPOSIT",
      postedAt: "2026-02-03",
    });
  });

  it("is deterministic across repeated parse + normalize", () => {
    const a = qfxToNormalized(parseQfx(fixture("./qfx/__fixtures__/mt-checking.qfx")));
    const b = qfxToNormalized(parseQfx(fixture("./qfx/__fixtures__/mt-checking.qfx")));
    expect(a).toEqual(b);
  });

  it("stores trnType + checkNum in raw payload", () => {
    const check = norm.transactions[2];
    expect(check?.raw.trnType).toBe("CHECK");
    expect(check?.raw.checkNum).toBe("1287");
  });
});

describe("csvToNormalized", () => {
  const csv = parseCsv(fixture("./csv/__fixtures__/mt-checking.csv"), {
    date: "Posted Date",
    amount: "Amount",
    name: "Description",
    memo: "Memo",
    dateFormat: "MM/DD/YYYY",
  });
  const norm = csvToNormalized(csv);

  it("returns CSV-marked batch with null statement period and balance", () => {
    expect(norm.source).toBe("csv");
    expect(norm.statementStart).toBeNull();
    expect(norm.statementEndingBalance).toBeNull();
  });

  it("uses syntheticFitid as the dedup key", () => {
    expect(norm.transactions[0]?.fitid).toBe(csv.rows[0]?.syntheticFitid);
  });

  it("two CSV+normalize roundtrips produce identical fitids", () => {
    const a = csvToNormalized(
      parseCsv(fixture("./csv/__fixtures__/mt-checking.csv"), {
        date: "Posted Date",
        amount: "Amount",
        name: "Description",
        memo: "Memo",
        dateFormat: "MM/DD/YYYY",
      }),
    );
    const b = csvToNormalized(
      parseCsv(fixture("./csv/__fixtures__/mt-checking.csv"), {
        date: "Posted Date",
        amount: "Amount",
        name: "Description",
        memo: "Memo",
        dateFormat: "MM/DD/YYYY",
      }),
    );
    expect(a.transactions.map((t) => t.fitid)).toEqual(b.transactions.map((t) => t.fitid));
  });
});
