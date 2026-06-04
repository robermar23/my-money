import { createCipheriv, randomBytes } from "node:crypto";
import { expect, test } from "@playwright/test";
import postgres from "postgres";

/**
 * Phase 4 critical flow (P4-34): disconnect a Plaid Item from the connections
 * page → confirm the Item disappears, but every prior transaction and snapshot
 * remains untouched.
 *
 * Per CLAUDE.md §Domain Scope: preserving history is the entire product. The
 * UI lever a user pulls is the Disconnect button on /settings/connections —
 * this spec drives that lever.
 *
 * Setup bypasses the Plaid Link iframe by directly encrypting a (fake but
 * envelope-valid) access_token and seeding `plaid_items` via SQL. The
 * `disconnectItemAction` tolerates Plaid /item/remove failures — see the
 * action — so a fake token doesn't break the local cleanup path under test.
 */

interface SeededItem {
  plaidItemPk: string;
  accountId: string;
}

test.describe("phase 4: disconnect preserves history (P4-34)", () => {
  let seed: SeededItem;

  test.beforeAll(async () => {
    try {
      process.loadEnvFile(".env.local");
    } catch {
      /* CI env */
    }
    if (!process.env.MONEY_ENCRYPTION_KEY) {
      test.skip(true, "MONEY_ENCRYPTION_KEY required for Phase 4 specs");
    }
    const databaseUrl =
      process.env.DATABASE_URL ?? "postgres://money:dev_password_change_me@127.0.0.1:5433/money";

    const sql = postgres(databaseUrl, { max: 1 });
    try {
      await sql.unsafe(
        "TRUNCATE users, plaid_items, plaid_sync_runs, webhook_log, accounts, transactions, account_snapshots, holdings, liabilities CASCADE",
      );
      seed = await seedItemWithHistory(sql);
    } finally {
      await sql.end();
    }
  });

  test("Disconnect removes the Item from connections but keeps transactions visible", async ({
    page,
  }) => {
    // Bootstrap a single password — the test runs after a fresh truncate.
    await page.goto("/");
    await expect(page).toHaveURL(/\/login$/);
    await page.getByLabel("Password").fill("hunter2");
    await page.getByRole("button", { name: /set password/i }).click();
    await expect(page).toHaveURL("/");

    // The connections page lists the seeded Item.
    await page.goto("/settings/connections");
    await expect(page.getByRole("heading", { name: "Bank connections" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "First Platypus Bank" })).toBeVisible();
    await expect(page.getByText("Disconnect Test Account")).toBeVisible();

    // Auto-accept the native confirm() dialog the Disconnect button raises.
    page.once("dialog", (dialog) => {
      void dialog.accept();
    });
    await page.getByRole("button", { name: /^disconnect$/i }).click();

    // Connections page revalidates — the Item is gone (status='removed' is
    // filtered out of the list).
    await expect(page.getByRole("heading", { name: "First Platypus Bank" })).toBeHidden();
    await expect(page.getByText(/no connections yet/i)).toBeVisible();

    // The transaction we seeded is still visible on the account detail page —
    // this is the heart of the test (P4-34 guarantee).
    await page.goto(`/accounts/${seed.accountId}`);
    await expect(page.getByText("Pre-disconnect SBUX")).toBeVisible();
  });
});

/**
 * Inline AEAD envelope encryption — matches src/lib/crypto/aead.ts on-disk
 * format so the production loadAccessToken can decrypt our seeded ciphertext.
 *
 * We don't import the aead module directly because the e2e specs intentionally
 * avoid pulling src/ modules (Playwright doesn't run the server-only loader).
 * The envelope is `0x01 || nonce(12) || ct || tag(16)`.
 */
function encryptAccessTokenEnvelope(plaintext: string): Buffer {
  const keyRaw = process.env.MONEY_ENCRYPTION_KEY;
  if (!keyRaw) throw new Error("MONEY_ENCRYPTION_KEY not set");
  const key = Buffer.from(keyRaw.trim(), "base64");
  if (key.length !== 32) {
    throw new Error(`MONEY_ENCRYPTION_KEY decoded to ${key.length} bytes; expected 32.`);
  }
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ct = Buffer.concat([cipher.update(Buffer.from(plaintext, "utf8")), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([Buffer.from([0x01]), nonce, ct, tag]);
}

/** Seed an Item + linked account + a single transaction + a snapshot. */
async function seedItemWithHistory(sql: postgres.Sql): Promise<SeededItem> {
  const ciphertext = encryptAccessTokenEnvelope("access-sandbox-fake-e2e-disconnect");
  const [item] = await sql<{ id: string }[]>`
    INSERT INTO plaid_items (
      plaid_item_id, institution_id, institution_name,
      access_token_ciphertext, products_consented, status
    ) VALUES (
      'item-e2e-disconnect', 'ins_109508', 'First Platypus Bank',
      ${ciphertext}, ARRAY['transactions']::text[], 'active'
    ) RETURNING id`;
  if (!item) throw new Error("seed: plaid_items insert returned no row");

  const [acct] = await sql<{ id: string }[]>`
    INSERT INTO accounts (
      name, institution, type, currency,
      plaid_item_id, plaid_account_id, plaid_mask
    ) VALUES (
      'Disconnect Test Account', 'First Platypus Bank', 'depository', 'USD',
      ${item.id}, 'plaid-acct-disconnect', '0001'
    ) RETURNING id`;
  if (!acct) throw new Error("seed: accounts insert returned no row");

  await sql`
    INSERT INTO transactions (account_id, posted_at, amount, name, fitid, source)
    VALUES (${acct.id}, '2026-05-15', '-5.45', 'Pre-disconnect SBUX', 'fitid-disc-1', 'plaid')`;

  await sql`
    INSERT INTO account_snapshots (account_id, date, balance)
    VALUES (${acct.id}, '2026-05-15', '1234.56')`;

  return { plaidItemPk: item.id, accountId: acct.id };
}
