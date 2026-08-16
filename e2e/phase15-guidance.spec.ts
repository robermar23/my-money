import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import postgres from "postgres";

/**
 * Phase 15 critical flow (P15-41): a book with real history gets **told what to
 * do** — the waterfall names the rung, a recommendation can be acted on through
 * preview → confirm, and one the user rejects stays rejected.
 *
 * Per CLAUDE.md §Testing Philosophy this is the single guidance path we E2E. The
 * rules themselves are pure functions with ~400 unit tests behind them; what
 * only a browser can prove is that the composition survives the trip through a
 * server component, a background job, two server actions, and a page refresh.
 *
 * Three assertions carry the test, matching the three things Phase 15 claims:
 *
 *   1. **The waterfall is determinate.** The employer-match rung is seeded with
 *      a real match formula AND materialized pay periods, so it must report an
 *      actual gap — not `unknown_input`. A rung that says "we cannot tell" is
 *      the honest degradation, but if it says that on complete data the feature
 *      does not work.
 *   2. **A suggestion can be applied without a silent bulk write.** The panel
 *      previews every row, and the budget only exists after the confirm click.
 *   3. **A dismissal survives a reload.** ADR-026's never-re-nag rule is the
 *      whole reason `recommendation_dismissals` is the one piece of persisted
 *      advice state, and an in-memory hide that comes back on refresh would
 *      satisfy every unit test while failing the user completely.
 *
 * Nothing here touches the network: no prices are needed (the contribution rule
 * is basis-only), and the advice engine has no egress by construction.
 *
 * The figures are chosen so the guidance is unambiguous:
 *   $4,000 gross biweekly · 3% employee = $120 · employer matches 5% capped at
 *   5% → the household is leaving ~2% of gross on the table, every period.
 *   $2,600/mo essential spend · a $900 checking balance ⇒ nowhere near a
 *   3-month reserve, so the ladder cannot report everything green.
 *   A card at 24.99% APR ⇒ the high-interest rung is unambiguously in play.
 */

const DEFAULT_DB = "postgres://money:dev_password_change_me@127.0.0.1:5433/money";

function databaseUrl(): string {
  return process.env.DATABASE_URL ?? DEFAULT_DB;
}

/** ISO date `n` days before today (UTC). */
function daysAgo(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

/** The 15th of the month `n` whole months back — a stable mid-month posting. */
function monthsBack(n: number): string {
  const d = new Date();
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - n, 15));
  return target.toISOString().slice(0, 10);
}

const checkingId = randomUUID();
const cardId = randomUUID();
const planId = randomUUID();
const sourceId = randomUUID();

const rentId = randomUUID();
const groceriesId = randomUUID();
const diningId = randomUUID();
const salaryId = randomUUID();

/** 12 complete months back, so the median-based suggester has a real window. */
const HISTORY_MONTHS = 12;

