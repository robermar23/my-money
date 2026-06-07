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
 * Phase 5 critical flows (P5-26).
 *
 * 1. MANUAL PATH (always runs against the dev DB): create an investment
 *    account → add a holding → seed a price → record two cost-basis lots →
 *    the /investments dashboard shows value, summed cost basis, and gain/loss.
 *    No Plaid creds needed — prices are seeded via SQL (the fetcher itself is
 *    unit-tested).
 *
 * 2. PLAID INVESTMENTS PATH (gated on PLAID_E2E_SANDBOX=1): seed an
 *    `investments`-consented Item against Plaid Sandbox, map its investment
 *    account, and confirm the redirect to the progress page + the DB linkage.
 *    The initial holdings/transactions sync runs in the BullMQ worker (not
 *    started by the Playwright webServer), so — exactly like the Phase 4 specs
 *    — we assert up to the progress page; the sync itself is Vitest-covered
 *    (P5-16).
 */

const DEFAULT_DB = "postgres://money:dev_password_change_me@127.0.0.1:5433/money";

function dbUrl(): string {
  return process.env.DATABASE_URL ?? DEFAULT_DB;
}

test.describe("phase 5: manual investments → /investments dashboard (P5-26)", () => {
  test.beforeAll(async () => {
    try {
      process.loadEnvFile(".env.local");
    } catch {
      /* CI env */
    }
    const sql = postgres(dbUrl(), { max: 1 });
    try {
      await sql.unsafe(
        "TRUNCATE users, accounts, holdings, holding_lots, investment_transactions, securities, account_snapshots, liabilities, prices CASCADE",
      );
    } finally {
      await sql.end();
    }
  });

  test("holding + two lots + price → positions, cost basis, gain/loss", async ({ page }) => {
    // ── Bootstrap ───────────────────────────────────────────────────────────
    await page.goto("/");
    await expect(page).toHaveURL(/\/login$/);
    await page.getByLabel("Password").fill("hunter2");
    await page.getByRole("button", { name: /set password/i }).click();
    await expect(page).toHaveURL("/");

    // ── Create a Fidelity investment account ────────────────────────────────
    await page.goto("/accounts/new");
    await page.getByLabel("Name").fill("Fidelity Brokerage");
    await page.getByLabel("Institution").fill("Fidelity");
    await page.getByLabel("Type").selectOption("investment");
    await page.getByRole("button", { name: /create account/i }).click();
    await expect(page).toHaveURL(/\/accounts\/[0-9a-f-]+$/);

    // ── Add a 10-share AAPL holding ─────────────────────────────────────────
    await page.getByLabel("Symbol").fill("AAPL");
    await page.getByLabel("Asset class").selectOption("equity");
    await page.getByLabel("Quantity").fill("10");
    await page.getByLabel("Unit").selectOption("shares");
    await page.getByRole("button", { name: /save holding/i }).click();
    await expect(page.getByText(/saved/i).first()).toBeVisible();

    // ── Seed today's AAPL price (as if fetch-prices-daily ran): $234.56 ──────
    const today = new Date().toISOString().slice(0, 10);
    const sql = postgres(dbUrl(), { max: 1 });
    try {
      await sql`
        INSERT INTO prices (symbol, date, close, source)
        VALUES ('AAPL', ${today}, '234.56000000', 'manual')
        ON CONFLICT (symbol, date) DO UPDATE SET close = EXCLUDED.close`;
    } finally {
      await sql.end();
    }
    await page.reload();

    // ── Record two cost-basis lots (5 sh @ $1,000 each → $2,000 total) ───────
    // The per-holding editor summary reads "AAPL — N lots".
    const editor = page.locator("details", { hasText: /AAPL — \d+ lot/ });
    await editor.locator("summary").click();
    for (let i = 0; i < 2; i++) {
      await editor.getByPlaceholder("10").fill("5");
      await editor.getByPlaceholder("1000.00").fill("1000.00");
      await editor.getByRole("button", { name: /add lot/i }).click();
      // Wait for the RSC refresh to land the new lot row.
      await expect(editor.getByText("manual").nth(i)).toBeVisible();
    }

    // ── /investments shows value, summed basis, and gain/loss ───────────────
    await page.goto("/investments");
    await expect(page.getByRole("heading", { name: "Investments" })).toBeVisible();
    // Portfolio header total value: 10 × $234.56 = $2,345.60.
    await expect(page.getByText("$2,345.60").first()).toBeVisible();
    // Cost basis (sum of lots) = $2,000.00; gain = $345.60 (17.28%).
    await expect(page.getByText("$2,000.00").first()).toBeVisible();
    await expect(page.getByText(/\$345\.60 \(17\.28%\)/).first()).toBeVisible();
    // Allocation legend: a single equity slice at 100.00%.
    await expect(page.getByText("Equity")).toBeVisible();
    await expect(page.getByText(/100\.00%/).first()).toBeVisible();
  });
});

/* ---------------------------------------------------------------------------
 * Plaid Sandbox investments path — gated.
 * --------------------------------------------------------------------------- */

interface SeededItem {
  plaidItemPk: string;
  plaidInvestmentAccountId: string;
  institutionName: string;
}

