// @vitest-environment node
import { db } from "@/db/client.ts";
import {
  accountSnapshots,
  accounts,
  categoryRules,
  plaidItems,
  plaidSyncRuns,
  transactions,
  webhookLog,
} from "@/db/schema/index.ts";
import { createPlaidItem } from "@/lib/plaid/tokens.ts";
import type { Job } from "bullmq";
import { and, eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/* ---------------------------------------------------------------------------
 * Mocks: only the Plaid SDK. Everything else (DB, encryption, snapshot
 * helper, categorizer) runs for real.
 * --------------------------------------------------------------------------- */

const mockSync = vi.fn();
const mockAccountsGet = vi.fn();
vi.mock("@/lib/plaid/client.ts", () => ({
  plaidClient: { transactionsSync: mockSync, accountsGet: mockAccountsGet },
  plaidEnvironment: () => "sandbox",
  plaidWebhookUrl: () => undefined,
}));

// Auto-seed default category rules into a clean state at the start of each
// test that exercises P4-20 (categorization wiring).
async function seedStarbucksRule(): Promise<void> {
  await db.insert(categoryRules).values({
    pattern: "STARBUCKS",
    flags: "i",
    field: "name",
    category: "Coffee",
    priority: 21,
    enabled: true,
  });
}

const { syncPlaidItemProcessor } = await import("./sync-plaid-item.ts");

/* ---------------------------------------------------------------------------
 * Fixtures + helpers
 * --------------------------------------------------------------------------- */

interface Setup {
  plaidItemPk: string;
  accountUuid: string;
  plaidAccountId: string;
}

async function freshSetup(opts?: { skipMapping?: boolean }): Promise<Setup> {
  await db.execute(
    sql`TRUNCATE webhook_log, plaid_sync_runs, plaid_items, transactions, account_snapshots, accounts, category_rules CASCADE`,
  );
  const plaidItemPk = await createPlaidItem({
    plaidItemId: "item-sync-fixture",
    institutionId: "ins_109508",
    institutionName: "First Platypus Bank",
    accessToken: "access-sandbox-fixture",
    productsConsented: ["transactions"],
  });
  const plaidAccountId = "plaidAccountAAA1";
  if (opts?.skipMapping) {
    return { plaidItemPk, accountUuid: "(unmapped)", plaidAccountId };
  }
  const [account] = await db
    .insert(accounts)
    .values({
      name: "Plaid Checking",
      institution: "First Platypus Bank",
      type: "depository",
      currency: "USD",
      plaidItemId: plaidItemPk,
      plaidAccountId,
      plaidMask: "0000",
    })
    .returning({ id: accounts.id });
  if (!account) throw new Error("seed account");
  return { plaidItemPk, accountUuid: account.id, plaidAccountId };
}

interface SyncPage {
  added?: Array<
    Partial<{
      transaction_id: string;
      account_id: string;
      amount: number;
      iso_currency_code: string;
      name: string;
      merchant_name: string | null;
      date: string;
      authorized_date: string | null;
      payment_meta: unknown;
    }>
  >;
  modified?: Array<unknown>;
  removed?: Array<{ transaction_id: string; account_id?: string }>;
  next_cursor: string;
  has_more: boolean;
}

function mockSyncPages(pages: SyncPage[]): void {
  mockSync.mockReset();
  for (const page of pages) {
    mockSync.mockResolvedValueOnce({
      data: {
        accounts: [],
        added: page.added ?? [],
        modified: page.modified ?? [],
        removed: page.removed ?? [],
        next_cursor: page.next_cursor,
        has_more: page.has_more,
        transactions_update_status: "HISTORICAL_UPDATE_COMPLETE",
        request_id: "req-stub",
      },
    });
  }
}

function makeJob(data: { plaidItemPk: string; trigger?: string; webhookLogId?: string }): Job {
  return {
    id: "test-job",
    data: { trigger: "webhook", ...data },
  } as unknown as Job;
}

function plaidTxn(
  setup: Setup,
  overrides: Partial<{
    transaction_id: string;
    amount: number;
    name: string;
    merchant_name: string | null;
    date: string;
    authorized_date: string | null;
  }> = {},
): SyncPage["added"] extends (infer A)[] | undefined ? NonNullable<A> : never {
  return {
    transaction_id: "txn-001",
    account_id: setup.plaidAccountId,
    amount: 5.5,
    iso_currency_code: "USD",
    name: "STARBUCKS STORE #500",
    merchant_name: "Starbucks",
    date: "2026-05-30",
    authorized_date: "2026-05-29",
    payment_meta: null,
    ...overrides,
  };
}

beforeEach(() => {
  mockSync.mockReset();
  // Default: no balances returned, so tests that don't care about anchoring
  // fall back to the affected-dates recompute (the pre-anchoring behavior the
  // older assertions were written against). The anchoring tests override this.
  mockAccountsGet.mockReset();
  mockAccountsGet.mockResolvedValue({ data: { accounts: [] } });
});

afterEach(() => {
  vi.clearAllMocks();
});

/* ---------------------------------------------------------------------------
 * Tests
 * --------------------------------------------------------------------------- */

describe("syncPlaidItemProcessor — happy path + P4-20 categorization", () => {
  it("inserts new transactions, runs categorizer, advances cursor, stamps Item, closes sync_run", async () => {
    const setup = await freshSetup();
    await seedStarbucksRule();

    mockSyncPages([
      {
        added: [plaidTxn(setup, { transaction_id: "T1", name: "STARBUCKS STORE #500" })],
        modified: [],
        removed: [],
        next_cursor: "cursor-after-T1",
        has_more: false,
      },
    ]);

    await syncPlaidItemProcessor(makeJob({ plaidItemPk: setup.plaidItemPk, trigger: "initial" }));

    const rows = await db
      .select()
      .from(transactions)
      .where(eq(transactions.accountId, setup.accountUuid));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.fitid).toBe("T1");
    expect(rows[0]?.source).toBe("plaid");
    expect(rows[0]?.amount).toBe("-5.50"); // sign-flipped
    expect(rows[0]?.category).toBe("Coffee"); // P4-20

    const [item] = await db.select().from(plaidItems).where(eq(plaidItems.id, setup.plaidItemPk));
    expect(item?.transactionsCursor).toBe("cursor-after-T1");
    expect(item?.lastSyncedAt).toBeInstanceOf(Date);
    expect(item?.errorCode).toBeNull();
    expect(item?.status).toBe("active");

    const [run] = await db.select().from(plaidSyncRuns);
    expect(run?.finishedAt).toBeInstanceOf(Date);
    expect(run?.cursorAfter).toBe("cursor-after-T1");
    expect(run?.addedCount).toBe(1);
    expect(run?.modifiedCount).toBe(0);
    expect(run?.removedCount).toBe(0);
    expect(run?.paginationCount).toBe(1);
    expect(run?.trigger).toBe("initial");

    const snaps = await db
      .select()
      .from(accountSnapshots)
      .where(eq(accountSnapshots.accountId, setup.accountUuid));
    expect(snaps).toHaveLength(1);
    expect(snaps[0]?.date).toBe("2026-05-29"); // authorized_date is preferred
    expect(snaps[0]?.balance).toBe("-5.50");
  });

  it("paginates across multiple has_more=true pages and counts them in plaid_sync_runs.pagination_count", async () => {
    const setup = await freshSetup();
    mockSyncPages([
      {
        added: [plaidTxn(setup, { transaction_id: "P1A" })],
        next_cursor: "page-1",
        has_more: true,
      },
      {
        added: [plaidTxn(setup, { transaction_id: "P2A" })],
        next_cursor: "page-2",
        has_more: false,
      },
    ]);

    await syncPlaidItemProcessor(makeJob({ plaidItemPk: setup.plaidItemPk }));

    expect(mockSync).toHaveBeenCalledTimes(2);
    const [run] = await db.select().from(plaidSyncRuns);
    expect(run?.paginationCount).toBe(2);
    expect(run?.cursorAfter).toBe("page-2");
    expect(await db.select().from(transactions)).toHaveLength(2);
  });

  it("marks webhook_log row as processed when webhookLogId is provided", async () => {
    const setup = await freshSetup();
    mockSyncPages([{ next_cursor: "cur-x", has_more: false }]);

    // Seed a fake webhook_log row.
    const [logRow] = await db
      .insert(webhookLog)
      .values({
        idempotencyHash: "hash-for-test",
        webhookType: "TRANSACTIONS",
        webhookCode: "SYNC_UPDATES_AVAILABLE",
        plaidItemId: "item-sync-fixture",
        body: { test: true },
        status: "queued",
      })
      .returning({ id: webhookLog.id });
    if (!logRow) throw new Error("seed webhook_log");

    await syncPlaidItemProcessor(
      makeJob({ plaidItemPk: setup.plaidItemPk, webhookLogId: logRow.id }),
    );

    const [after] = await db.select().from(webhookLog).where(eq(webhookLog.id, logRow.id));
    expect(after?.status).toBe("processed");
    expect(after?.processedAt).toBeInstanceOf(Date);
  });
});

