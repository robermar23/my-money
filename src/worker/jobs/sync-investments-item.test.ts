// @vitest-environment node
import { db } from "@/db/client.ts";
import {
  accountSnapshots,
  accounts,
  holdingLots,
  holdings,
  investmentTransactions,
  securities,
} from "@/db/schema/index.ts";
import { createPlaidItem } from "@/lib/plaid/tokens.ts";
import type { Job } from "bullmq";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/* ---------------------------------------------------------------------------
 * Mocks: only the Plaid SDK. DB, encryption, mappers, snapshot helper run real.
 * --------------------------------------------------------------------------- */

const mockHoldingsGet = vi.fn();
const mockTxnsGet = vi.fn();
vi.mock("@/lib/plaid/client.ts", () => ({
  plaidClient: {
    investmentsHoldingsGet: mockHoldingsGet,
    investmentsTransactionsGet: mockTxnsGet,
  },
  plaidEnvironment: () => "sandbox",
  plaidWebhookUrl: () => undefined,
}));

const { syncInvestmentsItemProcessor } = await import("./sync-investments-item.ts");

/* ---------------------------------------------------------------------------
 * Fixtures
 * --------------------------------------------------------------------------- */

const PLAID_ACCT = "plaidInvAcct01";

interface Setup {
  plaidItemPk: string;
  accountId: string;
}

async function freshSetup(): Promise<Setup> {
  await db.execute(
    sql`TRUNCATE webhook_log, plaid_sync_runs, plaid_items, holding_lots, investment_transactions, holdings, securities, transactions, account_snapshots, accounts CASCADE`,
  );
  const plaidItemPk = await createPlaidItem({
    plaidItemId: "item-inv-fixture",
    institutionId: "ins_fidelity",
    institutionName: "Fidelity",
    accessToken: "access-sandbox-inv",
    productsConsented: ["investments"],
  });
  const [account] = await db
    .insert(accounts)
    .values({
      name: "Fidelity Brokerage",
      institution: "Fidelity",
      type: "investment",
      currency: "USD",
      plaidItemId: plaidItemPk,
      plaidAccountId: PLAID_ACCT,
      plaidMask: "4321",
    })
    .returning({ id: accounts.id });
  if (!account) throw new Error("seed account");
  return { plaidItemPk, accountId: account.id };
}

const SEC_AAPL = {
  security_id: "sec-aapl",
  ticker_symbol: "AAPL",
  cusip: "037833100",
  isin: null,
  name: "Apple Inc",
  is_cash_equivalent: false,
  type: "equity",
  subtype: "common stock",
  close_price: 150,
  iso_currency_code: "USD",
  unofficial_currency_code: null,
};

function holdAapl(over: Record<string, unknown> = {}) {
  return {
    account_id: PLAID_ACCT,
    security_id: "sec-aapl",
    institution_price: 150,
    institution_price_as_of: "2026-06-01",
    institution_value: 1500,
    cost_basis: 1000,
    quantity: 10,
    iso_currency_code: "USD",
    unofficial_currency_code: null,
    ...over,
  };
}

const BUY_AAPL = {
  investment_transaction_id: "it-buy-1",
  account_id: PLAID_ACCT,
  security_id: "sec-aapl",
  date: "2026-05-15",
  name: "BUY AAPL",
  quantity: 10,
  amount: 1000, // Plaid: cash debited (positive)
  price: 100,
  fees: 0,
  type: "buy",
  subtype: "buy",
  iso_currency_code: "USD",
  unofficial_currency_code: null,
};

function holdingsResp(holdingsArr: unknown[], securitiesArr: unknown[]) {
  return {
    data: { holdings: holdingsArr, securities: securitiesArr, accounts: [], request_id: "r" },
  };
}
function txnsResp(txnsArr: unknown[], securitiesArr: unknown[], total?: number) {
  return {
    data: {
      investment_transactions: txnsArr,
      securities: securitiesArr,
      total_investment_transactions: total ?? txnsArr.length,
      accounts: [],
      request_id: "r",
    },
  };
}

