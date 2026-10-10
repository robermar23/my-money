import { randomUUID } from "node:crypto";
import { type Page, expect, test } from "@playwright/test";
import postgres from "postgres";

/**
 * Phase 18 critical flow (P18-36): a cost you know is coming becomes a
 * **requirement**, in four places at once, and then stops being one.
 *
 * Per CLAUDE.md §Testing Philosophy this is the single sinking-fund path we
 * E2E. The accrual identity, the two-source cost stream, the cadence gate, the
 * availability subtraction and the status ladder are pure functions with ~200
 * unit tests behind them; what only a browser can prove is that the
 * composition survives the trip through a server component, a client island, a
 * server action and a page refresh — **four times over**, because this feature
 * is the first in the app whose single figure is rendered by four different
 * surfaces.
 *
 * That is the reason this flow is one test and not four. A break in any single
 * surface is silent: the page still renders, the figure is still a figure, and
 * nothing anywhere is red. The assertions, in order:
 *
 *   1. **An empty cost list is not success** (ADR-046 §5). Before anything is
 *      recorded the page says *"Nothing recorded to work from yet"* and offers
 *      no $0.00 verdict. If a future simplification ever makes a blank install
 *      report "on track", this is the assertion that fails.
 *   2. **Recording a cost moves no money** (ADR-043, CLAUDE.md §Domain Scope —
 *      the envelope line). Net worth is scraped off the dashboard before and
 *      after and asserted **identical**. This is the cheapest possible proof of
 *      the boundary the whole phase is built around, and it is an end-to-end
 *      one: no column was written that any balance is derived from.
 *   3. **The figure appears, itemized, and the total is the row.** The headline
 *      figure is scraped and the table's `Required today` cell must equal it —
 *      the itemization claim (ADR-045 §4(a)) is what makes a duplicate visible,
 *      so a headline that does not match its own table is the page's
 *      credibility gone.
 *   4. **`/plan` states the same string** (ADR-046 consequence 1). The figure
 *      scraped from `/plan/sinking` is asserted verbatim on the guidance card.
 *      [parity.test.ts](../src/lib/sinking/parity.test.ts) proves this against
 *      the loaders; this proves it through two server components, which is where
 *      a formatter could still disagree.
 *   5. **The projection charges it, and says so.** The cost lands inside the
 *      60-day horizon, so safe-to-spend must fall — the fourth cash-flow event
 *      kind reaching the day walk (P18-28/29) — and the sentence at the foot of
 *      the bill list must say the cost lands *inside* the window rather than
 *      beyond it, which is the copy P18-29 had to correct.
 *   6. **Marking it paid removes it from both.** The requirement returns to its
 *      empty state and safe-to-spend returns to **exactly** its original value.
 *      Exactly, not approximately: a recorded cost never touches the everyday
 *      spending rate (P18-30), so there is nothing to restore but the one event
 *      — and an inexact return would mean the residual had been quietly
 *      involved.
 *
 * Nothing here touches the network: the sinking layer has no egress on any
 * transitive path (see privacy-egress.test.ts), and the projection walks
 * operating cash only, so no prices are needed.
 *
 * ── Why the figures are the shape they are ────────────────────────────────
 * The suite must behave identically on the 2nd and the 28th, so nothing is
 * asserted that depends on the day of the month:
 *
 *   - **$9,500 checking + $20,000 savings.** The savings tier is comfortably
 *     above a 3-month emergency-fund target on a $1,850 baseline ($5,550), so
 *     `available` is a real figure and the page reaches `status: 'ok'` rather
 *     than a degradation. Net worth is therefore exactly **$29,500.00** —
 *     deterministic, which is what makes assertion 2 an equality.
 *   - **A $24,000 cost 40 days out.** Big enough that the day it lands is the
 *     low point of the window, and below zero, on *every* calendar day. Forty
 *     days can hold two of the 15th-of-the-month paychecks ($5,200 net each),
 *     so the most the line can hold before the cost is $9,500 + $10,400 =
 *     $19,900. The first sizing, $14,000, cleared that on a run between the 1st
 *     and the 15th and the shortfall never appeared (found 2026-10-10, P19-38);
 *     at $8,000 the drop would not even be the low point on some dates.
 *   - **Funding from six months back.** With the default start of today,
 *     `elapsed` is 0 and `requiredToday` is `"$0.00"` — arithmetically correct
 *     and useless as a test subject. Six months back makes the figure a real
 *     fraction of the cost, and the exact value is **scraped, never
 *     hard-coded**, because it moves with the run date.
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

/** ISO date `n` days after today (UTC). */
function daysAhead(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Day `day` of the month `n` whole months back (UTC). */
function monthsBack(n: number, day: number): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - n, day))
    .toISOString()
    .slice(0, 10);
}

