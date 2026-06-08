import { type Page, expect, test } from "@playwright/test";
import postgres from "postgres";

/**
 * Phase 6 mobile smoke (P6-25).
 *
 * At a 375px (iPhone SE) viewport the app must be usable: the nav collapses to a
 * hamburger that opens a working link panel, and no page overflows horizontally
 * — including the dense dashboard net-worth table, which is the real overflow
 * risk that the P6-17→20 `overflow-x-auto` wrappers exist to contain.
 *
 * This spec bootstraps its own user + one account through the mobile UI, so it's
 * independent of sibling specs and actually exercises the responsive forms.
 */
test.use({ viewport: { width: 375, height: 812 } });

test.describe("phase 6: 375px mobile smoke", () => {
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

  test("collapses nav to a hamburger and never overflows horizontally", async ({ page }) => {
    // ── Bootstrap on the small viewport ───────────────────────────────────────
    await page.goto("/");
    await expect(page).toHaveURL(/\/login$/);
    await expectNoHorizontalOverflow(page); // login form fits too
    await page.getByLabel("Password").fill("hunter2");
    await page.getByRole("button", { name: /set password/i }).click();
    await expect(page).toHaveURL("/");
    await expect(page.getByRole("heading", { name: /net worth/i })).toBeVisible();

    // ── Nav is collapsed: the inline desktop row is hidden, hamburger is in ────
    const hamburger = page.getByRole("button", { name: /toggle navigation menu/i });
    await expect(hamburger).toBeVisible();
    await expectNoHorizontalOverflow(page);

    // The hamburger opens a panel that exposes the nav links and navigates.
    // Within the <header> there are two "Accounts" links — the hidden desktop
    // row and the visible mobile panel (rendered last); take the panel one.
    await hamburger.click();
    const navAccounts = page.locator("header").getByRole("link", { name: "Accounts" }).last();
    await expect(navAccounts).toBeVisible();
    await navAccounts.click();
    await expect(page).toHaveURL(/\/accounts$/);
    await expectNoHorizontalOverflow(page);

    // ── Create an account via the responsive form (P6-20) ─────────────────────
    await page.getByRole("link", { name: /add account/i }).click();
    await expect(page).toHaveURL(/\/accounts\/new$/);
    await expectNoHorizontalOverflow(page);
    await page.getByLabel("Name").fill("M&T Checking");
    await page.getByLabel("Institution").fill("M&T Bank");
    await page.getByLabel("Type").selectOption("depository");
    await page.getByRole("button", { name: /create account/i }).click();
    await expect(page).toHaveURL(/\/accounts\/[0-9a-f-]+$/);

    // Record a balance so the dashboard renders a populated net-worth table.
    await page.getByLabel("Balance").fill("5000.00");
    await page.getByRole("button", { name: /save balance/i }).click();
    await expect(page.getByText(/saved/i)).toBeVisible();
    await expectNoHorizontalOverflow(page);

    // ── Dashboard with a dense table must still fit at 375px ───────────────────
    await page.goto("/");
    await expect(page.locator("table")).toContainText("M&T Checking");
    await expect(page.locator("table")).toContainText("$5,000.00");
    await expectNoHorizontalOverflow(page);
  });
});

/**
 * Assert the document doesn't scroll horizontally at the current viewport.
 *
 * A 1px slack absorbs sub-pixel rounding; a genuine layout overflow is many px.
 * `overflow-x-auto` table wrappers scroll *inside* their own box, so they don't
 * widen `documentElement` — only an element escaping the viewport would.
 */
async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const overflowPx = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflowPx, "page overflows horizontally at 375px").toBeLessThanOrEqual(1);
}
