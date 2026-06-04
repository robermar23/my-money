import { createCipheriv, randomBytes } from "node:crypto";
import { expect, test } from "@playwright/test";
import {
  Configuration,
  CountryCode,
  PlaidApi,
  PlaidEnvironments,
  Products,
  type SandboxPublicTokenCreateRequest,
} from "plaid";
import postgres from "postgres";

/**
 * Phase 4 critical flow (P4-32): Plaid Link happy path against Sandbox.
 *
 *   bootstrap → /settings/connections → seeded Plaid Item → finish setup →
 *   mapping page (real /accounts/get against First Platypus Bank) → submit
 *   → progress page.
 *
 * Per PLAN4 P4-32: "the test simulates the post-Link callback directly when
 * running in CI". Plaid Link's iframe is undriveable headlessly, so we use
 * Plaid Sandbox's `/sandbox/public_token/create` + `/item/public_token/exchange`
 * to obtain a real access_token, encrypt it locally with the production AEAD
 * format, and INSERT a `plaid_items` row directly. From the mapping page
 * onwards everything is real production code — the server component still
 * calls Plaid's /accounts/get with our seeded access_token.
 *
 * Required env to run:
 *   - PLAID_E2E_SANDBOX=1
 *   - PLAID_CLIENT_ID, PLAID_SECRET, PLAID_ENV=sandbox
 *   - MONEY_ENCRYPTION_KEY (so seeded ciphertext decrypts in the server)
 *   - DATABASE_URL (same DB the dev server reads)
 *
 * The spec skips with a clear message when any prereq is absent. Vitest covers
 * `exchangePublicTokenAction` and `mapAccountsAction` directly, so the lack of
 * iframe drive here is not a coverage gap — only a UI-flow gap.
 */

interface SeededItem {
  plaidItemPk: string;
  /** Plaid account_id of First Platypus Bank's checking account, for form keying. */
  plaidCheckingAccountId: string;
}

interface ExistingAccount {
  id: string;
  name: string;
}

test.describe("phase 4: Plaid Link sandbox happy path (P4-32)", () => {
  let seed: SeededItem;
  let existingAccount: ExistingAccount;

  test.beforeAll(async () => {
    try {
      process.loadEnvFile(".env.local");
    } catch {
      /* CI env */
    }
    const missing = missingPrereqs();
    if (missing.length > 0) {
      test.skip(true, `Missing prereqs for P4-32 spec: ${missing.join(", ")}`);
    }
    const databaseUrl = process.env.DATABASE_URL ?? "";

    const sql = postgres(databaseUrl, { max: 1 });
    try {
      await sql.unsafe(
        "TRUNCATE users, plaid_items, plaid_sync_runs, webhook_log, accounts, transactions, account_snapshots, holdings, liabilities CASCADE",
      );
      const accountRow = await sql<{ id: string }[]>`
        INSERT INTO accounts (name, institution, type, currency)
        VALUES ('Sandbox Checking', 'M&T Bank', 'depository', 'USD')
        RETURNING id`;
      const acct = accountRow[0];
      if (!acct) throw new Error("seed: existing account insert returned no row");
      existingAccount = { id: acct.id, name: "Sandbox Checking" };

      seed = await seedSandboxItem(sql);
    } finally {
      await sql.end();
    }
  });

  test("seeded Item → finish setup → mapping form renders Plaid Checking → submit → progress page", async ({
    page,
  }) => {
    // Bootstrap a single password.
    await page.goto("/");
    await expect(page).toHaveURL(/\/login$/);
    await page.getByLabel("Password").fill("hunter2");
    await page.getByRole("button", { name: /set password/i }).click();
    await expect(page).toHaveURL("/");

    // Connections page lists the seeded Item with the "finish setup" prompt.
    await page.goto("/settings/connections");
    await expect(page.getByRole("heading", { name: "First Platypus Bank" })).toBeVisible();
    await expect(page.getByText(/no accounts mapped yet/i)).toBeVisible();

    await page.getByRole("link", { name: /finish setup/i }).click();
    await expect(page).toHaveURL(new RegExp(`/settings/connections/${seed.plaidItemPk}/map$`));

    // The mapping page renders real Plaid Sandbox account data — Plaid Checking
    // (First Platypus Bank's canonical sandbox checking account) is in the form.
    await expect(
      page.getByRole("heading", { name: /map first platypus bank accounts/i }),
    ).toBeVisible();
    await expect(page.getByText("Plaid Checking")).toBeVisible();

    // The "Link to existing" radio for Plaid Checking should be pre-selected to
    // our seeded "Sandbox Checking" (it's the only eligible depository target).
    const linkToExisting = page.locator(
      `input[type="radio"][name="action_${seed.plaidCheckingAccountId}"][value="link:${existingAccount.id}"]`,
    );
    await expect(linkToExisting).toBeChecked();

    // Every OTHER Plaid account would otherwise default to link-to-the-same
    // existing account (depository accounts) or "create" — the form rejects
    // two Plaid accounts targeting the same my-money account, so flip them
    // all to Skip explicitly.
    const skipRadios = page.locator(
      `input[type="radio"][name^="action_"][value="skip"]:not([name="action_${seed.plaidCheckingAccountId}"])`,
    );
    const skipCount = await skipRadios.count();
    for (let i = 0; i < skipCount; i++) {
      await skipRadios.nth(i).check();
    }

    await page.getByRole("button", { name: /confirm mapping and start initial sync/i }).click();

    // Server action commits + redirects to the polling progress page.
    await expect(page).toHaveURL(new RegExp(`/settings/connections/${seed.plaidItemPk}/progress$`));
    await expect(page.getByRole("heading", { name: /syncing first platypus bank/i })).toBeVisible();

    // Database invariant: the existing "Sandbox Checking" account now carries
    // the Plaid linkage — its `id` was NOT replaced, so any historical rows on
    // that account survive (the P4-13 + P4-22 contract).
    const databaseUrl = process.env.DATABASE_URL ?? "";
    const sql = postgres(databaseUrl, { max: 1 });
    try {
      const rows = await sql<
        { id: string; plaid_item_id: string | null; plaid_account_id: string | null }[]
      >`
        SELECT id, plaid_item_id, plaid_account_id
        FROM accounts WHERE id = ${existingAccount.id}`;
      const row = rows[0];
      expect(row?.id).toBe(existingAccount.id);
      expect(row?.plaid_item_id).toBe(seed.plaidItemPk);
      expect(row?.plaid_account_id).toBe(seed.plaidCheckingAccountId);
    } finally {
      await sql.end();
    }
  });
});