const checkingId = randomUUID();
const savingsId = randomUUID();
const sourceId = randomUUID();
const rentCategoryId = randomUUID();
const salaryId = randomUUID();

/** Seven months clears the 3-month history gate the baseline needs. */
const HISTORY_MONTHS = 7;

/** The cost the household records, and the label every assertion hunts for. */
const COST_LABEL = "Attic insulation";
const COST_AMOUNT = "24000.00";
/** Inside the 60-day projection horizon AND the 12-month sinking horizon. */
const COST_DUE = daysAhead(40);
/** Six months of elapsed accrual, so `requiredToday` is not `"$0.00"`. */
const COST_FUNDING_START = monthsBack(6, 1);

/** The headline figure in the "Safe to spend" section — e.g. `"$8,812.40"`. */
async function safeToSpend(page: Page): Promise<number> {
  const raw = (
    await page
      .locator("section")
      .filter({ has: page.getByRole("heading", { name: "Safe to spend" }) })
      .locator("div.font-mono")
      .first()
      .innerText()
  ).trim();
  expect(raw, "the headline is not a money figure").toMatch(/^\$[\d,]+\.\d{2}$/);
  // `Number()` on a formatted string is exactly what CLAUDE.md §Money forbids
  // in the app, and exactly what a test comparing two rendered figures has to
  // do. Nothing computed here is written anywhere.
  return Number(raw.replace(/[$,]/g, ""));
}

