// @vitest-environment node
import { describe, expect, it } from "vitest";
import { type PlaidTransactionLike, plaidToTransaction } from "./map.ts";

function makePlaidTxn(overrides: Partial<PlaidTransactionLike> = {}): PlaidTransactionLike {
  return {
    transaction_id: "txn-abc-123",
    amount: 12.34,
    iso_currency_code: "USD",
    merchant_name: "STARBUCKS STORE 12345",
    name: "STARBUCKS",
    date: "2026-05-30",
    authorized_date: "2026-05-29",
    payment_meta: undefined,
    ...overrides,
  };
}

const ACCOUNT_UUID = "11111111-1111-1111-1111-111111111111";

describe("plaidToTransaction — sign flip", () => {
  it("flips Plaid positive (outflow) to OFX negative", () => {
    const row = plaidToTransaction(makePlaidTxn({ amount: 12.34 }), ACCOUNT_UUID);
    expect(row.amount).toBe("-12.34");
  });

  it("flips Plaid negative (inflow) to OFX positive", () => {
    const row = plaidToTransaction(makePlaidTxn({ amount: -42.5 }), ACCOUNT_UUID);
    expect(row.amount).toBe("42.50");
  });

  it("zero stays zero with canonical 2-decimal formatting", () => {
    const row = plaidToTransaction(makePlaidTxn({ amount: 0 }), ACCOUNT_UUID);
    expect(row.amount).toBe("0.00");
  });

  it("preserves cents precision exactly (no float drift)", () => {
    // The canonical IEEE-754 trap: 0.1 + 0.2 = 0.30000000000000004 in floats.
    // Here we just need Plaid 0.10 to flip to -0.10 exactly.
    const a = plaidToTransaction(makePlaidTxn({ amount: 0.1 }), ACCOUNT_UUID);
    const b = plaidToTransaction(makePlaidTxn({ amount: 0.2 }), ACCOUNT_UUID);
    expect(a.amount).toBe("-0.10");
    expect(b.amount).toBe("-0.20");
  });
});

describe("plaidToTransaction — fitid", () => {
  it("uses Plaid transaction_id as fitid", () => {
    const row = plaidToTransaction(
      makePlaidTxn({ transaction_id: "plaid-txn-9876" }),
      ACCOUNT_UUID,
    );
    expect(row.fitid).toBe("plaid-txn-9876");
  });

  it("throws when transaction_id is missing", () => {
    expect(() =>
      plaidToTransaction(makePlaidTxn({ transaction_id: "" as unknown as string }), ACCOUNT_UUID),
    ).toThrow(/transaction_id/);
  });

  it("two calls for the same Plaid transaction yield identical fitid (stability)", () => {
    const t = makePlaidTxn({ transaction_id: "stable-id" });
    const a = plaidToTransaction(t, ACCOUNT_UUID);
    const b = plaidToTransaction(t, ACCOUNT_UUID);
    expect(a.fitid).toBe(b.fitid);
  });
});

describe("plaidToTransaction — date preference", () => {
  it("prefers authorized_date when present", () => {
    const row = plaidToTransaction(
      makePlaidTxn({ authorized_date: "2026-05-15", date: "2026-05-20" }),
      ACCOUNT_UUID,
    );
    expect(row.postedAt).toBe("2026-05-15");
  });

  it("falls back to `date` when authorized_date is null", () => {
    const row = plaidToTransaction(
      makePlaidTxn({ authorized_date: null, date: "2026-05-20" }),
      ACCOUNT_UUID,
    );
    expect(row.postedAt).toBe("2026-05-20");
  });

  it("falls back to `date` when authorized_date is undefined", () => {
    const row = plaidToTransaction(
      makePlaidTxn({
        authorized_date: undefined as unknown as string | null,
        date: "2026-05-20",
      }),
      ACCOUNT_UUID,
    );
    expect(row.postedAt).toBe("2026-05-20");
  });

  it("throws on a malformed date", () => {
    expect(() =>
      plaidToTransaction(makePlaidTxn({ authorized_date: null, date: "not-a-date" }), ACCOUNT_UUID),
    ).toThrow(/bad date/);
  });
});

describe("plaidToTransaction — name fallback", () => {
  it("prefers merchant_name when present", () => {
    const row = plaidToTransaction(
      makePlaidTxn({ merchant_name: "Starbucks", name: "STARBUCKS STORE 12345" }),
      ACCOUNT_UUID,
    );
    expect(row.name).toBe("Starbucks");
  });

  it("falls back to name when merchant_name is null", () => {
    const row = plaidToTransaction(
      makePlaidTxn({ merchant_name: null, name: "ACME CORP" }),
      ACCOUNT_UUID,
    );
    expect(row.name).toBe("ACME CORP");
  });

  it("falls back to name when merchant_name is empty string", () => {
    const row = plaidToTransaction(
      makePlaidTxn({ merchant_name: "", name: "ACME CORP" }),
      ACCOUNT_UUID,
    );
    expect(row.name).toBe("ACME CORP");
  });
});

describe("plaidToTransaction — memo + category + raw + accountId", () => {
  it("pulls memo from payment_meta.payee when present", () => {
    const row = plaidToTransaction(
      makePlaidTxn({
        payment_meta: {
          payee: "Some payee",
          reference_number: null,
          ppd_id: null,
          payer: null,
          payment_method: null,
          payment_processor: null,
          reason: null,
          by_order_of: null,
        },
      }),
      ACCOUNT_UUID,
    );
    expect(row.memo).toBe("Some payee");
  });

  it("memo is null when payment_meta is absent", () => {
    const row = plaidToTransaction(makePlaidTxn({ payment_meta: undefined }), ACCOUNT_UUID);
    expect(row.memo).toBeNull();
  });

  it("category is always null — categorizer (P4-20) sets it later", () => {
    const row = plaidToTransaction(makePlaidTxn(), ACCOUNT_UUID);
    expect(row.category).toBeNull();
  });

  it("raw retains the full Plaid payload for downstream PFC seeding", () => {
    const t = makePlaidTxn({ transaction_id: "raw-test" });
    const row = plaidToTransaction(t, ACCOUNT_UUID);
    expect(row.raw).toMatchObject({ transaction_id: "raw-test", amount: 12.34 });
  });

  it("propagates the supplied accountId verbatim", () => {
    const row = plaidToTransaction(makePlaidTxn(), ACCOUNT_UUID);
    expect(row.accountId).toBe(ACCOUNT_UUID);
  });
});
