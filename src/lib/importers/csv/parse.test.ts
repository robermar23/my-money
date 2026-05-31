import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseCsv } from "./parse.ts";
import { CsvParseError } from "./types.ts";

function fixture(name: string): Buffer {
  return readFileSync(fileURLToPath(new URL(`./__fixtures__/${name}`, import.meta.url)));
}

describe("parseCsv — M&T checking (signed amount column)", () => {
  const parsed = parseCsv(fixture("mt-checking.csv"), {
    date: "Posted Date",
    amount: "Amount",
    name: "Description",
    memo: "Memo",
    dateFormat: "MM/DD/YYYY",
  });

  it("reads all 5 rows", () => {
    expect(parsed.rows).toHaveLength(5);
  });

  it("normalizes US dates to ISO YYYY-MM-DD", () => {
    expect(parsed.rows[0]?.postedAt).toBe("2026-02-03");
    expect(parsed.rows[4]?.postedAt).toBe("2026-02-20");
  });

  it("preserves exact string amounts (no float drift)", () => {
    expect(parsed.rows.map((r) => r.amount)).toEqual([
      "2500.00",
      "-87.42",
      "-450.00",
      "-23.18",
      "-300.00",
    ]);
  });

  it("treats empty memo cells as null", () => {
    expect(parsed.rows[0]?.memo).toBe("PAYROLL DEPOSIT");
    expect(parsed.rows[1]?.memo).toBeNull();
  });

  it("handles quoted fields with embedded commas", () => {
    expect(parsed.rows[2]?.name).toBe("CHECK 1287, ENDORSED");
  });

  it("generates a deterministic synthetic FITID per row", () => {
    const second = parseCsv(fixture("mt-checking.csv"), {
      date: "Posted Date",
      amount: "Amount",
      name: "Description",
      memo: "Memo",
      dateFormat: "MM/DD/YYYY",
    });
    expect(parsed.rows.map((r) => r.syntheticFitid)).toEqual(
      second.rows.map((r) => r.syntheticFitid),
    );
    // All FITIDs distinct.
    const fitids = parsed.rows.map((r) => r.syntheticFitid);
    expect(new Set(fitids).size).toBe(fitids.length);
  });
});

describe("parseCsv — generic credit card (debit + credit columns, $ symbols, commas)", () => {
  const parsed = parseCsv(fixture("generic-credit-card.csv"), {
    date: "Date",
    name: "Merchant",
    amount: "",
    debit: "Debit",
    credit: "Credit",
    dateFormat: "YYYY-MM-DD",
  });

  it("turns debits into negative amounts and credits into positive ones", () => {
    expect(parsed.rows[0]?.amount).toBe("-42.99");
    expect(parsed.rows[2]?.amount).toBe("500.00"); // payment received
  });

  it("strips currency symbols and thousands separators", () => {
    expect(parsed.rows[1]?.amount).toBe("-1129.51");
  });

  it("requires either an amount column or both debit + credit", () => {
    expect(() =>
      parseCsv(fixture("generic-credit-card.csv"), {
        date: "Date",
        name: "Merchant",
        amount: "", // not present
        debit: "Debit",
        credit: "", // missing
      }),
    ).toThrow(CsvParseError);
  });
});

describe("parseCsv — M&T headerless (real export shape)", () => {
  const parsed = parseCsv(fixture("mt-headerless.csv"), {
    hasHeader: false,
    date: "1",
    name: "2",
    debit: "3",
    credit: "4",
    amount: "",
    dateFormat: "MM/DD/YYYY",
  });

  it("reads all 4 transaction rows (blank lines between rows are skipped)", () => {
    expect(parsed.rows).toHaveLength(4);
  });

  it("parses the date column at index 1", () => {
    expect(parsed.rows[0]?.postedAt).toBe("2026-05-27");
    expect(parsed.rows[3]?.postedAt).toBe("2026-05-22");
  });

  it("turns col_3 (debit) negative and col_4 (credit) positive", () => {
    expect(parsed.rows[0]?.amount).toBe("-350.00"); // CHECK 1047
    expect(parsed.rows[1]?.amount).toBe("200.00"); // WEB XFER FROM SAV
    expect(parsed.rows[2]?.amount).toBe("-412.19"); // CITI CARD
    expect(parsed.rows[3]?.amount).toBe("3612.40"); // payroll
  });

  it("captures the payee/name column at index 2", () => {
    expect(parsed.rows[0]?.name).toBe("CHECK 1047");
    expect(parsed.rows[3]?.name).toBe("77ACMECOPAYROLL PAYROLL");
  });

  it("synthesizes column keys (col_N) into the raw payload so balance is recoverable", () => {
    expect(parsed.rows[0]?.raw.col_5).toBe("5050.21");
  });

  it("rejects a non-numeric column reference with a helpful hint", () => {
    expect(() =>
      parseCsv(fixture("mt-headerless.csv"), {
        hasHeader: false,
        date: "Posted Date", // wrong — must be numeric index
        name: "2",
        debit: "3",
        credit: "4",
        amount: "",
      }),
    ).toThrow(/numeric column indexes/);
  });
});

describe("parseCsv — error handling", () => {
  it("throws on a missing required column", () => {
    expect(() =>
      parseCsv("Date,Foo\n2026-01-01,bar", {
        date: "Date",
        name: "NoSuchColumn",
        amount: "Foo",
      }),
    ).toThrow(/NoSuchColumn/);
  });

  it("throws on unparseable dates", () => {
    expect(() =>
      parseCsv("Date,Description,Amount\nnotadate,a,1.00", {
        date: "Date",
        name: "Description",
        amount: "Amount",
      }),
    ).toThrow(/Unparseable date/);
  });

  it("throws on unparseable amounts", () => {
    expect(() =>
      parseCsv("Date,Description,Amount\n2026-01-01,a,abc", {
        date: "Date",
        name: "Description",
        amount: "Amount",
      }),
    ).toThrow(/Invalid amount/);
  });
});