test.describe("phase 18: a known cost becomes a requirement, in four places", () => {
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
        household_profile, household_members, recommendation_dismissals,
        income_sources, liabilities, scheduled_obligations, obligation_occurrences,
        planned_expenses, alerts
        CASCADE`);

      // ── Operating cash ──────────────────────────────────────────────────
      // `subtype='checking'` is load-bearing: the projection walks OPERATING
      // cash only (ADR-038 §6), and without it the page refuses to draw a line.
      await sql`
        INSERT INTO accounts (id, name, institution, type, subtype, currency)
        VALUES (${checkingId}, 'Everyday Checking', 'M&T Bank', 'depository', 'checking', 'USD')
      `;
      // ── Reserve cash ────────────────────────────────────────────────────
      // `subtype='savings'` is equally load-bearing in the other direction:
      // `available` counts the RESERVE tier only (ADR-046 §2), so an untriaged
      // account here would leave the page with a requirement and no position.
      await sql`
        INSERT INTO accounts (id, name, institution, type, subtype, currency)
        VALUES (${savingsId}, 'Reserve Savings', 'M&T Bank', 'depository', 'savings', 'USD')
      `;
      await sql`
        INSERT INTO account_snapshots (account_id, date, balance) VALUES
          (${checkingId}, ${daysAgo(0)}, '9500.00'),
          (${savingsId},  ${daysAgo(0)}, '20000.00')
      `;

      await sql`
        INSERT INTO categories (id, name, kind, necessity) VALUES
          (${rentCategoryId}, 'Rent',   'expense', 'essential'),
          (${salaryId},       'Salary', 'income',  NULL)
      `;

      // Seven months of rent and pay. The rent is what sizes the essential
      // baseline, and therefore the emergency-fund target the requirement is
      // measured ABOVE. It is monthly, so it never enters the cost stream
      // itself — the cadence gate (ADR-045 §2) is why this seed does not
      // accidentally require a reserve against it.
      const rows: { id: string; date: string; amount: string; name: string; category: string }[] =
        [];
      for (let i = HISTORY_MONTHS; i >= 1; i--) {
        rows.push({
          id: randomUUID(),
          date: monthsBack(i, 1),
          amount: "-1850.00",
          name: `RAVENSWOOD PROPERTY MGMT ${1000 + i}`,
          category: rentCategoryId,
        });
        rows.push({
          id: randomUUID(),
          date: monthsBack(i, 15),
          amount: "5200.00",
          name: "ACME CORP PAYROLL",
          category: salaryId,
        });
      }
      for (const r of rows) {
        await sql`
          INSERT INTO transactions
            (id, account_id, posted_at, amount, name, category_id, fitid, source)
          VALUES (${r.id}, ${checkingId}, ${r.date}, ${r.amount}, ${r.name},
                  ${r.category}, ${r.id}, 'manual')
        `;
      }

      // The cadence and anchor the projection dates paydays on. Inflows come
      // from observed take-home, never this declared gross (ADR-038 §3).
      await sql`
        INSERT INTO income_sources
          (id, name, cadence, gross_per_period, anchor_date, start_date, active)
        VALUES (${sourceId}, 'Acme Corp', 'monthly', '6500.00',
                ${monthsBack(1, 15)}, ${monthsBack(HISTORY_MONTHS, 15)}, true)
      `;
    } finally {
      await sql.end();
    }
  });

  test("records a cost, states it in four places, then settles it", async ({ page }) => {
    // ── 1. Bootstrap → dashboard ────────────────────────────────────────────
    await page.goto("/");
    await expect(page).toHaveURL(/\/login$/);
    await page.getByLabel("Password").fill("hunter2");
    await page.getByRole("button", { name: /set password/i }).click();
    await expect(page).toHaveURL("/");

    // Net worth, before anything is recorded. $9,500 + $20,000, and the whole
    // book — so this figure is exact rather than approximately right.
    await expect(page.getByRole("heading", { name: "Net worth" })).toBeVisible();
    await expect(page.getByText("$29,500.00", { exact: true }).first()).toBeVisible();

    // ── 2. The projection, before ───────────────────────────────────────────
    await page.goto("/plan/cashflow");
    await expect(page.getByRole("heading", { name: "Cash flow" })).toBeVisible();
    const before = await safeToSpend(page);
    expect(before, "the seeded book should leave a real figure to spend").toBeGreaterThan(1000);

    // And no sinking sentence, because nothing is recorded. A $0.00 here would
    // read as a verdict on a household that has simply not told the app
    // anything yet.
    await expect(page.getByText(/Over the next 12 months/)).toHaveCount(0);

    // ── 3. THE CLAIM (before): an empty list is not success ─────────────────
    await page.goto("/plan/sinking");
    await expect(page.getByRole("heading", { name: "Sinking funds" })).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Nothing recorded to work from yet" }),
    ).toBeVisible();
    // No headline, and in particular no "you should be holding $0.00".
    await expect(page.getByText(/You should be holding/)).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "The costs behind the figure" })).toHaveCount(0);

    // The boundary, in the app's own words, on the page that would be an
    // envelope system if it were one.
    await expect(page.getByText(/Nothing here moves or reserves money\./)).toBeVisible();

    // ── 4. Record the cost ──────────────────────────────────────────────────
    await page.getByRole("button", { name: "Add a cost" }).click();
    const form = page.locator("#add-planned-expense-form");
    await form.getByLabel("What it is").fill(COST_LABEL);
    await form.getByLabel("What this will cost").fill(COST_AMOUNT);
    await form.getByLabel("When it is due").fill(COST_DUE);
    await form.getByLabel("Start setting aside from").fill(COST_FUNDING_START);
    await form.getByRole("button", { name: "Record it" }).click();

    // No duplicate warning: nothing non-monthly is on the calendar, so there is
    // nothing this could collide with (ADR-045 §4).
    await expect(page.getByText("This looks like a bill you already track.")).toHaveCount(0);

    // ── 5. THE CLAIM: a figure, itemized, and the total IS the row ──────────
    const headline = page.getByText(
      /You should be holding \$[\d,]+\.\d{2} against the 1 known cost in the next 12 months\./,
    );
    await expect(headline).toBeVisible();
    const required = /\$[\d,]+\.\d{2}/.exec(await headline.innerText())?.[0] as string;
    expect(required, "the headline carries no figure").toMatch(/^\$[\d,]+\.\d{2}$/);
    // Six of roughly eight months elapsed on a $24,000 cost: a real fraction,
    // not the degenerate $0.00 a same-day funding start would produce.
    expect(Number(required.replace(/[$,]/g, ""))).toBeGreaterThan(1000);

    await expect(page.getByRole("heading", { name: "The costs behind the figure" })).toBeVisible();
    const costRow = page.locator("tbody tr").filter({ hasText: COST_LABEL }).first();
    await expect(costRow).toBeVisible();
    await expect(costRow).toContainText("$24,000.00");
    await expect(costRow).toContainText("Recorded here");
    // The itemization claim: one cost, so the last cell must be the headline.
    expect(
      (await costRow.locator("td").last().innerText()).trim(),
      "the headline does not match its own table",
    ).toBe(required);

    // ── 6. THE CLAIM: nothing moved ─────────────────────────────────────────
    // The envelope line, end to end. A `funded_amount`, a funding account, or a
    // contributions row would all have to show up here eventually; none of them
    // exists, so net worth is untouched by a $24,000 commitment.
    await page.goto("/");
    await expect(page.getByText("$29,500.00", { exact: true }).first()).toBeVisible();

    // ── 7. THE CLAIM: /plan states the same string ──────────────────────────
    await page.goto("/plan");
    await expect(page.getByRole("heading", { name: "Your plan" })).toBeVisible();
    // Verbatim. Two server components, two formatters, one figure (ADR-046
    // consequence 1) — and `/plan/sinking` was not consulted to produce it.
    await expect(
      page.getByText(required, { exact: false }).first(),
      "the guidance card does not quote the requirement",
    ).toBeVisible();
    await expect(
      page
        .getByText(/costs you (?:already know about|know are coming)|your known costs need/i)
        .first(),
    ).toBeVisible();

    // ── 8. THE CLAIM: the projection charges it, and says where it lands ────
    // The fourth event kind reaching the day walk. The cost lands 40 days out,
    // inside the 60-day horizon, and $24,000 against at most $19,900 of
    // operating cash by then takes the line below zero — so the headline is no longer a figure to
    // spend at all. The heading FLIPPING is the assertion: a projection that
    // dropped the event would still read "Safe to spend", with the same
    // comfortable number it had a minute ago.
    await page.goto("/plan/cashflow");
    await expect(page.getByRole("heading", { name: "Projected shortfall" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Safe to spend" })).toHaveCount(0);
    await expect(
      page.getByText(
        /You are projected to run out of money on \w+ \d+, reaching -?\$[\d,]+\.\d{2}\./,
      ),
    ).toBeVisible();

    // The sentence P18-29 had to correct. "Beyond this window" was true until
    // costs inside the window started landing on the line above it; saying so
    // is what stops the page counting the same cost in two places.
    await expect(
      page.getByText(
        /Over the next 12 months, 1 known cost means you should already be holding \$[\d,]+\.\d{2} for it\./,
      ),
    ).toBeVisible();
    await expect(
      page.getByText(/It lands inside the window above and is already on the line\./),
    ).toBeVisible();

    // ── 9. THE CLAIM: marking it paid removes it from both ──────────────────
    await page.goto("/plan/sinking");
    const managed = page.locator("li").filter({ hasText: COST_LABEL }).first();
    await expect(managed).toBeVisible();
    await managed.getByRole("button", { name: "Mark paid" }).click();

    // Back to the honest blank: the cost is kept as a record (ADR-043 §3) and
    // counts nothing (ADR-044 §7).
    await expect(
      page.getByRole("heading", { name: "Nothing recorded to work from yet" }),
    ).toBeVisible();
    await expect(page.getByText(/You should be holding/)).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Paid and cancelled" })).toBeVisible();
    await expect(page.locator("li").filter({ hasText: COST_LABEL }).first()).toContainText("paid");

    // And out of the projection — exactly, not approximately. A recorded cost
    // never touched the everyday spending rate (P18-30), so removing it has
    // nothing to restore but the one event it added.
    await page.goto("/plan/cashflow");
    expect(
      await safeToSpend(page),
      "a paid cost left the projection but the figure did not return to where it started",
    ).toBe(before);
    await expect(page.getByText(/Over the next 12 months/)).toHaveCount(0);
  });
});
