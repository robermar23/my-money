import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import postgres from "postgres";

/**
 * Phase 14 critical flow (P14-22): define a paycheck and a 401k contribution
 * rule in the UI → run the materialization job → **the 401k that had no cost
 * basis now has one**, with a real gain/loss, an auditable contribution ledger,
 * and a savings rate on the dashboard.
 *
 * That first clause is the whole phase. An employer plan reports no basis, so
 * gain/loss renders "—" forever; Phase 14's claim is that the money you chose to
 * contribute IS the basis. Every other test proves a piece of that in isolation
 * — the schedule, the match math, the planner's branches, the job's writes, the
 * `lots → resolveCostBasis → gainLoss` seam. Only this one proves the claim
 * survives the trip through a browser, a form, a background job, and three
 * different pages.
 *
 * Per CLAUDE.md §Testing Philosophy it is the single income path we E2E.
 *
 * Prices are seeded via SQL (as in every other spec) so the run never touches an
 * external API, and the job runs the documented way — `run-once.ts`, no Redis.
 *
 * The figures are chosen to be exact:
 *   $3,000 gross biweekly · 6% employee = $180 · 3% employer match = $90
 *   3 paydays (today−28, today−14, today) → **$810.00 cost basis**
 *   shares: 270/100 + 270/100 + 270/120 = 7.65 → 7.65 × $120 = **$918.00**
 *   gain **$108.00 (13.33%)** · savings rate 540 ÷ (3,000 × 26) = **0.69%**
 */

const DEFAULT_DB = "postgres://money:dev_password_change_me@127.0.0.1:5433/money";

function databaseUrl(): string {
  return process.env.DATABASE_URL ?? DEFAULT_DB;
}