function makeJob(data: { plaidItemPk: string; trigger?: string; webhookLogId?: string }): Job {
  return { id: "test-job", data: { trigger: "manual", ...data } } as unknown as Job;
}

beforeEach(() => {
  mockHoldingsGet.mockReset();
  mockTxnsGet.mockReset();
});
afterEach(() => vi.clearAllMocks());

/* ---------------------------------------------------------------------------
 * Tests
 * --------------------------------------------------------------------------- */

describe("syncInvestmentsItemProcessor (P5-16)", () => {
  it("upserts securities + holdings from the holdings snapshot", async () => {
    const { plaidItemPk, accountId } = await freshSetup();
    mockHoldingsGet.mockResolvedValueOnce(holdingsResp([holdAapl()], [SEC_AAPL]));
    mockTxnsGet.mockResolvedValueOnce(txnsResp([], [], 0));

    await syncInvestmentsItemProcessor(makeJob({ plaidItemPk }));

    const secs = await db.select().from(securities);
    expect(secs).toHaveLength(1);
    expect(secs[0]?.symbol).toBe("AAPL");

    const hs = await db.select().from(holdings).where(eq(holdings.accountId, accountId));
    expect(hs).toHaveLength(1);
    expect(hs[0]?.symbol).toBe("AAPL");
    expect(hs[0]?.assetClass).toBe("equity");
    expect(hs[0]?.source).toBe("plaid");
    expect(Number(hs[0]?.quantity)).toBe(10);
    expect(hs[0]?.costBasis).toBe("1000.00");
  });

  it("reconciles a sold-out plaid position while preserving manual holdings", async () => {
    const { plaidItemPk, accountId } = await freshSetup();
    // A manually-tracked position the user owns on the same account.
    await db.insert(holdings).values({
      accountId,
      symbol: "MSFT",
      quantity: "5",
      quantityUnit: "shares",
      assetClass: "equity",
      source: "manual",
    });

    // Run 1: Plaid reports AAPL.
    mockHoldingsGet.mockResolvedValueOnce(holdingsResp([holdAapl()], [SEC_AAPL]));
    mockTxnsGet.mockResolvedValueOnce(txnsResp([], [], 0));
    await syncInvestmentsItemProcessor(makeJob({ plaidItemPk }));
    expect(await db.select().from(holdings).where(eq(holdings.accountId, accountId))).toHaveLength(
      2,
    );

    // Run 2: Plaid reports no holdings (AAPL sold out).
    mockHoldingsGet.mockResolvedValueOnce(holdingsResp([], [SEC_AAPL]));
    mockTxnsGet.mockResolvedValueOnce(txnsResp([], [], 0));
    await syncInvestmentsItemProcessor(makeJob({ plaidItemPk }));

    const after = await db.select().from(holdings).where(eq(holdings.accountId, accountId));
    expect(after.map((h) => h.symbol)).toEqual(["MSFT"]); // plaid AAPL gone, manual MSFT kept
  });

  it("dedupes investment transactions and builds a lot from a buy (idempotent re-run)", async () => {
    const { plaidItemPk, accountId } = await freshSetup();

    mockHoldingsGet.mockResolvedValue(holdingsResp([holdAapl()], [SEC_AAPL]));
    mockTxnsGet.mockResolvedValue(txnsResp([BUY_AAPL], [SEC_AAPL], 1));

    await syncInvestmentsItemProcessor(makeJob({ plaidItemPk }));
    await syncInvestmentsItemProcessor(makeJob({ plaidItemPk })); // re-run

    const txns = await db
      .select()
      .from(investmentTransactions)
      .where(eq(investmentTransactions.accountId, accountId));
    expect(txns).toHaveLength(1); // deduped on re-run
    expect(txns[0]?.type).toBe("buy");
    expect(txns[0]?.amount).toBe("-1000.00"); // sign-flipped to our outflow convention

    const lots = await db.select().from(holdingLots);
    expect(lots).toHaveLength(1); // deduped on re-run
    expect(lots[0]?.costBasisTotal).toBe("1000.00");

    const hs = await db.select().from(holdings).where(eq(holdings.accountId, accountId));
    expect(hs).toHaveLength(1);
  });

  it("preserves a user-overridden cost basis across a sync", async () => {
    const { plaidItemPk, accountId } = await freshSetup();
    await db.insert(holdings).values({
      accountId,
      symbol: "AAPL",
      quantity: "1",
      quantityUnit: "shares",
      assetClass: "equity",
      costBasis: "777.00",
      costBasisOverriddenAt: new Date(),
      source: "plaid",
    });

    mockHoldingsGet.mockResolvedValueOnce(
      holdingsResp([holdAapl({ cost_basis: 1000 })], [SEC_AAPL]),
    );
    mockTxnsGet.mockResolvedValueOnce(txnsResp([], [], 0));
    await syncInvestmentsItemProcessor(makeJob({ plaidItemPk }));

    const [h] = await db.select().from(holdings).where(eq(holdings.accountId, accountId));
    expect(h?.costBasis).toBe("777.00"); // user value preserved, not overwritten by Plaid's 1000
    expect(Number(h?.quantity)).toBe(10); // quantity still updated from Plaid
  });

  it("is a no-op for an Item that did not consent to investments", async () => {
    await db.execute(
      sql`TRUNCATE plaid_items, holdings, securities, accounts, plaid_sync_runs CASCADE`,
    );
    const plaidItemPk = await createPlaidItem({
      plaidItemId: "item-txn-only",
      institutionId: "ins_mt",
      institutionName: "M&T",
      accessToken: "access-sandbox-txn",
      productsConsented: ["transactions"],
    });

    await syncInvestmentsItemProcessor(makeJob({ plaidItemPk }));

    expect(mockHoldingsGet).not.toHaveBeenCalled();
    expect(await db.select().from(holdings)).toHaveLength(0);
  });
});