describe("syncPlaidItemProcessor — idempotency", () => {
  it("running the job twice with the same starting cursor inserts zero new rows on the second run", async () => {
    const setup = await freshSetup();
    mockSyncPages([
      {
        added: [
          plaidTxn(setup, { transaction_id: "DUPE-A" }),
          plaidTxn(setup, { transaction_id: "DUPE-B", date: "2026-05-28", authorized_date: null }),
        ],
        next_cursor: "after-first-run",
        has_more: false,
      },
    ]);
    await syncPlaidItemProcessor(makeJob({ plaidItemPk: setup.plaidItemPk }));

    const afterFirst = await db.select().from(transactions);
    expect(afterFirst).toHaveLength(2);

    // Simulate a re-run from the SAME starting cursor — the worker reads
    // plaid_items.transactions_cursor; force it back to NULL to simulate
    // "starting fresh" and have Plaid replay the same payload.
    await db
      .update(plaidItems)
      .set({ transactionsCursor: null })
      .where(eq(plaidItems.id, setup.plaidItemPk));
    mockSyncPages([
      {
        added: [
          plaidTxn(setup, { transaction_id: "DUPE-A" }),
          plaidTxn(setup, { transaction_id: "DUPE-B", date: "2026-05-28", authorized_date: null }),
        ],
        next_cursor: "after-second-run",
        has_more: false,
      },
    ]);
    await syncPlaidItemProcessor(makeJob({ plaidItemPk: setup.plaidItemPk }));

    const afterSecond = await db.select().from(transactions);
    expect(afterSecond).toHaveLength(2); // ON CONFLICT DO NOTHING — no duplicates

    const runs = await db.select().from(plaidSyncRuns);
    expect(runs).toHaveLength(2);
    expect(runs[1]?.addedCount).toBe(0); // second run inserted nothing
  });
});