/** ISO date `n` days before today (UTC) — the same axis the job walks. */
function daysAgo(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

const SYMBOL = "FXAIX";
/** Anchor + start. 28 days back makes the biweekly paydays land exactly on
 *  today−28, today−14, and today, and sits inside the job's 45-day lookback. */
const FIRST_PAYDAY = daysAgo(28);
const SECOND_PAYDAY = daysAgo(14);
const TODAY = daysAgo(0);

const accountId = randomUUID();
const holdingId = randomUUID();
const checkingId = randomUUID();

test.describe("phase 14: paycheck → contribution → 401k cost basis", () => {
  test.beforeAll(async () => {
    try {
      process.loadEnvFile(".env.local");
    } catch {
      /* CI env injects real vars */
    }
    const sql = postgres(databaseUrl(), { max: 1 });
    try {
      await sql.unsafe(`TRUNCATE
        users, accounts, holdings, holding_lots, investment_transactions,
        income_contributions, retirement_contributions, income_sources,
        holding_snapshots, account_snapshots, securities, prices
        CASCADE`);

      // A cash account with a balance, so the dashboard is a real book rather
      // than the first-run prompt — the savings-rate card only exists on a
      // dashboard that has accounts to show.
      await sql`
        INSERT INTO accounts (id, name, institution, type, currency) VALUES
          (${accountId}, 'Retirement 401k', 'Fidelity', 'investment', 'USD'),
          (${checkingId}, 'Everyday Checking', 'M&T Bank', 'depository', 'USD')
      `;
      await sql`
        INSERT INTO account_snapshots (account_id, date, balance)
        VALUES (${checkingId}, ${TODAY}, '10000.00')
      `;

      // The position as an employer plan hands it over: shares tracked, and
      // **cost_basis NULL** — the "—" this phase exists to replace.
      await sql`
        INSERT INTO holdings
          (id, account_id, symbol, quantity, quantity_unit, asset_class, cost_basis, source)
        VALUES
          (${holdingId}, ${accountId}, ${SYMBOL}, '0', 'shares', 'equity', NULL, 'manual')
      `;

      // Closes on each payday. The last one is higher, so the position shows a
      // gain rather than the tautological zero a flat price would give.
      for (const [date, close] of [
        [FIRST_PAYDAY, "100.00000000"],
        [SECOND_PAYDAY, "100.00000000"],
        [TODAY, "120.00000000"],
      ] as const) {
        await sql`
          INSERT INTO prices (symbol, date, close, source)
          VALUES (${SYMBOL}, ${date}, ${close}, 'seed')
          ON CONFLICT (symbol, date) DO UPDATE SET close = EXCLUDED.close
        `;
      }
    } finally {
      await sql.end();
    }
  });

  test("turns a defined paycheck into real cost basis, gain/loss, and a savings rate", async ({
    page,
  }) => {
    // ── 1. Bootstrap (set password) → lands on the dashboard ────────────────
    await page.goto("/");
    await expect(page).toHaveURL(/\/login$/);
    await page.getByLabel("Password").fill("hunter2");
    await page.getByRole("button", { name: /set password/i }).click();
    await expect(page).toHaveURL("/");

    // The savings-rate card starts empty — no paycheck is not a 0% savings rate.
    await expect(page.getByText("Define your income to track your savings rate.")).toBeVisible();

    // ── 2. Define the paycheck ──────────────────────────────────────────────
    await page.goto("/settings/income");
    await page.getByLabel("Name").fill("Acme Corp");
    await page.getByLabel("Gross pay per period").fill("3000.00");
    await page.getByLabel("Pay cadence").selectOption("biweekly");
    await page.getByLabel(/A real payday/).fill(FIRST_PAYDAY);
    await page.getByLabel("Track contributions from").fill(FIRST_PAYDAY);
    await page.getByRole("button", { name: "Add income source" }).click();

    await expect(page.getByText("$3,000.00")).toBeVisible();
    await expect(page.getByText(/No 401k contribution defined/)).toBeVisible();

    // ── 3. Attach the 401k rule: 6% of gross + a 3%-of-gross match ──────────
    await page.getByRole("button", { name: "Add contribution" }).click();
    await page
      .getByLabel("Retirement account")
      .selectOption({ label: "Retirement 401k — Fidelity" });
    await page.getByLabel(/Holding to buy/).selectOption({ label: SYMBOL });
    await page.getByLabel("My contribution value").fill("6");
    // `exact` — the value input beside it is labelled "Employer match value".
    await page.getByLabel("Employer match", { exact: true }).selectOption("percent_of_gross");
    await page.getByLabel("Employer match value").fill("3");

    // P14-15 — the preview shows the dollars BEFORE anything is saved, which is
    // the point of the affordance: no one should first meet these numbers weeks
    // later inside their cost basis.
    const preview = page.getByText("Preview — nothing is saved yet").locator("..");
    await expect(preview.getByText("$180.00")).toBeVisible();
    await expect(preview.getByText("$90.00")).toBeVisible();
    await expect(preview.getByText("$270.00")).toBeVisible();
    // 6% — the preview PROJECTS a full year of this rule (180 × 26 ÷ 78,000),
    // answering "what will this do?". The dashboard card later shows 0.69%,
    // because it MEASURES what has actually been contributed. Two different
    // questions, deliberately, and this test pins both.
    await expect(preview.getByText("6%")).toBeVisible();
    await expect(preview.getByText("$4,680.00")).toBeVisible();

    await page.getByRole("button", { name: "Add rule" }).click();
    await expect(page.getByText(/buys FXAIX/)).toBeVisible();
    await expect(page.getByText(/Nothing materialized yet/)).toBeVisible();

    // ── 4. Run the materialization job (run-once; no Redis) ─────────────────
    execSync(
      "node --import tsx --import ./scripts/loaders/register.mjs src/worker/run-once.ts materialize-contributions",
      {
        cwd: process.cwd(),
        env: { ...process.env, DATABASE_URL: databaseUrl() },
        stdio: "inherit",
      },
    );

    // Three paydays, each $180 mine + $90 employer.
    await page.reload();
    await expect(page.getByText(/3 contributions materialized through/)).toBeVisible();
    await expect(page.getByText(/\$540\.00 mine \+ \$270\.00 employer/)).toBeVisible();

    // ── 5. THE CLAIM: the 401k now has a cost basis and a real gain/loss ────
    await page.goto(`/investments/security/${holdingId}`);
    // 3 × $270 contributed.
    // The first exact "Cost basis" on the page is the stat tile's label; the
    // later one is the lots-table header.
    const basisStat = page.getByText("Cost basis", { exact: true }).first().locator("..");
    await expect(basisStat).toContainText("$810.00");
    // 7.65 shares × today's $120 close, and the gap between the two.
    await expect(page.getByText("$918.00").first()).toBeVisible();
    await expect(page.getByText("$108.00 (13.33%)")).toBeVisible();
    // P14-16 — and the page says where that basis came from.
    await expect(page.getByText(/Cost basis tracked from payroll contributions/)).toBeVisible();
    // The lots carry their provenance rather than a raw enum value.
    await expect(page.getByRole("cell", { name: "Contribution" }).first()).toBeVisible();

    // ── 6. P14-18 — the ledger is auditable from the account it funded ──────
    await page.goto(`/accounts/${accountId}`);
    const ledger = page.locator("section").filter({
      has: page.getByRole("heading", { name: "Contributions", exact: true }),
    });
    await expect(ledger.getByText("Acme Corp").first()).toBeVisible();
    await expect(ledger.getByText(TODAY)).toBeVisible();
    await expect(ledger.getByText(FIRST_PAYDAY)).toBeVisible();
    await expect(ledger.getByText("$270.00").first()).toBeVisible();

    // ── 7. P14-17 — the savings rate is on the dashboard ────────────────────
    await page.goto("/");
    const savings = page.locator("section").filter({
      has: page.getByRole("heading", { name: "Savings rate", exact: true }),
    });
    // $540 employee ÷ ($3,000 × 26) projected annual gross.
    await expect(savings.getByText("0.69%")).toBeVisible();
    await expect(savings.getByText("$78,000.00")).toBeVisible();
    await expect(savings.getByText("$540.00")).toBeVisible();
    await expect(savings.getByText("$270.00")).toBeVisible();
    // The framing is not decoration: a projected denominator over a measured
    // numerator has to say so (the same rule ADR-022 applies to forward income).
    await expect(savings.getByText(/^Estimate —/)).toBeVisible();
    await expect(savings.locator('a[href="/settings/income"]').first()).toBeVisible();
  });
});
