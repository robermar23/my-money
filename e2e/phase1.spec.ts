import { expect, test } from "@playwright/test";
import postgres from "postgres";

/**
 * Phase 1 critical flow: bootstrap → create checking account → enter balance
 * → create mortgage → see net worth on the dashboard.
 *
 * Truncates domain tables before running so this spec is independent of any
 * other spec's state (auth.spec leaves a user row behind).
 */
test.describe("phase 1: manual entry → net worth on dashboard", () => {
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
        "TRUNCATE users, accounts, holdings, account_snapshots, liabilities CASCADE",
      );
    } finally {
      await sql.end();
    }
  });

  test("walks the full Phase 1 happy path", async ({ page }) => {
    // ── 1. Bootstrap (set password) ─────────────────────────────────────────
    await page.goto("/");
    await expect(page).toHaveURL(/\/login$/);
    await page.getByLabel("Password").fill("hunter2");
    await page.getByRole("button", { name: /set password/i }).click();
    await expect(page).toHaveURL("/");
    await expect(page.getByRole("heading", { name: /net worth/i })).toBeVisible();

    // Initially zero — no snapshots yet.
    await expect(page.getByText("$0.00")).toBeVisible();

    // ── 2. Create a depository (checking) account ───────────────────────────
    await page.getByRole("link", { name: "Accounts" }).first().click();
    await expect(page).toHaveURL(/\/accounts$/);

    await page.getByRole("link", { name: /add account/i }).click();
    await expect(page).toHaveURL(/\/accounts\/new$/);
    await page.getByLabel("Name").fill("M&T Checking");
    await page.getByLabel("Institution").fill("M&T Bank");
    await page.getByLabel("Type").selectOption("depository");
    await page.getByRole("button", { name: /create account/i }).click();
    await expect(page).toHaveURL(/\/accounts\/[0-9a-f-]+$/);

    // ── 3. Record a balance ─────────────────────────────────────────────────
    await page.getByLabel("Balance").fill("5000.00");
    await page.getByRole("button", { name: /save balance/i }).click();
    await expect(page.getByText(/saved/i)).toBeVisible();

    // Back to the accounts list; new account shows with the formatted balance.
    await page.getByRole("link", { name: "Accounts" }).first().click();
    await expect(page.locator("table")).toContainText("M&T Checking");
    await expect(page.locator("table")).toContainText("$5,000.00");

    // ── 4. Create a mortgage (loan account + amortization params) ───────────
    await page.getByRole("link", { name: /add account/i }).click();
    await page.getByLabel("Name").fill("Sunwest Mortgage");
    await page.getByLabel("Institution").fill("Sunwest");
    await page.getByLabel("Type").selectOption("loan");
    await page.getByRole("button", { name: /create account/i }).click();
    await expect(page).toHaveURL(/\/accounts\/[0-9a-f-]+$/);

    // Mortgage form is rendered for loan accounts.
    await expect(page.getByRole("heading", { name: /mortgage parameters/i })).toBeVisible();
    await page.getByLabel("Loan name").fill("Sunwest 30yr fixed");
    await page.getByLabel("Principal at origination").fill("200000.00");
    await page.getByLabel("Annual rate").fill("0.06");
    await page.getByLabel("Term (months)").fill("360");
    // Pick a start date in the past so amortization shows some progress
    await page.getByLabel("Start date").fill("2024-01-01");
    await page.getByRole("button", { name: /save mortgage/i }).click();
    await expect(page.getByText(/saved/i)).toBeVisible();

    // Loan account detail shows a computed balance via amortization (negative).
    await expect(page.getByText(/computed from amortization/i)).toBeVisible();

    // ── 5. Dashboard shows the combined net worth ───────────────────────────
    await page.getByRole("link", { name: "Dashboard" }).click();
    await expect(page).toHaveURL("/");
    await expect(page.locator("table")).toContainText("M&T Checking");
    await expect(page.locator("table")).toContainText("Sunwest Mortgage");
    await expect(page.getByText("$5,000.00")).toBeVisible();
  });
});
