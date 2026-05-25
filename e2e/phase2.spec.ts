import { expect, test } from "@playwright/test";
import postgres from "postgres";

/**
 * Phase 2 critical flow: with cached prices in place, holdings get valued
 * automatically on both the account detail page and the dashboard.
 *
 * We seed prices directly via SQL (simulating fetch-prices-daily having run)
 * so the E2E doesn't hit external APIs — fetcher behavior is covered by unit
 * tests in src/lib/prices/*.test.ts.
 */
test.describe("phase 2: cached prices → live holding valuations", () => {
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
        "TRUNCATE users, accounts, holdings, account_snapshots, liabilities, prices CASCADE",
      );
    } finally {
      await sql.end();
    }
  });

  test("dashboard reflects holdings × prices for investment accounts", async ({ page }) => {
    // ── Setup the single user ───────────────────────────────────────────────
    await page.goto("/");
    await expect(page).toHaveURL(/\/setup$/);
    const email = `owner+${Date.now()}@my-money.local`;
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill("correct-horse-battery-staple");
    await page.getByRole("button", { name: /create account/i }).click();
    await expect(page).toHaveURL("/");

    // ── Create a Fidelity investment account and add a holding ──────────────
    await page.getByRole("link", { name: "Accounts" }).first().click();
    await page.getByRole("link", { name: /add account/i }).click();
    await page.getByLabel("Name").fill("Fidelity Brokerage");
    await page.getByLabel("Institution").fill("Fidelity");
    await page.getByLabel("Type").selectOption("investment");
    await page.getByRole("button", { name: /create account/i }).click();
    await expect(page).toHaveURL(/\/accounts\/[0-9a-f-]+$/);

    // Add a 10-share AAPL holding.
    await page.getByLabel("Symbol").fill("AAPL");
    await page.getByLabel("Asset class").selectOption("equity");
    await page.getByLabel("Quantity").fill("10");
    await page.getByLabel("Unit").selectOption("shares");
    await page.getByRole("button", { name: /save holding/i }).click();
    await expect(page.getByText(/saved/i).first()).toBeVisible();

    // Without prices yet, value column should be "—" (em-dash).
    await expect(page.getByText("AAPL", { exact: true })).toBeVisible();

    // ── Seed today's AAPL price as if fetch-prices-daily ran ────────────────
    const today = new Date().toISOString().slice(0, 10);
    const sql = postgres(
      process.env.DATABASE_URL ?? "postgres://money:dev_password_change_me@127.0.0.1:5433/money",
      { max: 1 },
    );
    try {
      await sql`
        INSERT INTO prices (symbol, date, close, source)
        VALUES ('AAPL', ${today}, '234.56000000', 'manual')
        ON CONFLICT (symbol, date) DO UPDATE SET close = EXCLUDED.close
      `;
    } finally {
      await sql.end();
    }

    // ── Reload account detail: holdings table shows price + value ──────────
    await page.reload();
    // 10 × $234.56 = $2,345.60
    await expect(page.getByText("$2,345.60").first()).toBeVisible();
    // Holdings table also shows the per-share latest price.
    await expect(page.getByText("$234.56").first()).toBeVisible();

    // ── Dashboard: net worth picks up the live holdings valuation ───────────
    await page.getByRole("link", { name: "Dashboard" }).click();
    await expect(page).toHaveURL("/");
    await expect(page.locator("table")).toContainText("Fidelity Brokerage");
    await expect(page.locator("table")).toContainText("$2,345.60");
  });
});
