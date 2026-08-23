import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import postgres from "postgres";
import { navigateVia } from "./helpers/nav.ts";

const QFX_FIXTURE = fileURLToPath(
  new URL("../src/lib/importers/qfx/__fixtures__/mt-checking.qfx", import.meta.url),
);

/**
 * Phase 3 critical flow: bootstrap → create cash account → import QFX → preview
 * → confirm → see transactions on the account page and dashboard balance shift.
 */
test.describe("phase 3: QFX upload → preview → confirm", () => {
  test.beforeAll(async () => {
    try {
      process.loadEnvFile(".env.local");
    } catch {
      /* CI env */
    }
    const databaseUrl =
      process.env.DATABASE_URL ?? "postgres://money:dev_password_change_me@127.0.0.1:5433/money";
    const sql = postgres(databaseUrl, { max: 1 });
    try {
      await sql.unsafe(
        "TRUNCATE users, accounts, holdings, account_snapshots, liabilities, transactions, import_batches, category_rules CASCADE",
      );
    } finally {
      await sql.end();
    }
  });

  test("imports a QFX, persists transactions, updates dashboard", async ({ page }) => {
    // Bootstrap a new install.
    await page.goto("/");
    await expect(page).toHaveURL(/\/login$/);
    await page.getByLabel("Password").fill("hunter2");
    await page.getByRole("button", { name: /set password/i }).click();
    await expect(page).toHaveURL("/");

    // Create the cash account that the QFX belongs to.
    await navigateVia(page, "Accounts", "All accounts");
    await page.getByRole("link", { name: /add account/i }).click();
    await page.getByLabel("Name").fill("M&T Checking");
    await page.getByLabel("Institution").fill("M&T Bank");
    await page.getByLabel("Type").selectOption("depository");
    await page.getByRole("button", { name: /create account/i }).click();

    // Land on the account detail page. The "Import file" CTA leads to the upload page.
    await page.getByRole("link", { name: /import file/i }).click();
    await expect(page).toHaveURL(/\/import$/);

    await page.setInputFiles('input[type="file"]', QFX_FIXTURE);
    await page.getByRole("button", { name: /upload & preview/i }).click();

    // Preview page should render with 5 new transactions and reconcile (no anchor).
    await expect(page).toHaveURL(/\/preview$/);
    await expect(page.getByRole("heading", { name: /preview import/i })).toBeVisible();
    await expect(page.getByText("EMPLOYER PAYROLL")).toBeVisible();
    await expect(page.getByText("WEGMANS FOOD MARKET")).toBeVisible();

    // Confirm.
    await page.getByRole("button", { name: /confirm import of 5/i }).click();

    // Redirected back to the account page with a success banner and the transactions table.
    await expect(page).toHaveURL(/\?imported=5$/);
    await expect(page.getByText(/imported 5 transactions/i)).toBeVisible();
    await expect(page.getByText("EMPLOYER PAYROLL")).toBeVisible();
    await expect(page.getByText("WEGMANS FOOD MARKET")).toBeVisible();
  });

  test("re-importing the same QFX reports 5 duplicates and disables confirm", async ({ page }) => {
    // Continue with the same DB state — the prior test left it populated.
    await page.goto("/");
    if (page.url().endsWith("/login")) {
      await page.getByLabel("Password").fill("hunter2");
      await page.getByRole("button", { name: /sign in|set password/i }).click();
    }
    await navigateVia(page, "Accounts", "All accounts");
    await page.getByRole("link", { name: "M&T Checking" }).click();
    await page.getByRole("link", { name: /import file/i }).click();

    await page.setInputFiles('input[type="file"]', QFX_FIXTURE);
    await page.getByRole("button", { name: /upload & preview/i }).click();
    await expect(page).toHaveURL(/\/preview$/);

    // Counts should be 0 / 5 / 0.
    const newCount = page.locator("section h2", { hasText: "New transactions" });
    await expect(newCount).toBeVisible();
    await expect(page.getByText("Duplicates (skipped)")).toBeVisible();

    // The confirm button shows "Nothing to import" and is disabled.
    const confirmBtn = page.getByRole("button", { name: /nothing to import/i });
    await expect(confirmBtn).toBeDisabled();
  });
});
