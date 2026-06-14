import { describe, expect, it } from "vitest";
import {
  type PlaidHoldingLike,
  type PlaidInvestmentTxnLike,
  type SecurityInfo,
  institutionPriceQuote,
  plaidHoldingToHolding,
  plaidInvestmentTxnToRow,
} from "./investments-map.ts";

const ACCOUNT_ID = "00000000-0000-0000-0000-0000000000aa";

const security = (over: Partial<SecurityInfo> = {}): SecurityInfo => ({
  id: "our-sec-1",
  symbol: "AAPL",
  tickerSymbol: "AAPL",
  type: "equity",
  isCashEquivalent: false,
  ...over,
});

const holding = (over: Partial<PlaidHoldingLike> = {}): PlaidHoldingLike => ({
  account_id: "p-acct",
  security_id: "sec-1",
  institution_price: 150,
  institution_price_as_of: "2026-06-01",
  cost_basis: 1000,
  quantity: 10,
  iso_currency_code: "USD",
  ...over,
});

const txn = (over: Partial<PlaidInvestmentTxnLike> = {}): PlaidInvestmentTxnLike => ({
  investment_transaction_id: "it-1",
  account_id: "p-acct",
  security_id: "sec-1",
  date: "2026-05-15",
  name: "AAPL DIVIDEND",
  quantity: 0,
  amount: -25,
  price: 0,
  fees: null,
  type: "cash",
  subtype: "dividend",
  iso_currency_code: "USD",
  ...over,
});

describe("plaidHoldingToHolding", () => {
  it("maps an equity position", () => {
    const row = plaidHoldingToHolding(holding(), security(), ACCOUNT_ID);
    expect(row.accountId).toBe(ACCOUNT_ID);
    expect(row.symbol).toBe("AAPL");
    expect(row.assetClass).toBe("equity");
    expect(row.quantityUnit).toBe("shares");
    expect(row.quantity).toBe("10");
    expect(row.costBasis).toBe("1000.00");
    expect(row.source).toBe("plaid");
    expect(row.securityId).toBe("our-sec-1");
  });

  it("maps a crypto position to asset_class=crypto / unit=coin", () => {
    const row = plaidHoldingToHolding(
      holding({ quantity: 1.5 }),
      security({ type: "cryptocurrency", symbol: "BTC", tickerSymbol: "BTC" }),
      ACCOUNT_ID,
    );
    expect(row.assetClass).toBe("crypto");
    expect(row.quantityUnit).toBe("coin");
    expect(row.quantity).toBe("1.5");
  });

  it("maps a cash-equivalent position to asset_class=cash / unit=usd", () => {
    const row = plaidHoldingToHolding(
      holding(),
      security({ type: "cash", isCashEquivalent: true, symbol: "CUR:USD" }),
      ACCOUNT_ID,
    );
    expect(row.assetClass).toBe("cash");
    expect(row.quantityUnit).toBe("usd");
  });

  it("leaves cost basis null when Plaid reports none", () => {
    const row = plaidHoldingToHolding(holding({ cost_basis: null }), security(), ACCOUNT_ID);
    expect(row.costBasis).toBeNull();
  });
});

describe("institutionPriceQuote", () => {
  it("returns a Plaid-sourced quote for a non-tickered (synthetic) security", () => {
    const sec = security({ tickerSymbol: null, symbol: "SEC:sec-1" });
    const quote = institutionPriceQuote(holding({ institution_price: 42.5 }), sec);
    expect(quote).not.toBeNull();
    expect(quote?.symbol).toBe("SEC:sec-1");
    expect(quote?.date).toBe("2026-06-01");
    expect(quote?.close).toBe("42.5");
    expect(quote?.source).toBe("plaid");
  });

  it("also emits a quote for a tickered security (Plaid seed; Yahoo refreshes)", () => {
    const quote = institutionPriceQuote(
      holding({ institution_price: 150 }),
      security({ tickerSymbol: "AAPL", symbol: "AAPL" }),
    );
    expect(quote).not.toBeNull();
    expect(quote?.symbol).toBe("AAPL");
    expect(quote?.close).toBe("150");
  });

  it("falls back to today's date when Plaid omits institution_price_as_of", () => {
    const now = new Date("2026-06-06T12:00:00Z");
    const sec = security({ tickerSymbol: null, symbol: "SEC:sec-1" });
    const quote = institutionPriceQuote(holding({ institution_price_as_of: null }), sec, now);
    expect(quote?.date).toBe("2026-06-06");
  });
});

describe("plaidInvestmentTxnToRow", () => {
  it("flips the sign so a dividend (Plaid-negative) becomes a positive inflow", () => {
    const row = plaidInvestmentTxnToRow(txn(), ACCOUNT_ID, "our-sec-1");
    expect(row.amount).toBe("25.00");
    expect(row.type).toBe("cash");
    expect(row.subtype).toBe("dividend");
    expect(row.securityId).toBe("our-sec-1");
    expect(row.tradeDate).toBe("2026-05-15");
    expect(row.source).toBe("plaid");
    expect(row.plaidInvestmentTransactionId).toBe("it-1");
  });

  it("flips a buy (Plaid-positive) to a negative cash outflow and keeps qty/price", () => {
    const row = plaidInvestmentTxnToRow(
      txn({ type: "buy", subtype: "buy", amount: 1000, quantity: 10, price: 100, fees: 1.5 }),
      ACCOUNT_ID,
      "our-sec-1",
    );
    expect(row.amount).toBe("-1000.00");
    expect(row.quantity).toBe("10");
    expect(row.price).toBe("100");
    expect(row.fees).toBe("1.50");
  });

  it("defaults the currency to USD and tolerates a null security", () => {
    const row = plaidInvestmentTxnToRow(txn({ iso_currency_code: null }), ACCOUNT_ID, null);
    expect(row.isoCurrencyCode).toBe("USD");
    expect(row.securityId).toBeNull();
  });
});
