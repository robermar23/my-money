import { execSync } from "node:child_process";
import { expect, test } from "@playwright/test";
import postgres from "postgres";
import { navigateDirect, navigateVia } from "./helpers/nav.ts";

/**
 * Phase 11 critical flow (P11-24): bootstrap → add a watchlist item with a
 * pretend buy → it shows a gain/loss on `/watchlist` (and never touches net
 * worth) → add an `above` price target → seed a close ≥ the threshold and run
 * the evaluator → an alert lands on `/alerts` and the nav badge increments; the
 * target flips to "triggered".
 *
 * As in the other specs we seed prices via SQL (so the E2E never hits external
 * APIs — fetcher behavior is unit-tested), and we run the one-shot evaluator the
 * documented way (`run-once.ts`, no Redis) as a child process.
 */

const DEFAULT_DB = "postgres://money:dev_password_change_me@127.0.0.1:5433/money";

function databaseUrl(): string {
  return process.env.DATABASE_URL ?? DEFAULT_DB;
}

test.describe("phase 11: watchlist → pretend gain/loss → price-target alert", () => {
  test.beforeAll(async () => {
    try {
      process.loadEnvFile(".env.local");
    } catch {
      /* CI env */
    }
    const sql = postgres(databaseUrl(), { max: 1 });
    try {
      await sql.unsafe(
        "TRUNCATE users, accounts, holdings, account_snapshots, watchlist_items, price_targets, alerts, prices CASCADE",
      );
    } finally {
      await sql.end();
    }
  });

  test("walks the full Phase 11 happy path", async ({ page }) => {
    const today = new Date().toISOString().slice(0, 10);

    // ── 1. Bootstrap (set password) ─────────────────────────────────────────
    await page.goto("/");
    await expect(page).toHaveURL(/\/login$/);
    await page.getByLabel("Password").fill("hunter2");
    await page.getByRole("button", { name: /set password/i }).click();
    await expect(page).toHaveURL("/");

    // ── 2. Add a watchlist item with a pretend buy ──────────────────────────
    await navigateVia(page, "Investing", "Watchlist");
    await expect(page).toHaveURL(/\/watchlist$/);
    await page
      .getByRole("link", { name: /add symbol/i })
      .first()
      .click();
    await expect(page).toHaveURL(/\/watchlist\/new$/);

    await page.getByLabel("Symbol").fill("AAPL");
    await page.getByLabel("Type").selectOption("equity");
    await page.getByLabel("Quantity").fill("10");
    await page.getByLabel("Cost / unit").fill("150.00");
    await page.getByLabel("Purchase date").fill("2026-01-02");
    await page.getByRole("button", { name: /add symbol/i }).click();

    // Redirects to the detail page for the new item.
    await expect(page).toHaveURL(/\/watchlist\/[0-9a-f-]+$/);
    const detailUrl = page.url();

    // ── 3. Seed a close so the pretend position has a value, then verify ─────
    // 10 × $205 = $2,050 value vs. 10 × $150 = $1,500 cost → +$550 gain.
    const sql = postgres(databaseUrl(), { max: 1 });
    try {
      await sql`
        INSERT INTO prices (symbol, date, close, source)
        VALUES ('AAPL', ${today}, '205.00000000', 'manual')
        ON CONFLICT (symbol, date) DO UPDATE SET close = EXCLUDED.close
      `;
    } finally {
      await sql.end();
    }

    await page.goto("/watchlist");
    await expect(page.locator("table")).toContainText("AAPL");
    await expect(page.locator("table")).toContainText("$2,050.00");
    await expect(page.locator("table")).toContainText("$550.00");

    // Net worth on the dashboard is untouched — a watch row never counts.
    await navigateDirect(page, "Dashboard");
    await expect(page).toHaveURL("/");
    await expect(page.locator("body")).not.toContainText("$2,050.00");

    // ── 4. Add an `above` price target at $200 (already exceeded by $205) ────
    await page.goto(detailUrl);
    await page.getByLabel("Direction").selectOption("above");
    await page.getByLabel("Price").fill("200.00");
    await page.getByRole("button", { name: /add target/i }).click();
    await expect(page.getByText("Armed")).toBeVisible();

    // ── 5. Run the one-shot evaluator (no Redis; run-once direct invocation) ─
    execSync(
      "node --import tsx --import ./scripts/loaders/register.mjs src/worker/run-once.ts evaluate-price-targets",
      {
        cwd: process.cwd(),
        env: { ...process.env, DATABASE_URL: databaseUrl() },
        stdio: "inherit",
      },
    );

    // ── 6. Alert appears on /alerts; the nav badge increments ───────────────
    await page.goto("/");
    // The Alerts nav link now carries a count badge (the open-alert count).
    await expect(page.getByRole("link", { name: /alerts/i }).first()).toContainText("1");
    await page
      .getByRole("link", { name: /alerts/i })
      .first()
      .click();
    await expect(page).toHaveURL(/\/alerts$/);
    await expect(page.getByText("AAPL hit your above target")).toBeVisible();

    // ── 7. The target is now one-shot "triggered" on the detail page ────────
    await page.goto(detailUrl);
    await expect(page.getByText(/Triggered/)).toBeVisible();
    await expect(page.getByRole("button", { name: /re-arm/i })).toBeVisible();
  });
});
