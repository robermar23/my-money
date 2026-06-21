import { expect, test } from "@playwright/test";
import postgres from "postgres";

/**
 * Phase 9 critical flow (P9-25) — the ungated manual path.
 *
 * Bootstrap → investment account → AAPL holding → seed several days of `prices`,
 * a `securities` row carrying a forward `dividend_rate`, and `holding_snapshots`
 * via SQL → then assert the three Phase 9 surfaces render real numbers:
 *
 *   - /investments/performance  → a value series + a gain/loss figure
 *   - /investments/forecast     → a forward-income number + the estimate banner
 *   - /investments/security/[id]→ the price-history sparkline
 *
 * Like the Phase 5 manual spec, prices/snapshots are seeded directly (the nightly
 * snapshot job + enrichment fetcher are Vitest-covered, P9-02/03/06/07) so no
 * worker or Plaid creds are needed. The Plaid Sandbox investments path stays in
 * phase5-investments.spec.ts.
 */

const DEFAULT_DB = "postgres://money:dev_password_change_me@127.0.0.1:5433/money";

function dbUrl(): string {
  return process.env.DATABASE_URL ?? DEFAULT_DB;
}

/** UTC `YYYY-MM-DD`, `daysAgo` days before today. */
function isoDaysAgo(daysAgo: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d.toISOString().slice(0, 10);
}

test.describe("phase 9: manual investments → performance / forecast / security (P9-25)", () => {
  test.beforeAll(async () => {
    try {
      process.loadEnvFile(".env.local");
    } catch {
      /* CI env */
    }
    const sql = postgres(dbUrl(), { max: 1 });
    try {
      await sql.unsafe(
        "TRUNCATE users, accounts, holdings, holding_lots, holding_snapshots, investment_transactions, securities, account_snapshots, liabilities, prices CASCADE",
      );
    } finally {
      await sql.end();
    }
  });

  test("snapshots + enrichment → performance, forecast, and per-security pages", async ({
    page,
  }) => {
    // ── Bootstrap ─────────────────────────────────────────────────────────────
    await page.goto("/");
    await expect(page).toHaveURL(/\/login$/);
    await page.getByLabel("Password").fill("hunter2");
    await page.getByRole("button", { name: /set password/i }).click();
    await expect(page).toHaveURL("/");

    // ── Create a Fidelity investment account ──────────────────────────────────
    await page.goto("/accounts/new");
    await page.getByLabel("Name").fill("Fidelity Brokerage");
    await page.getByLabel("Institution").fill("Fidelity");
    await page.getByLabel("Type").selectOption("investment");
    await page.getByRole("button", { name: /create account/i }).click();
    await expect(page).toHaveURL(/\/accounts\/[0-9a-f-]+$/);

    // ── Add a 10-share AAPL holding ───────────────────────────────────────────
    await page.getByLabel("Symbol").fill("AAPL");
    await page.getByLabel("Asset class").selectOption("equity");
    await page.getByLabel("Quantity").fill("10");
    await page.getByLabel("Unit").selectOption("shares");
    await page.getByRole("button", { name: /save holding/i }).click();
    await expect(page.getByText(/saved/i).first()).toBeVisible();

    // ── Seed market data + history via SQL ────────────────────────────────────
    const d0 = isoDaysAgo(0); // today
    const d1 = isoDaysAgo(1);
    const d2 = isoDaysAgo(2);
    const sql = postgres(dbUrl(), { max: 1 });
    let holdingId = "";
    try {
      // A few days of AAPL closes (drives valuation + the price-history sparkline).
      await sql`
        INSERT INTO prices (symbol, date, close, source) VALUES
          ('AAPL', ${d2}, '230.00000000', 'manual'),
          ('AAPL', ${d1}, '232.00000000', 'manual'),
          ('AAPL', ${d0}, '234.56000000', 'manual')
        ON CONFLICT (symbol, date) DO UPDATE SET close = EXCLUDED.close`;

      // An enriched security carrying a forward dividend rate ($1.00/share), then
      // link the manually-created holding to it so the forecast can join it.
      const [sec] = await sql<{ id: string }[]>`
        INSERT INTO securities
          (symbol, name, type, asset_type, sector, region, dividend_rate, fundamentals_refreshed_at)
        VALUES
          ('AAPL', 'Apple Inc.', 'equity', 'equity', 'Technology', 'United States', '1.00000000', now())
        RETURNING id`;
      if (!sec) throw new Error("seed: securities insert returned no row");

      const [held] = await sql<{ id: string }[]>`
        SELECT id FROM holdings WHERE symbol = 'AAPL' LIMIT 1`;
      if (!held) throw new Error("seed: AAPL holding not found");
      holdingId = held.id;
      await sql`UPDATE holdings SET security_id = ${sec.id} WHERE id = ${holdingId}`;

      // Per-holding daily snapshots (value rising, cost basis flat at $2,000):
      // gain on the latest day = 2345.60 − 2000.00 = $345.60.
      await sql`
        INSERT INTO holding_snapshots (holding_id, date, quantity, value, cost_basis, currency) VALUES
          (${holdingId}, ${d2}, '10', '2300.00', '2000.00', 'USD'),
          (${holdingId}, ${d1}, '10', '2320.00', '2000.00', 'USD'),
          (${holdingId}, ${d0}, '10', '2345.60', '2000.00', 'USD')
        ON CONFLICT (holding_id, date) DO UPDATE SET value = EXCLUDED.value`;
    } finally {
      await sql.end();
    }

    // ── /investments/performance: value series + gain/loss ────────────────────
    await page.goto("/investments/performance");
    await expect(page.getByRole("heading", { name: "Investment performance" })).toBeVisible();
    // Latest gain = value − cost basis = $345.60.
    await expect(page.getByText("$345.60").first()).toBeVisible();
    // With ≥ 2 snapshot days, the value chart section renders (not the
    // insufficient-history empty state).
    await expect(
      page.getByRole("heading", { name: /value & cost basis over time/i }),
    ).toBeVisible();

    // ── /investments/forecast: forward income + estimate banner ───────────────
    await page.goto("/investments/forecast");
    await expect(page.getByRole("heading", { name: "Investment forecast" })).toBeVisible();
    // Mandatory unconditional banner (ADR-022).
    await expect(
      page.getByText(/Projections are illustrative estimates, not financial advice/i),
    ).toBeVisible();
    // Forward 12-month income = 10 shares × $1.00 = $10.00.
    await expect(page.getByText("$10.00").first()).toBeVisible();
    // The holding appears in the forward-income breakdown table.
    await expect(page.getByRole("cell", { name: "AAPL" })).toBeVisible();

    // ── /investments/security/[id]: price-history sparkline ───────────────────
    await page.goto(`/investments/security/${holdingId}`);
    await expect(page.getByRole("heading", { name: "AAPL" })).toBeVisible();
    await expect(page.getByRole("heading", { name: /price history/i })).toBeVisible();
    // Current value = 10 × $234.56 = $2,345.60.
    await expect(page.getByText("$2,345.60").first()).toBeVisible();
  });
});