function missingPrereqs(): string[] {
  const required = [
    "PLAID_E2E_SANDBOX",
    "PLAID_CLIENT_ID",
    "PLAID_SECRET",
    "PLAID_ENV",
    "MONEY_ENCRYPTION_KEY",
    "DATABASE_URL",
  ];
  const missing: string[] = [];
  for (const key of required) {
    if (!process.env[key] || process.env[key]?.trim().length === 0) missing.push(key);
  }
  if (process.env.PLAID_E2E_SANDBOX !== "1") {
    if (!missing.includes("PLAID_E2E_SANDBOX")) missing.push("PLAID_E2E_SANDBOX=1");
  }
  if (process.env.PLAID_ENV && process.env.PLAID_ENV !== "sandbox") {
    missing.push("PLAID_ENV must be 'sandbox' for this spec");
  }
  return missing;
}

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

function buildSandboxClient(): PlaidApi {
  const cfg = new Configuration({
    basePath: PlaidEnvironments.sandbox,
    baseOptions: {
      headers: {
        "PLAID-CLIENT-ID": process.env.PLAID_CLIENT_ID ?? "",
        "PLAID-SECRET": process.env.PLAID_SECRET ?? "",
        "Plaid-Version": "2020-09-14",
      },
    },
  });
  return new PlaidApi(cfg);
}

/**
 * Drive Plaid Sandbox: create a sandbox public_token for First Platypus Bank,
 * exchange it for an access_token + item_id, then `/accounts/get` to discover
 * the Plaid Checking account_id we'll target from the form.
 *
 * Encrypts the access_token with the production AEAD envelope and INSERTs the
 * plaid_items row directly. The mapping page will subsequently decrypt via
 * loadAccessToken and call /accounts/get against this same Item.
 */
async function seedSandboxItem(sql: postgres.Sql): Promise<SeededItem> {
  const plaid = buildSandboxClient();
  const sandboxReq: SandboxPublicTokenCreateRequest = {
    institution_id: "ins_109508",
    initial_products: [Products.Transactions],
  };
  const sandboxResp = await plaid.sandboxPublicTokenCreate(sandboxReq);
  const publicToken = sandboxResp.data.public_token;
  if (!publicToken) throw new Error("sandbox public_token not returned");

  const exchange = await plaid.itemPublicTokenExchange({ public_token: publicToken });
  const accessToken = exchange.data.access_token;
  const itemId = exchange.data.item_id;

  const itemGet = await plaid.itemGet({ access_token: accessToken });
  const institutionId = itemGet.data.item.institution_id ?? "ins_109508";

  let institutionName = "First Platypus Bank";
  try {
    const inst = await plaid.institutionsGetById({
      institution_id: institutionId,
      country_codes: [CountryCode.Us],
    });
    institutionName = inst.data.institution.name;
  } catch {
    // Non-fatal — fall back to the hard-coded name.
  }

  const accountsResp = await plaid.accountsGet({ access_token: accessToken });
  const checking = accountsResp.data.accounts.find((a) => a.subtype === "checking");
  if (!checking) throw new Error("sandbox /accounts/get returned no checking account");

  const ciphertext = encryptAccessTokenEnvelope(accessToken);
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO plaid_items (
      plaid_item_id, institution_id, institution_name,
      access_token_ciphertext, products_consented, status
    ) VALUES (
      ${itemId}, ${institutionId}, ${institutionName},
      ${ciphertext}, ARRAY['transactions']::text[], 'active'
    ) RETURNING id`;
  if (!row) throw new Error("seed: plaid_items insert returned no row");

  return { plaidItemPk: row.id, plaidCheckingAccountId: checking.account_id };
}