test.describe("phase 15: the app recommends, and the user can act or refuse", () => {
  test.beforeAll(async () => {
    try {
      process.loadEnvFile(".env.local");
    } catch {
      /* CI env injects real vars */
    }
    const sql = postgres(databaseUrl(), { max: 1 });
    try {
      await sql.unsafe(`TRUNCATE
        users, accounts, account_snapshots, transactions, categories, category_groups,
        category_budgets, credit_lines, household_profile, household_members,
        recommendation_dismissals, income_sources, retirement_contributions,
        income_contributions, alerts
        CASCADE`);

      // ── Accounts ────────────────────────────────────────────────────────
      // The subtype is the column that makes "how much on hand vs. in reserve"
      // answerable at all (ADR-033 §1) — without it the cash is unclassified.
      await sql`
        INSERT INTO accounts (id, name, institution, type, subtype, tax_treatment, currency) VALUES
          (${checkingId}, 'Everyday Checking', 'M&T Bank', 'depository', 'checking', NULL, 'USD'),
          (${cardId},     'Rewards Card',      'Chase',    'credit_card', NULL,      NULL, 'USD'),
          (${planId},     'Workplace 401k',    'Fidelity', 'investment',  NULL, 'tax_deferred', 'USD')
      `;
      // A thin reserve against $2,600/mo of essentials — the emergency-fund rule
      // has something unambiguous to say.
      await sql`
        INSERT INTO account_snapshots (account_id, date, balance) VALUES
          (${checkingId}, ${daysAgo(0)}, '900.00'),
          (${cardId},     ${daysAgo(0)}, '-4200.00')
      `;
      // Revolving terms, entered by hand (ADR-033 §6 — Plaid Liabilities is off).
      // 24.99% is far above the 7% default threshold.
      await sql`
        INSERT INTO credit_lines (account_id, apr, credit_limit, minimum_payment)
        VALUES (${cardId}, '0.249900', '6000.00', '120.00')
      `;

      // ── Categories, with the necessity axis populated ───────────────────
      await sql`
        INSERT INTO categories (id, name, kind, necessity) VALUES
          (${rentId},      'Rent',      'expense', 'essential'),
          (${groceriesId}, 'Groceries', 'expense', 'essential'),
          (${diningId},    'Dining',    'expense', 'discretionary'),
          (${salaryId},    'Salary',    'income',  NULL)
      `;

      // ── A year of history ───────────────────────────────────────────────
      // Rent is flat; groceries vary; dining carries ONE outlier month. The
      // outlier is deliberate: it is what separates a median-based target from
      // the mean the forecast module uses (ADR-034 §3).
      const rows: {
        id: string;
        account: string;
        date: string;
        amount: string;
        name: string;
        category: string;
      }[] = [];
      for (let i = HISTORY_MONTHS; i >= 1; i--) {
        const date = monthsBack(i);
        rows.push({
          id: randomUUID(),
          account: checkingId,
          date,
          amount: "-1800.00",
          name: "Landlord",
          category: rentId,
        });
        // 620 / 640 / 660, cycling — a median of 640.
        const groceries = ["-620.00", "-640.00", "-660.00"][i % 3] as string;
        rows.push({
          id: randomUUID(),
          account: checkingId,
          date,
          amount: groceries,
          name: "Market",
          category: groceriesId,
        });
        // $200 every month except one $2,000 blowout.
        rows.push({
          id: randomUUID(),
          account: checkingId,
          date,
          amount: i === 4 ? "-2000.00" : "-200.00",
          name: "Restaurant",
          category: diningId,
        });
        // Take-home, observed rather than declared (ADR-034 §1).
        rows.push({
          id: randomUUID(),
          account: checkingId,
          date,
          amount: "6000.00",
          name: "Acme Corp Payroll",
          category: salaryId,
        });
      }
      for (const r of rows) {
        await sql`
          INSERT INTO transactions
            (id, account_id, posted_at, amount, name, category_id, fitid, source)
          VALUES (${r.id}, ${r.account}, ${r.date}, ${r.amount}, ${r.name},
                  ${r.category}, ${r.id}, 'manual')
        `;
      }

      // ── The paycheck + match formula ────────────────────────────────────
      // Anchored 28 days back so several biweekly paydays fall inside the job's
      // lookback and the match rung has materialized periods to measure.
      await sql`
        INSERT INTO income_sources
          (id, name, cadence, gross_per_period, anchor_date, start_date, active)
        VALUES (${sourceId}, 'Acme Corp', 'biweekly', '4000.00',
                ${daysAgo(28)}, ${daysAgo(28)}, true)
      `;
      // 3% employee against a 5%-of-gross match capped at 5%: the household is
      // leaving employer dollars on the table every single period. `holding_id`
      // is NULL — basis-only (ADR-031), so no prices are needed anywhere.
      await sql`
        INSERT INTO retirement_contributions
          (income_source_id, account_id, holding_id, employee_basis, employee_value,
           match_basis, match_value, match_cap_percent, active)
        VALUES (${sourceId}, ${planId}, NULL, 'percent', '3.0000',
                'percent_of_gross', '5.0000', '5.0000', true)
      `;
    } finally {
      await sql.end();
    }

    // Materialize the paydays. Without this the match rung is `unknown_input`
    // ("no pay periods materialized this year") — honest, but not what this
    // test is here to prove.
    execSync(
      "node --import tsx --import ./scripts/loaders/register.mjs src/worker/run-once.ts materialize-contributions",
      {
        cwd: process.cwd(),
        env: { ...process.env, DATABASE_URL: databaseUrl() },
        stdio: "inherit",
      },
    );
  });

  test("plans the household, applies a budget, and honors a refusal", async ({ page }) => {
    // ── 1. Bootstrap → dashboard ────────────────────────────────────────────
    await page.goto("/");
    await expect(page).toHaveURL(/\/login$/);
    await page.getByLabel("Password").fill("hunter2");
    await page.getByRole("button", { name: /set password/i }).click();
    await expect(page).toHaveURL("/");

    // The dashboard card leads with guidance, and carries the disclaimer even
    // there — a compact one, but present (ADR-032 §5 admits no exceptions).
    const adviceCard = page.getByRole("heading", { name: "Your plan" }).locator("..");
    await expect(adviceCard).toBeVisible();
    await expect(page.getByText(/not financial advice/i).first()).toBeVisible();

    // ── 2. Household details ────────────────────────────────────────────────
    // Distinctive labels: the page is dense with prose, and a name like "Me"
    // matches half of it.
    await page.goto("/settings/household");
    await page.getByLabel("Name or label").fill("Alexandra");
    await page.getByLabel("Birth year").fill("1985");
    await page.getByRole("button", { name: "Add person" }).click();
    await expect(page.getByText("Alexandra", { exact: true })).toBeVisible();

    // A dependent is what lifts the reserve multiplier from 3 months to 6.
    await page.getByLabel("Name or label").fill("Bartholomew");
    await page.getByLabel("Birth year").fill("2015");
    await page.getByLabel("Depends on this income").check();
    await page.getByRole("button", { name: "Add person" }).click();
    await expect(page.getByText("Bartholomew", { exact: true })).toBeVisible();

    // ── 3. THE CLAIM: /plan tells them what to do ───────────────────────────
    await page.goto("/plan");
    await expect(page.getByRole("heading", { name: "Your plan" })).toBeVisible();

    // The disclaimer is unconditional and not behind a disclosure.
    await expect(page.getByText(/not financial advice/i).first()).toBeVisible();

    // The waterfall renders, in its fixed order (ADR-034 §4).
    const ladder = page.locator("section").filter({
      has: page.getByRole("heading", { name: "Where your next dollar goes" }),
    });
    await expect(ladder).toBeVisible();
    for (const rung of [
      "Starter buffer",
      "Employer match",
      "High-interest debt",
      "Full emergency reserve",
    ]) {
      await expect(ladder.getByRole("heading", { name: rung, exact: true })).toBeVisible();
    }

    // Assertion 1 — the match rung is DETERMINATE. The formula and the pay
    // periods are both recorded, so "we cannot tell" would be a bug here.
    const matchRung = ladder
      .locator("li")
      .filter({ has: page.getByRole("heading", { name: "Employer match", exact: true }) });
    await expect(matchRung).not.toContainText("We cannot tell");
    await expect(matchRung).not.toContainText("not recorded");

    // The 24.99% card is unambiguously above the threshold, so the engine has
    // to be talking about it somewhere in the ranked list.
    await expect(page.getByText(/24\.99%/).first()).toBeVisible();

    // Every recommendation names the rule of thumb it applies — an unnamed
    // heuristic is an unfalsifiable one (ADR-032 §2).
    await expect(page.getByText(/months of essential expenses/i).first()).toBeVisible();

    // ── 4. Apply a suggested budget: preview → confirm (P15-27) ─────────────
    await page.goto("/analysis/budgets");
    const panel = page.getByText(/Suggest budgets from your spending/);
    await expect(panel).toBeVisible();
    await panel.click(); // open the <details>

    // Nothing is written by previewing. Dining's median is $200 despite the
    // $2,000 month — a mean would suggest ~$350 and be wrong 11 months a year.
    const diningTarget = page.getByLabel("Monthly target for Dining");
    await expect(diningTarget).toHaveValue("200.00");
    await expect(page.getByLabel("Monthly target for Rent")).toHaveValue("1800.00");

    // Confirm. Only now does anything hit the database.
    await page.getByRole("button", { name: /^Apply \d+ budgets?$/ }).click();
    await expect(page.getByText(/Applied \d+ budgets?/)).toBeVisible();

    // The budget is real, and survives a round trip through the database: the
    // preview recomputes against what is now stored and reports the rows as
    // `Same`, which it could only do if the write actually landed.
    await page.reload();
    // The stored target on the month's row — the median, not the $2,000 month.
    await expect(page.getByLabel("Monthly budget for Rent")).toHaveValue("1800.00");
    await expect(page.getByLabel("Monthly budget for Dining")).toHaveValue("200.00");
    await page.getByText(/Suggest budgets from your spending/).click();
    await expect(page.getByText("DiningSame")).toBeVisible();

    // ── 5. Refuse a recommendation, and have that stick (P15-34) ────────────
    await page.goto("/plan");
    const firstCard = page
      .locator("article, li")
      .filter({ has: page.getByText("Hide") })
      .first();
    const dismissedTitle = (await firstCard.locator("h3").first().innerText()).trim();
    expect(dismissedTitle.length).toBeGreaterThan(0);

    await firstCard.getByRole("button", { name: "Hide" }).click();
    await page.getByRole("button", { name: "Dismiss for good" }).click();

    // Gone from the ranked list…
    await expect(page.getByRole("heading", { name: dismissedTitle })).toHaveCount(0);

    // Assertion 3 — …and STILL gone after a reload. An in-memory hide would
    // pass every assertion above this line and fail the user on the next visit.
    await page.reload();
    await expect(page.getByRole("heading", { name: dismissedTitle })).toHaveCount(0);

    // But it is visible AS dismissed, and reversible — a hidden item with no
    // way back is a page that quietly stops mentioning a $4,200 balance.
    const hidden = page.getByText(/Hidden by you \(\d+\)/);
    await expect(hidden).toBeVisible();
    await hidden.click();
    await page.getByRole("button", { name: "Show again" }).first().click();
    await expect(page.getByRole("heading", { name: dismissedTitle })).toBeVisible();
  });
});