describe("syncPlaidItemProcessor — mutation during pagination", () => {
  it("restarts from cursor=null when Plaid returns TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION", async () => {
    const setup = await freshSetup();
    // Page 1 succeeds → page 2 errors with mutation code → restart from null
    // → page 1' succeeds → page 2' succeeds → done.
    mockSync.mockReset();
    // First attempt page 1
    mockSync.mockResolvedValueOnce({
      data: {
        accounts: [],
        added: [plaidTxn(setup, { transaction_id: "STALE-1" })],
        modified: [],
        removed: [],
        next_cursor: "stale-cur-1",
        has_more: true,
        transactions_update_status: "HISTORICAL_UPDATE_COMPLETE",
        request_id: "r1",
      },
    });
    // Second call → mutation error
    mockSync.mockRejectedValueOnce({
      response: { data: { error_code: "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION" } },
    });
    // After restart, cursor=null → page 1'
    mockSync.mockResolvedValueOnce({
      data: {
        accounts: [],
        added: [plaidTxn(setup, { transaction_id: "RESTART-1" })],
        modified: [],
        removed: [],
        next_cursor: "restart-cur-1",
        has_more: true,
        transactions_update_status: "HISTORICAL_UPDATE_COMPLETE",
        request_id: "r2",
      },
    });
    // And page 2'
    mockSync.mockResolvedValueOnce({
      data: {
        accounts: [],
        added: [
          plaidTxn(setup, {
            transaction_id: "RESTART-2",
            date: "2026-05-27",
            authorized_date: null,
          }),
        ],
        modified: [],
        removed: [],
        next_cursor: "restart-cur-2",
        has_more: false,
        transactions_update_status: "HISTORICAL_UPDATE_COMPLETE",
        request_id: "r3",
      },
    });

    await syncPlaidItemProcessor(makeJob({ plaidItemPk: setup.plaidItemPk }));

    // STALE-1 must NOT be in the DB — the worker discarded its accumulator on
    // restart. Only RESTART-1 and RESTART-2 land.
    const fitids = (await db.select({ fitid: transactions.fitid }).from(transactions))
      .map((r) => r.fitid)
      .sort();
    expect(fitids).toEqual(["RESTART-1", "RESTART-2"]);

    const calls = mockSync.mock.calls;
    expect(calls).toHaveLength(4);
    // The third call (post-restart page 1) had cursor undefined.
    expect(calls[2]?.[0]?.cursor).toBeUndefined();

    const [item] = await db.select().from(plaidItems).where(eq(plaidItems.id, setup.plaidItemPk));
    expect(item?.transactionsCursor).toBe("restart-cur-2");
  });
});

