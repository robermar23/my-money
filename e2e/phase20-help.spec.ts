import { execFileSync } from "node:child_process";
import { expect, test } from "@playwright/test";
import postgres from "postgres";

/**
 * Phase 20 critical flow (P20-35, approved by the owner at the gate): the
 * dashboard explains itself, walks you round itself, and then leaves you alone.
 *
 * The help content, the step resolution and the storage marks have unit tests
 * behind them. What only a browser can prove is that the pieces meet: the `?`
 * key reaches the one mounted panel, "Take the tour" hands over from a modal
 * dialog to the tour overlay, every step finds its anchor on a real, populated
 * dashboard, and the per-device mark written at the start survives a reload.
 * The assertions, in order:
 *
 *   1. **A populated dashboard offers its tour once.** The first-visit chip is
 *      visible, so the check after the reload is not vacuous.
 *   2. **`?` opens this page's help**, titled for the dashboard, with a tour.
 *   3. **The tour runs to the end.** Each step's counter is checked against the
 *      tour's own length, so a step whose anchor went missing (skipped, and the
 *      tour quietly shorter) fails here rather than in review.
 *   4. **A reload does not offer it again**, and the page is still usable: the
 *      help button is there and nothing is dimmed.
 *
 * The book is the demo household (`make seed-demo`), so the dashboard shows
 * every card a tour step points at. Nothing here touches the network: help has
 * no egress on any path (see src/lib/help/privacy-egress.test.ts).
 */

const DEFAULT_DB = "postgres://money:dev_password_change_me@127.0.0.1:5433/money";

/** First compiles of a route in `next dev` can take a while. */
const ROUTE_COMPILE = { timeout: 60_000 };

/** The dashboard tour's step count (src/lib/help/content/overview.ts). */
const DASHBOARD_TOUR_STEPS = 4;

/**
 * The Makefile's DOMAIN_TABLES, which `make db-reset` uses and which reaches
 * every table the seeder counts (src/lib/demo/seed.ts BOOK_TABLES). The
 * narrower global-setup list misses a previous run's demo household.
 */
const CLEAR_BOOK =
  "TRUNCATE users, accounts, holdings, securities, plaid_items, plaid_sync_runs, webhook_log, account_snapshots, liabilities, prices, alerts, income_sources, household_profile, household_members, recommendation_dismissals, planned_expenses, category_budgets, watchlist_items CASCADE";

/** Empty the book: before seeding, and after, so no demo row reaches a later spec. */
async function clearBook(): Promise<void> {
  const sql = postgres(process.env.DATABASE_URL ?? DEFAULT_DB, { max: 1 });
  try {
    await sql.unsafe(CLEAR_BOOK);
  } finally {
    await sql.end();
  }
}

test.describe("phase 20: help and the dashboard tour", () => {
  test.beforeAll(async () => {
    try {
      process.loadEnvFile(".env.local");
    } catch {
      /* CI env */
    }
    // The seeder refuses a book that holds anything.
    await clearBook();
    execFileSync(
      process.execPath,
      ["--import", "tsx", "--import", "./scripts/loaders/register.mjs", "scripts/seed-demo.ts"],
      { env: process.env, stdio: "pipe", timeout: 120_000 },
    );
  });

  test.afterAll(clearBook);

  test("? opens help → take the tour → to the end → not offered again", async ({ page }) => {
    // ── Sign in: an empty users table makes this the password ─────────────
    await page.goto("/");
    await expect(page).toHaveURL(/\/login$/, ROUTE_COMPILE);
    await page.getByLabel("Password").fill("phase-20-help");
    await page.getByRole("button", { name: /set password/i }).click();
    await expect(page).toHaveURL("/", ROUTE_COMPILE);

    // ── 1. The populated dashboard offers its tour ──────────────────────────
    const chip = page.getByRole("button", { name: "New here? Take a 30-second tour" });
    await expect(chip).toBeVisible(ROUTE_COMPILE);

    // ── 2. `?` opens this page's help ───────────────────────────────────────
    await page.locator("body").click({ position: { x: 1, y: 1 } });
    await page.keyboard.press("?");
    const panel = page.getByRole("dialog", { name: "Dashboard" });
    await expect(panel).toBeVisible();
    await expect(panel).toContainText("Where do I stand right now");
    await panel.getByRole("button", { name: "Take the tour" }).click();
    await expect(panel).toBeHidden();
    await expect(chip).toBeHidden();

    // ── 3. Step through to the end ──────────────────────────────────────────
    const card = page.locator("dialog[open]").filter({ hasText: /\d+ of \d+/ });
    for (let step = 1; step <= DASHBOARD_TOUR_STEPS; step++) {
      await expect(card).toContainText(`${step} of ${DASHBOARD_TOUR_STEPS}`);
      const last = step === DASHBOARD_TOUR_STEPS;
      await card.getByRole("button", { name: last ? "Done" : "Next", exact: true }).click();
    }
    await expect(card).toBeHidden();

    // ── 4. A reload does not offer it again ─────────────────────────────────
    await page.reload();
    const help = page.getByRole("button", { name: "Help for this page" }).first();
    await expect(help).toBeVisible(ROUTE_COMPILE);
    await expect(page.locator('[data-tour="dashboard-net-worth"]')).toBeVisible();
    // The chip decides after mount; give it the same chance it had before.
    await page.waitForLoadState("networkidle");
    await expect(chip).toHaveCount(0);
    await expect(page.locator("dialog[open]")).toHaveCount(0);
  });
});
