import { createCipheriv, randomBytes } from "node:crypto";
import { expect, test } from "@playwright/test";
import postgres from "postgres";

/**
 * Phase 4 critical flow (P4-33): an Item that hit `ITEM_LOGIN_REQUIRED`
 * surfaces an amber "Reconnect" button on /settings/connections; completing
 * Plaid Link in update mode flips the status back to 'active'.
 *
 * Plaid Link's iframe is famously undriveable headlessly (per PLAN4 P4-32's
 * own note). We bypass that step by directly updating `plaid_items` to the
 * post-Link state — exactly what `finalizeReauthAction` does on Plaid Link
 * success — and verify the UI reflects the new state on reload.
 *
 * The webhook-driven status flip into login_required is exercised by Vitest
 * (src/app/api/plaid/webhook/route.test.ts P4-24 cases). This spec covers the
 * UI lever for recovery.
 */

interface SeededItem {
  plaidItemPk: string;
}

test.describe("phase 4: ITEM_LOGIN_REQUIRED → reconnect → active (P4-33)", () => {
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
      seed = await seedBrokenItem(sql);
    } finally {
      await sql.end();
    }
  });

  test("amber Reconnect surfaces; post-Link DB flip clears it", async ({ page }) => {
    // Bootstrap.
    await page.goto("/");
    await expect(page).toHaveURL(/\/login$/);
    await page.getByLabel("Password").fill("hunter2");
    await page.getByRole("button", { name: /set password/i }).click();
    await expect(page).toHaveURL("/");

    // Connections page surfaces the broken Item with the amber recovery CTA.
    await page.goto("/settings/connections");
    await expect(page.getByText("Reconnect needed")).toBeVisible();
    await expect(page.getByRole("button", { name: /^reconnect$/i })).toBeVisible();
    // The Plaid error code is rendered in red beneath the institution name.
    await expect(page.getByText("ITEM_LOGIN_REQUIRED")).toBeVisible();

    // Simulate the post-Plaid-Link callback that finalizeReauthAction performs.
    // Driving Plaid Link's iframe headlessly is not viable; the production code
    // path (status flip + error clear + sync enqueue) is unit-tested via Vitest
    // (src/app/settings/connections/actions.test.ts).
    await simulatePostReauth(seed.plaidItemPk);

    // Reload — the amber CTA is gone and the Item shows as Active.
    await page.reload();
    await expect(page.getByText("Reconnect needed")).toBeHidden();
    await expect(page.getByRole("button", { name: /^reconnect$/i })).toBeHidden();
    await expect(page.getByText("ITEM_LOGIN_REQUIRED")).toBeHidden();
    // Force-sync button (P4-28) is back — proves the recovered Item is fully
    // operational, not just visually re-styled.
    await expect(page.getByRole("button", { name: /force sync/i })).toBeVisible();
  });
});

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

/** Seed an Item that's already in the broken (post-webhook) state. */
async function seedBrokenItem(sql: postgres.Sql): Promise<SeededItem> {
  const ciphertext = encryptAccessTokenEnvelope("access-sandbox-fake-e2e-reauth");
  const [item] = await sql<{ id: string }[]>`
    INSERT INTO plaid_items (
      plaid_item_id, institution_id, institution_name,
      access_token_ciphertext, products_consented,
      status, error_code, error_message
    ) VALUES (
      'item-e2e-reauth', 'ins_109508', 'First Platypus Bank',
      ${ciphertext}, ARRAY['transactions']::text[],
      'login_required', 'ITEM_LOGIN_REQUIRED',
      'The user must reauthenticate this Item.'
    ) RETURNING id`;
  if (!item) throw new Error("seed: plaid_items insert returned no row");
  return { plaidItemPk: item.id };
}

/**
 * Match the production post-Link callback: status→'active', clear errors,
 * stamp updated_at. This mirrors finalizeReauthAction(plaidItemPk) modulo
 * the sync enqueue (we don't have BullMQ in this spec — the queue side is
 * Vitest-covered).
 */
async function simulatePostReauth(plaidItemPk: string): Promise<void> {
  const databaseUrl =
    process.env.DATABASE_URL ?? "postgres://money:dev_password_change_me@127.0.0.1:5433/money";
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    await sql`
      UPDATE plaid_items
      SET status = 'active', error_code = NULL, error_message = NULL,
          updated_at = NOW()
      WHERE id = ${plaidItemPk}`;
  } finally {
    await sql.end();
  }
}