describe("syncPlaidItemProcessor — removed transactions", () => {
  it("DELETEs rows that Plaid reports as removed and updates the snapshot for the affected date", async () => {
    const setup = await freshSetup();
    // Pre-seed an existing transaction.
    await db.insert(transactions).values({
      accountId: setup.accountUuid,
      postedAt: "2026-05-20",
      amount: "-99.00",
      name: "OLD TRANSACTION",
      fitid: "TO-BE-REMOVED",
      source: "plaid",
    });

    mockSyncPages([
      {
        added: [],
        modified: [],
        removed: [{ transaction_id: "TO-BE-REMOVED", account_id: setup.plaidAccountId }],
        next_cursor: "after-remove",
        has_more: false,
      },
    ]);

    await syncPlaidItemProcessor(makeJob({ plaidItemPk: setup.plaidItemPk }));

    const remaining = await db
      .select()
      .from(transactions)
      .where(
        and(eq(transactions.accountId, setup.accountUuid), eq(transactions.fitid, "TO-BE-REMOVED")),
      );
    expect(remaining).toHaveLength(0);

    const [run] = await db.select().from(plaidSyncRuns);
    expect(run?.removedCount).toBe(1);

    // Snapshot for the affected date now reflects the empty ledger.
    const [snap] = await db
      .select()
      .from(accountSnapshots)
      .where(eq(accountSnapshots.accountId, setup.accountUuid));
    expect(snap?.balance).toBe("0.00");
  });
});

describe("syncPlaidItemProcessor — sticky category override (P4-20)", () => {
  it("modified rows whose category was manually overridden keep their override", async () => {
    const setup = await freshSetup();
    await seedStarbucksRule();

    // Seed a transaction with a manual override.
    await db.insert(transactions).values({
      accountId: setup.accountUuid,
      postedAt: "2026-05-15",
      amount: "-3.50",
      name: "STARBUCKS RTL",
      category: "Personal", // user-overridden
      categoryOverriddenAt: new Date(),
      fitid: "STICKY-1",
      source: "plaid",
    });

    // Plaid sends a modified version (e.g. authorized_date now present).
    mockSyncPages([
      {
        added: [],
        modified: [
          plaidTxn(setup, {
            transaction_id: "STICKY-1",
            name: "STARBUCKS STORE #500",
            amount: 3.5,
            authorized_date: "2026-05-15",
          }),
        ],
        removed: [],
        next_cursor: "after-modify",
        has_more: false,
      },
    ]);

    await syncPlaidItemProcessor(makeJob({ plaidItemPk: setup.plaidItemPk }));

    const [row] = await db.select().from(transactions).where(eq(transactions.fitid, "STICKY-1"));
    expect(row?.category).toBe("Personal"); // override preserved
    expect(row?.amount).toBe("-3.50"); // mutation applied (was already -3.50, but the path ran)
    expect(row?.name).toBe("Starbucks"); // mapper prefers merchant_name over name
  });
});

describe("syncPlaidItemProcessor — Item error handling (P4-24 wiring)", () => {
  it("maps ITEM_LOGIN_REQUIRED to plaid_items.status='login_required' and rethrows", async () => {
    const setup = await freshSetup();
    mockSync.mockRejectedValueOnce({
      response: {
        data: { error_code: "ITEM_LOGIN_REQUIRED", error_message: "Please reauthenticate" },
      },
    });

    await expect(
      syncPlaidItemProcessor(makeJob({ plaidItemPk: setup.plaidItemPk })),
    ).rejects.toBeDefined();

    const [item] = await db.select().from(plaidItems).where(eq(plaidItems.id, setup.plaidItemPk));
    expect(item?.status).toBe("login_required");
    expect(item?.errorCode).toBe("ITEM_LOGIN_REQUIRED");
    expect(item?.errorMessage).toBe("Please reauthenticate");

    const [run] = await db.select().from(plaidSyncRuns);
    expect(run?.finishedAt).toBeInstanceOf(Date);
    expect(run?.error).toBe("ITEM_LOGIN_REQUIRED");
  });
});

