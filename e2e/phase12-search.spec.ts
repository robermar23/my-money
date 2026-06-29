import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import postgres from "postgres";

/**
 * Phase 12 critical flow (P12-22): bootstrap → seed a handful of accounts +
 * transactions via SQL → open the ⌘K command palette, type a payee fragment,
 * and confirm the grouped result appears and selecting it navigates to the right
 * account → then on the cross-account `/transactions` page apply an amount + date
 * filter and confirm the row set narrows.
 *
 * Per CLAUDE.md §Testing Philosophy this is the single search path we E2E — the
 * sanitizer, predicate shape, Zod refinements, and WHERE composition are unit
 * tested; the privacy/egress guarantee has its own regression. We seed directly
 * via SQL (no importer round-trip) so the test stays about search, not ingestion.
 */

const DEFAULT_DB = "postgres://money:dev_password_change_me@127.0.0.1:5433/money";

function databaseUrl(): string {
  return process.env.DATABASE_URL ?? DEFAULT_DB;
}

/** A seeded checking account id, captured in beforeAll for the navigation assert. */
let checkingId = "";

test.describe("phase 12: command palette + cross-account transaction filters", () => {
  test.beforeAll(async () => {
    try {
      process.loadEnvFile(".env.local");
    } catch {
      /* CI env injects real vars */
    }
    const sql = postgres(databaseUrl(), { max: 1 });
    try {
      await sql.unsafe(
        "TRUNCATE users, accounts, transactions, securities, watchlist_items CASCADE",
      );

      checkingId = randomUUID();
      const cardId = randomUUID();
      await sql`
        INSERT INTO accounts (id, name, institution, type, currency) VALUES
          (${checkingId}, 'Everyday Checking', 'M&T Bank', 'depository', 'USD'),
          (${cardId}, 'Rewards Card', 'Capital One', 'credit_card', 'USD')
      `;

      // Distinct payees / amounts / dates so the palette and the filters each
      // have an unambiguous, narrowable target.
      const txns: ReadonlyArray<{
        account: string;
        date: string;
        amount: string;
        name: string;
      }> = [
        { account: checkingId, date: "2026-03-15", amount: "-45.00", name: "Amazon Marketplace" },
        { account: checkingId, date: "2026-01-10", amount: "-120.00", name: "Amazon Web Services" },
        { account: checkingId, date: "2026-03-20", amount: "-82.50", name: "Whole Foods" },
        { account: checkingId, date: "2026-03-01", amount: "3000.00", name: "Paycheck" },
        { account: cardId, date: "2026-02-05", amount: "-40.00", name: "Shell Gas" },
      ];
      for (const t of txns) {
        await sql`
          INSERT INTO transactions (account_id, posted_at, amount, name, fitid, source)
          VALUES (${t.account}, ${t.date}, ${t.amount}, ${t.name}, ${randomUUID()}, 'manual')
        `;
      }
    } finally {
      await sql.end();
    }
  });

  test("walks the Phase 12 search happy path", async ({ page }) => {
    // ── 1. Bootstrap (set password) ─────────────────────────────────────────
    await page.goto("/");
    await expect(page).toHaveURL(/\/login$/);
    await page.getByLabel("Password").fill("hunter2");
    await page.getByRole("button", { name: /set password/i }).click();
    await expect(page).toHaveURL("/");

    // ── 2. Open the ⌘K palette via the nav trigger and search a payee fragment ─
    await page
      .getByRole("button", { name: /search/i })
      .first()
      .click();
    const box = page.getByRole("combobox", { name: /search/i });
    await expect(box).toBeVisible();
    await box.fill("amazon");

    // The Transactions group surfaces both Amazon rows (debounced fetch → render).
    const txnGroup = page.getByRole("group", { name: "Transactions" });
    await expect(txnGroup).toBeVisible();
    await expect(page.getByRole("option", { name: /Amazon Marketplace/ })).toBeVisible();
    await expect(page.getByRole("option", { name: /Amazon Web Services/ })).toBeVisible();

    // ── 3. Selecting a result navigates to its account page ─────────────────
    await page.getByRole("option", { name: /Amazon Marketplace/ }).click();
    await expect(page).toHaveURL(new RegExp(`/accounts/${checkingId}$`));

    // ── 4. Cross-account /transactions starts with every row ────────────────
    await page.goto("/transactions");
    await expect(page.getByRole("cell", { name: "Amazon Marketplace" })).toBeVisible();
    await expect(page.getByRole("cell", { name: "Shell Gas" })).toBeVisible();
    await expect(page.getByRole("cell", { name: "Whole Foods" })).toBeVisible();

    // ── 5. Apply an amount + date filter → the row set narrows ──────────────
    // March 14–31 AND −$50 ≤ amount ≤ $0 leaves only "Amazon Marketplace"
    // (−$45): Whole Foods (−$82.50) is below the floor; the Jan/Feb/Mar-01 rows
    // fall outside the window.
    await page.getByLabel("From", { exact: true }).fill("2026-03-14");
    await page.getByLabel("To", { exact: true }).fill("2026-03-31");
    await page.getByLabel("Min amount").fill("-50.00");
    await page.getByLabel("Max amount").fill("0.00");
    await page.getByRole("button", { name: /apply filters/i }).click();

    await expect(page).toHaveURL(/minAmount=-50/);
    await expect(page.getByRole("cell", { name: "Amazon Marketplace" })).toBeVisible();
    await expect(page.getByRole("cell", { name: "Whole Foods" })).toHaveCount(0);
    await expect(page.getByRole("cell", { name: "Shell Gas" })).toHaveCount(0);
    await expect(page.getByRole("cell", { name: "Amazon Web Services" })).toHaveCount(0);
  });
});
