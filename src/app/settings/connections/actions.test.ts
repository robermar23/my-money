// @vitest-environment node
import { db } from "@/db/client.ts";
import { accounts, plaidItems, users } from "@/db/schema/index.ts";
import { isAccessTokenStored, loadAccessToken } from "@/lib/plaid/tokens.ts";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/* ---------------------------------------------------------------------------
 * Module mocks
 *
 * The server actions reach for:
 *   - requireUser() — needs cookies; mocked to a fake user
 *   - plaidClient   — Plaid SDK; mocked to canned responses
 *   - next/navigation.redirect — throws in production; mocked to capture path
 *   - next/cache.revalidatePath — no-op in tests
 *
 * Everything else (DB, encryption, BullMQ) runs for real.
 * --------------------------------------------------------------------------- */

const fakeUserId = "00000000-0000-0000-0000-000000000001";

vi.mock("@/lib/auth/require-user.ts", () => ({
  requireUser: vi.fn(async () => ({
    id: fakeUserId,
    passwordHash: "fake",
    createdAt: new Date(),
    updatedAt: new Date(),
  })),
}));

// We control responses on a per-test basis.
const mockPlaid = {
  linkTokenCreate: vi.fn(),
  itemPublicTokenExchange: vi.fn(),
  itemGet: vi.fn(),
  institutionsGetById: vi.fn(),
  accountsGet: vi.fn(),
  itemRemove: vi.fn(),
};
vi.mock("@/lib/plaid/client.ts", () => ({
  plaidClient: mockPlaid,
  plaidEnvironment: () => "sandbox",
}));