describe("syncPlaidItemProcessor — balance anchoring (current-balance reconstruction)", () => {
  it("anchors snapshots to Plaid's current balance and walks backward (not sum-from-zero)", async () => {
    const setup = await freshSetup(); // depository
    mockAccountsGet.mockResolvedValueOnce({
      data: {
        accounts: [
          {
            account_id: setup.plaidAccountId,
            balances: { current: 1000, iso_currency_code: "USD" },
          },
        ],
      },
    });
    mockSyncPages([
      {
        added: [
          // Plaid amount -200 = inflow → stored +200.00 on 05-20 (a deposit).
          plaidTxn(setup, {
            transaction_id: "DEP",
            amount: -200,
            date: "2026-05-20",
            authorized_date: "2026-05-20",
          }),
          // Plaid amount 30 = outflow → stored -30.00 on 05-25 (a purchase).
          plaidTxn(setup, {
            transaction_id: "BUY",
            amount: 30,
            date: "2026-05-25",
            authorized_date: "2026-05-25",
          }),
        ],
        next_cursor: "cur",
        has_more: false,
      },
    ]);

    await syncPlaidItemProcessor(makeJob({ plaidItemPk: setup.plaidItemPk }));

    const byDate = new Map(
      (
        await db
          .select({ date: accountSnapshots.date, balance: accountSnapshots.balance })
          .from(accountSnapshots)
          .where(eq(accountSnapshots.accountId, setup.accountUuid))
      ).map((r) => [r.date, r.balance]),
    );
    // Anchored to current=1000, walking backward:
    //   05-25 (incl BUY)            = 1000.00
    //   05-20 (incl DEP, pre-BUY)   = 1030.00
    // The old sum-from-zero would have produced 170.00 and 200.00 respectively.
    expect(byDate.get("2026-05-25")).toBe("1000.00");
    expect(byDate.get("2026-05-20")).toBe("1030.00");
  });

  it("stores credit-card balances negative (liability), anchored to Plaid current", async () => {
    const setup = await freshSetup();
    await db
      .update(accounts)
      .set({ type: "credit_card" })
      .where(eq(accounts.id, setup.accountUuid));
    mockAccountsGet.mockResolvedValueOnce({
      data: {
        accounts: [
          {
            account_id: setup.plaidAccountId,
            balances: { current: 104.94, iso_currency_code: "USD" },
          },
        ],
      },
    });
    mockSyncPages([{ next_cursor: "cur", has_more: false }]); // no transactions

    await syncPlaidItemProcessor(makeJob({ plaidItemPk: setup.plaidItemPk }));

    const snaps = await db
      .select({ balance: accountSnapshots.balance })
      .from(accountSnapshots)
      .where(eq(accountSnapshots.accountId, setup.accountUuid));
    // One snapshot (today), anchored to -104.94 — a credit card is a liability.
    expect(snaps).toHaveLength(1);
    expect(snaps[0]?.balance).toBe("-104.94");
  });
});

describe("syncPlaidItemProcessor — unmapped Plaid accounts", () => {
  it("drops transactions whose account_id was not mapped (user chose Skip)", async () => {
    const setup = await freshSetup();
    mockSyncPages([
      {
        added: [
          plaidTxn(setup, { transaction_id: "MAPPED-1" }),
          plaidTxn(setup, {
            transaction_id: "UNMAPPED-1",
          }),
        ].map((t, i) => (i === 1 ? { ...t, account_id: "plaid-skipped-account" } : t)),
        next_cursor: "cur",
        has_more: false,
      },
    ]);

    await syncPlaidItemProcessor(makeJob({ plaidItemPk: setup.plaidItemPk }));

    const fitids = (await db.select({ fitid: transactions.fitid }).from(transactions)).map(
      (r) => r.fitid,
    );
    expect(fitids).toEqual(["MAPPED-1"]);
  });
});