test.describe("phase 5: Plaid investments mapping (P5-26, gated)", () => {
  let seed: SeededItem;

  test.beforeAll(async () => {
    try {
      process.loadEnvFile(".env.local");
    } catch {
      /* CI env */
    }
    const missing = missingPrereqs();
    if (missing.length > 0) {
      test.skip(true, `Missing prereqs for the Plaid investments spec: ${missing.join(", ")}`);
    }
    const sql = postgres(dbUrl(), { max: 1 });
    try {
      await sql.unsafe(
        "TRUNCATE users, plaid_items, plaid_sync_runs, webhook_log, accounts, holdings, holding_lots, investment_transactions, securities, account_snapshots, liabilities CASCADE",
      );
      seed = await seedSandboxInvestmentsItem(sql);
    } finally {
      await sql.end();
    }
  });

  test("seeded investments Item → map → progress page + account linkage", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/login$/);
    await page.getByLabel("Password").fill("hunter2");
    await page.getByRole("button", { name: /set password/i }).click();
    await expect(page).toHaveURL("/");

    await page.goto(`/settings/connections/${seed.plaidItemPk}/map`);
    // Map the Plaid investment account by creating a new my-money account.
    const createRadio = page.locator(
      `input[type="radio"][name="action_${seed.plaidInvestmentAccountId}"][value="create"]`,
    );
    await createRadio.check();
    // Any other accounts on the Item → Skip to avoid duplicate-link rejection.
    const skipRadios = page.locator(
      `input[type="radio"][name^="action_"][value="skip"]:not([name="action_${seed.plaidInvestmentAccountId}"])`,
    );
    const skipCount = await skipRadios.count();
    for (let i = 0; i < skipCount; i++) await skipRadios.nth(i).check();

    await page.getByRole("button", { name: /confirm mapping/i }).click();
    await expect(page).toHaveURL(new RegExp(`/settings/connections/${seed.plaidItemPk}/progress$`));

    // DB invariant: a new investment account is linked to the Item.
    const sql = postgres(dbUrl(), { max: 1 });
    try {
      const rows = await sql<{ type: string; plaid_item_id: string | null }[]>`
        SELECT type, plaid_item_id FROM accounts
        WHERE plaid_account_id = ${seed.plaidInvestmentAccountId}`;
      expect(rows[0]?.type).toBe("investment");
      expect(rows[0]?.plaid_item_id).toBe(seed.plaidItemPk);
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
  const missing = required.filter((k) => !process.env[k] || process.env[k]?.trim().length === 0);
  if (process.env.PLAID_E2E_SANDBOX !== "1" && !missing.includes("PLAID_E2E_SANDBOX")) {
    missing.push("PLAID_E2E_SANDBOX=1");
  }
  if (process.env.PLAID_ENV && process.env.PLAID_ENV !== "sandbox") {
    missing.push("PLAID_ENV must be 'sandbox'");
  }
  return missing;
}

function encryptAccessTokenEnvelope(plaintext: string): Buffer {
  const keyRaw = process.env.MONEY_ENCRYPTION_KEY;
  if (!keyRaw) throw new Error("MONEY_ENCRYPTION_KEY not set");
  const key = Buffer.from(keyRaw.trim(), "base64");
  if (key.length !== 32) throw new Error(`key decoded to ${key.length} bytes; expected 32`);
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ct = Buffer.concat([cipher.update(Buffer.from(plaintext, "utf8")), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([Buffer.from([0x01]), nonce, ct, tag]);
}

function buildSandboxClient(): PlaidApi {
  return new PlaidApi(
    new Configuration({
      basePath: PlaidEnvironments.sandbox,
      baseOptions: {
        headers: {
          "PLAID-CLIENT-ID": process.env.PLAID_CLIENT_ID ?? "",
          "PLAID-SECRET": process.env.PLAID_SECRET ?? "",
          "Plaid-Version": "2020-09-14",
        },
      },
    }),
  );
}

async function seedSandboxInvestmentsItem(sql: postgres.Sql): Promise<SeededItem> {
  const plaid = buildSandboxClient();
  const req: SandboxPublicTokenCreateRequest = {
    institution_id: "ins_109508",
    initial_products: [Products.Investments],
  };
  const sandboxResp = await plaid.sandboxPublicTokenCreate(req);
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
    /* fall back */
  }

  const accountsResp = await plaid.accountsGet({ access_token: accessToken });
  const investment = accountsResp.data.accounts.find(
    (a) => a.type === "investment" || a.type === "brokerage",
  );
  if (!investment) throw new Error("sandbox /accounts/get returned no investment account");

  const ciphertext = encryptAccessTokenEnvelope(accessToken);
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO plaid_items (
      plaid_item_id, institution_id, institution_name,
      access_token_ciphertext, products_consented, status
    ) VALUES (
      ${itemId}, ${institutionId}, ${institutionName},
      ${ciphertext}, ARRAY['investments']::text[], 'active'
    ) RETURNING id`;
  if (!row) throw new Error("seed: plaid_items insert returned no row");

  return {
    plaidItemPk: row.id,
    plaidInvestmentAccountId: investment.account_id,
    institutionName,
  };
}