const redirectMock = vi.fn((path: string) => {
  // Mimic next/navigation.redirect: throws a sentinel so callers stop.
  throw new RedirectError(path);
});
class RedirectError extends Error {
  constructor(public readonly path: string) {
    super(`__redirect__:${path}`);
  }
}
vi.mock("next/navigation", () => ({
  redirect: (path: string) => redirectMock(path),
  notFound: () => {
    throw new Error("__notFound__");
  },
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

// P4-22 verification: mapAccountsAction must enqueue an initial sync on commit.
interface JobAddArgs {
  data: { plaidItemPk?: string; trigger?: string };
  opts: { jobId?: string };
}
const mockQueueAdd = vi.fn<
  (name: string, data: JobAddArgs["data"], opts: JobAddArgs["opts"]) => Promise<{ id: string }>
>(async () => ({ id: "test-job-id" }));
vi.mock("@/lib/queue/queues.ts", () => ({
  QUEUE_NAMES: { SYNC_PLAID_ITEM: "sync-plaid-item" },
  syncPlaidItemQueue: { add: mockQueueAdd },
}));

// Import AFTER mocks are registered.
const {
  createLinkTokenAction,
  exchangePublicTokenAction,
  finalizeReauthAction,
  disconnectItemAction,
} = await import("./actions.ts");
const { mapAccountsAction } = await import("./map-actions.ts");

async function resetDomain(): Promise<void> {
  await db.execute(
    sql`TRUNCATE plaid_items, plaid_sync_runs, accounts, account_snapshots, transactions, import_batches, users CASCADE`,
  );
  // Re-seed the single fake user the requireUser mock returns.
  await db.insert(users).values({ id: fakeUserId, passwordHash: "fake" });
}

beforeEach(async () => {
  await resetDomain();
  redirectMock.mockClear();
  mockPlaid.linkTokenCreate.mockReset();
  mockPlaid.itemPublicTokenExchange.mockReset();
  mockPlaid.itemGet.mockReset();
  mockPlaid.institutionsGetById.mockReset();
  mockPlaid.accountsGet.mockReset();
  mockPlaid.itemRemove.mockReset();
  mockQueueAdd.mockClear();
});

afterEach(() => {
  vi.clearAllMocks();
});

/* ---------------------------------------------------------------------------
 * P4-10 — createLinkTokenAction
 * --------------------------------------------------------------------------- */

describe("createLinkTokenAction (P4-10)", () => {
  it("returns a fresh token on each call", async () => {
    mockPlaid.linkTokenCreate
      .mockResolvedValueOnce({ data: { link_token: "link-sandbox-AAA" } })
      .mockResolvedValueOnce({ data: { link_token: "link-sandbox-BBB" } });

    const a = await createLinkTokenAction();
    const b = await createLinkTokenAction();

    expect(a.linkToken).toBe("link-sandbox-AAA");
    expect(b.linkToken).toBe("link-sandbox-BBB");
    expect(a.linkToken).not.toBe(b.linkToken);
    expect(mockPlaid.linkTokenCreate).toHaveBeenCalledTimes(2);
  });

  it("requests products=['transactions'] in normal mode", async () => {
    mockPlaid.linkTokenCreate.mockResolvedValueOnce({ data: { link_token: "link-x" } });
    await createLinkTokenAction();
    const call = mockPlaid.linkTokenCreate.mock.calls[0]?.[0];
    expect(call?.products).toEqual(["transactions"]);
    expect(call?.access_token).toBeUndefined();
    expect(call?.user.client_user_id).toBe(fakeUserId);
  });
});

/* ---------------------------------------------------------------------------
 * P4-12 — exchangePublicTokenAction
 * --------------------------------------------------------------------------- */

function mockSuccessfulExchange(opts: { accessToken: string; itemId: string }): void {
  mockPlaid.itemPublicTokenExchange.mockResolvedValueOnce({
    data: { access_token: opts.accessToken, item_id: opts.itemId, request_id: "req-1" },
  });
  mockPlaid.itemGet.mockResolvedValueOnce({
    data: { item: { item_id: opts.itemId, institution_id: "ins_109508" } },
  });
  mockPlaid.institutionsGetById.mockResolvedValueOnce({
    data: { institution: { institution_id: "ins_109508", name: "First Platypus Bank" } },
  });
}

describe("exchangePublicTokenAction (P4-12)", () => {
  it("persists a plaid_items row with an encrypted token that decrypts back to the original", async () => {
    const original = "access-sandbox-abc-def-123";
    mockSuccessfulExchange({ accessToken: original, itemId: "item-id-1" });

    let redirectedTo: string | undefined;
    try {
      await exchangePublicTokenAction("public-sandbox-XXX");
    } catch (e) {
      if (e instanceof RedirectError) redirectedTo = e.path;
      else throw e;
    }

    // Row landed.
    const [row] = await db
      .select({
        id: plaidItems.id,
        plaidItemId: plaidItems.plaidItemId,
        institutionName: plaidItems.institutionName,
        status: plaidItems.status,
      })
      .from(plaidItems)
      .where(eq(plaidItems.plaidItemId, "item-id-1"));
    expect(row).toBeDefined();
    expect(row?.institutionName).toBe("First Platypus Bank");
    expect(row?.status).toBe("active");

    // Token roundtrips through encrypt/decrypt.
    if (row) {
      const decrypted = await loadAccessToken(row.id);
      expect(decrypted).toBe(original);

      // Redirect target uses our internal UUID, not Plaid's text id.
      expect(redirectedTo).toBe(`/settings/connections/${row.id}/map`);
    }
  });

  it("returns an error and does not persist when Plaid's exchange call fails", async () => {
    mockPlaid.itemPublicTokenExchange.mockRejectedValueOnce({
      response: { data: { error_code: "INVALID_PUBLIC_TOKEN", error_message: "stale" } },
    });

    const result = await exchangePublicTokenAction("public-sandbox-bad");
    expect(result.error).toMatch(/INVALID_PUBLIC_TOKEN/);
    expect(redirectMock).not.toHaveBeenCalled();
    expect(await db.select().from(plaidItems)).toHaveLength(0);
  });

  it("falls back to 'Unknown' institution name if institutionsGetById fails", async () => {
    mockPlaid.itemPublicTokenExchange.mockResolvedValueOnce({
      data: { access_token: "tok-fallback", item_id: "item-fallback" },
    });
    mockPlaid.itemGet.mockResolvedValueOnce({
      data: { item: { item_id: "item-fallback", institution_id: "ins_unknown" } },
    });
    mockPlaid.institutionsGetById.mockRejectedValueOnce(new Error("Plaid timed out"));

    try {
      await exchangePublicTokenAction("public-sandbox-XYZ");
    } catch (e) {
      if (!(e instanceof RedirectError)) throw e;
    }
    const [row] = await db
      .select({ institutionName: plaidItems.institutionName })
      .from(plaidItems)
      .where(eq(plaidItems.plaidItemId, "item-fallback"));
    expect(row?.institutionName).toBe("Unknown");
  });
});

/* ---------------------------------------------------------------------------
 * P4-13 — mapAccountsAction
 * --------------------------------------------------------------------------- */

async function seedItem(): Promise<string> {
  mockSuccessfulExchange({ accessToken: "tok-map", itemId: "item-map" });
  try {
    await exchangePublicTokenAction("public-sandbox-MAP");
  } catch (e) {
    if (!(e instanceof RedirectError)) throw e;
  }
  const [row] = await db
    .select({ id: plaidItems.id })
    .from(plaidItems)
    .where(eq(plaidItems.plaidItemId, "item-map"));
  if (!row) throw new Error("seedItem failed");
  return row.id;
}

const PLAID_ACCOUNTS_TWO = [
  {
    account_id: "Aplaidchecking01",
    name: "Plaid Checking",
    official_name: "Plaid Gold Standard 0% Interest Checking",
    type: "depository",
    subtype: "checking",
    mask: "0000",
    balances: { iso_currency_code: "USD", available: 100, current: 110 },
  },
  {
    account_id: "Bplaidsavings002",
    name: "Plaid Saving",
    official_name: "Plaid Silver Standard 0.1% Interest Saving",
    type: "depository",
    subtype: "savings",
    mask: "1111",
    balances: { iso_currency_code: "USD", available: 200, current: 210 },
  },
];

describe("mapAccountsAction (P4-13)", () => {
  it("LINK preserves the existing account's row identity (snapshots survive)", async () => {
    const plaidItemPk = await seedItem();

    // Seed an existing manual account the user will link Plaid Checking to.
    const [existing] = await db
      .insert(accounts)
      .values({
        name: "M&T Checking (manual)",
        institution: "M&T Bank",
        type: "depository",
        currency: "USD",
      })
      .returning({ id: accounts.id });
    if (!existing) throw new Error("seed existing account");

    // The mapping page's /accounts/get re-fetch — return our canned 2-account list.
    mockPlaid.accountsGet.mockResolvedValueOnce({ data: { accounts: PLAID_ACCOUNTS_TWO } });

    const form = new FormData();
    form.set(`action_${PLAID_ACCOUNTS_TWO[0]?.account_id}`, `link:${existing.id}`);
    form.set(`action_${PLAID_ACCOUNTS_TWO[1]?.account_id}`, "skip");

    try {
      await mapAccountsAction(plaidItemPk, form);
    } catch (e) {
      if (!(e instanceof RedirectError)) throw e;
    }

    // The existing row still exists (id unchanged), now wired to Plaid.
    const [linked] = await db.select().from(accounts).where(eq(accounts.id, existing.id));
    expect(linked).toBeDefined();
    expect(linked?.plaidItemId).toBe(plaidItemPk);
    expect(linked?.plaidAccountId).toBe(PLAID_ACCOUNTS_TWO[0]?.account_id);
    expect(linked?.plaidMask).toBe("0000");
    expect(linked?.name).toBe("M&T Checking (manual)"); // preserved, not overwritten

    // The skipped account did NOT create a row.
    const [skipped] = await db
      .select({ id: accounts.id })
      .from(accounts)
      .where(eq(accounts.plaidAccountId, PLAID_ACCOUNTS_TWO[1]?.account_id ?? ""));
    expect(skipped).toBeUndefined();

    // P4-22: an initial sync job was enqueued with our internal UUID.
    expect(mockQueueAdd).toHaveBeenCalledTimes(1);
    const call = mockQueueAdd.mock.calls[0];
    expect(call?.[0]).toBe("sync-plaid-item");
    expect(call?.[1]?.plaidItemPk).toBe(plaidItemPk);
    expect(call?.[1]?.trigger).toBe("initial");
    // Double-submit guard: pinned jobId keeps a re-run from spawning a second initial sync.
    expect(call?.[2]?.jobId).toBe(`sync-plaid-item-initial-${plaidItemPk}`);
  });

  it("CREATE inserts a fresh account with type='depository' from a Plaid 'checking' account", async () => {
    const plaidItemPk = await seedItem();
    mockPlaid.accountsGet.mockResolvedValueOnce({ data: { accounts: PLAID_ACCOUNTS_TWO } });

    const form = new FormData();
    form.set(`action_${PLAID_ACCOUNTS_TWO[0]?.account_id}`, "create");
    form.set(`create_name_${PLAID_ACCOUNTS_TWO[0]?.account_id}`, "M&T Checking (fresh)");
    form.set(`action_${PLAID_ACCOUNTS_TWO[1]?.account_id}`, "skip");

    try {
      await mapAccountsAction(plaidItemPk, form);
    } catch (e) {
      if (!(e instanceof RedirectError)) throw e;
    }

    const created = await db
      .select()
      .from(accounts)
      .where(eq(accounts.plaidAccountId, PLAID_ACCOUNTS_TWO[0]?.account_id ?? ""));
    expect(created).toHaveLength(1);
    expect(created[0]?.type).toBe("depository");
    expect(created[0]?.name).toBe("M&T Checking (fresh)");
    expect(created[0]?.institution).toBe("First Platypus Bank");
    expect(created[0]?.currency).toBe("USD");
    expect(created[0]?.plaidItemId).toBe(plaidItemPk);
    expect(created[0]?.plaidMask).toBe("0000");
  });

  it("refuses to map two Plaid accounts to the same existing my-money account", async () => {
    const plaidItemPk = await seedItem();
    const [existing] = await db
      .insert(accounts)
      .values({
        name: "Shared target",
        institution: "M&T Bank",
        type: "depository",
        currency: "USD",
      })
      .returning({ id: accounts.id });
    if (!existing) throw new Error("seed");

    mockPlaid.accountsGet.mockResolvedValueOnce({ data: { accounts: PLAID_ACCOUNTS_TWO } });
    const form = new FormData();
    form.set(`action_${PLAID_ACCOUNTS_TWO[0]?.account_id}`, `link:${existing.id}`);
    form.set(`action_${PLAID_ACCOUNTS_TWO[1]?.account_id}`, `link:${existing.id}`);

    const result = await mapAccountsAction(plaidItemPk, form);
    expect(result.error).toMatch(/same existing account/);
    // Nothing landed.
    const [after] = await db
      .select({ plaidItemId: accounts.plaidItemId })
      .from(accounts)
      .where(eq(accounts.id, existing.id));
    expect(after?.plaidItemId).toBeNull();
  });

  it("refuses to map Plaid 'other' type — has no my-money equivalent", async () => {
    const plaidItemPk = await seedItem();
    const otherAccounts = [
      {
        account_id: "Cplaidother00003",
        name: "Mystery Account",
        official_name: null,
        type: "other",
        subtype: null,
        mask: "9999",
        balances: { iso_currency_code: "USD" },
      },
    ];
    mockPlaid.accountsGet.mockResolvedValueOnce({ data: { accounts: otherAccounts } });

    const form = new FormData();
    form.set(`action_${otherAccounts[0]?.account_id}`, "create");

    const result = await mapAccountsAction(plaidItemPk, form);
    expect(result.error).toMatch(/no my-money equivalent/);
  });
});

/* ---------------------------------------------------------------------------
 * P4-25 — finalizeReauthAction
 * --------------------------------------------------------------------------- */

describe("finalizeReauthAction (P4-25)", () => {
  it("flips a login_required Item back to active, clears errors, enqueues a sync", async () => {
    const plaidItemPk = await seedItem();
    await db
      .update(plaidItems)
      .set({
        status: "login_required",
        errorCode: "ITEM_LOGIN_REQUIRED",
        errorMessage: "Please reauthenticate",
      })
      .where(eq(plaidItems.id, plaidItemPk));

    const result = await finalizeReauthAction(plaidItemPk);
    expect(result.error).toBeUndefined();

    const [after] = await db
      .select({
        status: plaidItems.status,
        errorCode: plaidItems.errorCode,
        errorMessage: plaidItems.errorMessage,
      })
      .from(plaidItems)
      .where(eq(plaidItems.id, plaidItemPk));
    expect(after?.status).toBe("active");
    expect(after?.errorCode).toBeNull();
    expect(after?.errorMessage).toBeNull();

    expect(mockQueueAdd).toHaveBeenCalledTimes(1);
    const call = mockQueueAdd.mock.calls[0];
    expect(call?.[1]?.plaidItemPk).toBe(plaidItemPk);
    expect(call?.[1]?.trigger).toBe("manual");
  });

  it("returns an error when the Item does not exist", async () => {
    const result = await finalizeReauthAction("00000000-0000-0000-0000-000000000000");
    expect(result.error).toMatch(/not found/i);
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });
});

/* ---------------------------------------------------------------------------
 * P4-26 — disconnectItemAction
 * --------------------------------------------------------------------------- */

describe("disconnectItemAction (P4-26)", () => {
  it("calls Plaid /item/remove, marks the Item removed, wipes the ciphertext, NULLs the account FKs, but leaves transactions + snapshots in place", async () => {
    const plaidItemPk = await seedItem();
    mockPlaid.itemRemove.mockResolvedValueOnce({ data: { request_id: "req-rm" } });

    // Map an account to the item + give it some history.
    const [acct] = await db
      .insert(accounts)
      .values({
        name: "Disconnect Test",
        institution: "Test Bank",
        type: "depository",
        currency: "USD",
        plaidItemId: plaidItemPk,
        plaidAccountId: "PLAID-acct-disconnect",
        plaidMask: "1234",
      })
      .returning({ id: accounts.id });
    if (!acct) throw new Error("seed account");

    const { transactions, accountSnapshots } = await import("@/db/schema/index.ts");
    await db.insert(transactions).values({
      accountId: acct.id,
      postedAt: "2026-04-01",
      amount: "-10.00",
      name: "Pre-existing",
      fitid: "preserved-1",
      source: "plaid",
    });
    await db.insert(accountSnapshots).values({
      accountId: acct.id,
      date: "2026-04-01",
      balance: "-10.00",
    });

    const result = await disconnectItemAction(plaidItemPk);
    expect(result.error).toBeUndefined();

    // Plaid was called.
    expect(mockPlaid.itemRemove).toHaveBeenCalledTimes(1);

    // Item is tombstoned + ciphertext wiped (no column literal — use the
    // tokens.ts helper to honor the visibility regression).
    const [after] = await db
      .select({ status: plaidItems.status })
      .from(plaidItems)
      .where(eq(plaidItems.id, plaidItemPk));
    expect(after?.status).toBe("removed");
    expect(await isAccessTokenStored(plaidItemPk)).toBe(false);

    // Account's Plaid linkage is severed.
    const [accountAfter] = await db.select().from(accounts).where(eq(accounts.id, acct.id));
    expect(accountAfter?.plaidItemId).toBeNull();
    expect(accountAfter?.plaidAccountId).toBeNull();
    expect(accountAfter?.plaidMask).toBeNull();

    // History stays.
    const txns = await db
      .select({ fitid: transactions.fitid })
      .from(transactions)
      .where(eq(transactions.accountId, acct.id));
    expect(txns.map((t) => t.fitid)).toEqual(["preserved-1"]);

    const snaps = await db
      .select({ date: accountSnapshots.date })
      .from(accountSnapshots)
      .where(eq(accountSnapshots.accountId, acct.id));
    expect(snaps.map((s) => s.date)).toEqual(["2026-04-01"]);
  });

  it("proceeds with local cleanup even if Plaid /item/remove fails", async () => {
    const plaidItemPk = await seedItem();
    mockPlaid.itemRemove.mockRejectedValueOnce(new Error("Plaid 502"));

    const result = await disconnectItemAction(plaidItemPk);
    // No surfaced error — Plaid failure is logged + ignored.
    expect(result.error).toBeUndefined();

    const [after] = await db
      .select({ status: plaidItems.status })
      .from(plaidItems)
      .where(eq(plaidItems.id, plaidItemPk));
    expect(after?.status).toBe("removed");
    expect(await isAccessTokenStored(plaidItemPk)).toBe(false);
  });
});