describe("syncInvestmentsItemProcessor — balance anchoring", () => {
  it("snapshots an investment account at Plaid's reported balance, not the holdings sum", async () => {
    const { plaidItemPk, accountId } = await freshSetup();
    // Holdings sum to 1500 (10 AAPL × 150), but Plaid's account balance is
    // 27354.77 (positions/cash Plaid didn't itemize). The balance is authoritative.
    mockHoldingsGet.mockResolvedValueOnce({
      data: {
        holdings: [holdAapl()],
        securities: [SEC_AAPL],
        accounts: [
          { account_id: PLAID_ACCT, balances: { current: 27354.77, iso_currency_code: "USD" } },
        ],
        request_id: "r",
      },
    });
    mockTxnsGet.mockResolvedValueOnce(txnsResp([], [], 0));

    await syncInvestmentsItemProcessor(makeJob({ plaidItemPk }));

    const [snap] = await db
      .select({ balance: accountSnapshots.balance })
      .from(accountSnapshots)
      .where(eq(accountSnapshots.accountId, accountId));
    expect(snap?.balance).toBe("27354.77");
  });

  it("snapshots a holdings-less account (e.g. a 401k) from its Plaid balance", async () => {
    const { plaidItemPk, accountId } = await freshSetup();
    // Plaid returns a balance but no positions (common for 401k plans). Summing
    // holdings would give $0; we must use the reported balance.
    mockHoldingsGet.mockResolvedValueOnce({
      data: {
        holdings: [],
        securities: [],
        accounts: [
          { account_id: PLAID_ACCT, balances: { current: 509368.06, iso_currency_code: "USD" } },
        ],
        request_id: "r",
      },
    });
    mockTxnsGet.mockResolvedValueOnce(txnsResp([], [], 0));

    await syncInvestmentsItemProcessor(makeJob({ plaidItemPk }));

    const [snap] = await db
      .select({ balance: accountSnapshots.balance })
      .from(accountSnapshots)
      .where(eq(accountSnapshots.accountId, accountId));
    expect(snap?.balance).toBe("509368.06");
    expect(await db.select().from(holdings).where(eq(holdings.accountId, accountId))).toHaveLength(
      0,
    );
  });
});
