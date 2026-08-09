import { randomUUID } from "node:crypto";
import { type Page, expect, test } from "@playwright/test";
import postgres from "postgres";

/**
 * Phase 13 critical flow (P13-21): seed a small but complete book — an
 * investment account with a priced, dividend-paying holding; a cash account; a
 * year of snapshots; a budget with this month's spend — then bootstrap, load
 * `/`, and confirm the curated dashboard renders **real figures** in the hero
 * and the cards, that the shared `?range=` toggle re-drives the server render,
 * and that every card's "→ deep page" link points at the page that owns its
 * data.
 *
 * Per CLAUDE.md §Testing Philosophy this is the single dashboard path we E2E.
 * The loader's composition + status discrimination is unit-tested
 * (`loader.test.ts`), the range/delta math has its own suites, and the zero-egress
 * guarantee has a privacy regression — so this covers the one thing none of them
 * can: that the assembled page actually renders the numbers a browser sees.
 *
 * The figures are chosen to be exact and unambiguous:
 *   cash 10,000.00 + (100 shares × 200.00) = **30,000.00** net worth,
 *   allocation total **20,000.00**, forward income 100 × 2.00 = **200.00**,
 *   spend 650.00 against a 500.00 budget = **150.00 over**.
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

/** `YYYY-MM-DD` for the given day of the current month. */
function dayOfThisMonth(day: number): string {
  const d = new Date();
  return `${d.toISOString().slice(0, 7)}-${String(day).padStart(2, "0")}`;
}

/**
 * The snapshot history lives 100+ days back on purpose: a 1Y range then has
 * three points to measure, while a 1M range has none — which is what lets the
 * range toggle assertion below prove the server re-rendered rather than just
 * repainting the same card.
 */
const HISTORY_DAYS = [300, 200, 100] as const;

const SYMBOL = "VTI";
const BENCHMARK = "^GSPC";

/** The card `<section>` that owns the given heading. */
function card(page: Page, title: string) {
  return page.locator("section").filter({
    has: page.getByRole("heading", { name: title, exact: true }),
  });
}

test.describe("phase 13: curated dashboard", () => {
  test.beforeAll(async () => {
    try {
      process.loadEnvFile(".env.local");
    } catch {
      /* CI env injects real vars */
    }
    const sql = postgres(databaseUrl(), { max: 1 });
    try {
      await sql.unsafe(`TRUNCATE
        users, accounts, holdings, holding_snapshots, account_snapshots, securities,
        prices, transactions, categories, category_groups, category_budgets,
        watchlist_items, alerts, investment_transactions, holding_lots, liabilities
        CASCADE`);

      const brokerageId = randomUUID();
      const checkingId = randomUUID();
      await sql`
        INSERT INTO accounts (id, name, institution, type, currency) VALUES
          (${brokerageId}, 'Brokerage', 'Vanguard', 'investment', 'USD'),
          (${checkingId}, 'Everyday Checking', 'M&T Bank', 'depository', 'USD')
      `;

      // A dividend-paying security → the forward-income card has something to say.
      const securityId = randomUUID();
      await sql`
        INSERT INTO securities (id, symbol, name, sector, region, asset_type, dividend_rate)
        VALUES (${securityId}, ${SYMBOL}, 'Total Stock Market ETF', 'Technology', 'US', 'etf', '2.00')
      `;

      const holdingId = randomUUID();
      await sql`
        INSERT INTO holdings
          (id, account_id, symbol, quantity, quantity_unit, asset_class, cost_basis, security_id, source)
        VALUES
          (${holdingId}, ${brokerageId}, ${SYMBOL}, '100.00000000', 'shares', 'equity',
           '15000.00', ${securityId}, 'manual')
      `;

      // Prices: the history dates plus today. Today's close (200.00) × 100 shares
      // is what the hero values the brokerage at.
      const closes: ReadonlyArray<{ date: string; sym: string; bench: string }> = [
        { date: daysAgo(HISTORY_DAYS[0]), sym: "150.00000000", bench: "4000.00000000" },
        { date: daysAgo(HISTORY_DAYS[1]), sym: "170.00000000", bench: "4200.00000000" },
        { date: daysAgo(HISTORY_DAYS[2]), sym: "185.00000000", bench: "4400.00000000" },
        { date: daysAgo(0), sym: "200.00000000", bench: "4600.00000000" },
      ];
      for (const c of closes) {
        await sql`
          INSERT INTO prices (symbol, date, close, source) VALUES
            (${SYMBOL}, ${c.date}, ${c.sym}, 'seed'),
            (${BENCHMARK}, ${c.date}, ${c.bench}, 'seed')
        `;
      }

      // Holding + account snapshots on the three history dates.
      for (const c of closes.slice(0, 3)) {
        const value = (100 * Number(c.sym)).toFixed(2);
        await sql`
          INSERT INTO holding_snapshots (holding_id, date, quantity, value, cost_basis, currency)
          VALUES (${holdingId}, ${c.date}, '100.00000000', ${value}, '15000.00', 'USD')
        `;
        await sql`
          INSERT INTO account_snapshots (account_id, date, balance) VALUES
            (${brokerageId}, ${c.date}, ${value}),
            (${checkingId}, ${c.date}, '10000.00')
        `;
      }
      // Today's cash balance — the hero reads the latest snapshot for a
      // depository account (investment accounts are valued live from prices).
      await sql`
        INSERT INTO account_snapshots (account_id, date, balance)
        VALUES (${checkingId}, ${daysAgo(0)}, '10000.00')
      `;

      // A budget + this month's spend: 650.00 actual against a 500.00 target.
      const groceriesId = randomUUID();
      await sql`
        INSERT INTO categories (id, name, kind, sort_order)
        VALUES (${groceriesId}, 'Groceries', 'expense', 1)
      `;
      await sql`
        INSERT INTO category_budgets (category_id, amount, currency)
        VALUES (${groceriesId}, '500.00', 'USD')
      `;
      for (const t of [
        { day: 1, amount: "-400.00", name: "Whole Foods" },
        { day: 2, amount: "-250.00", name: "Corner Market" },
      ]) {
        await sql`
          INSERT INTO transactions (account_id, posted_at, amount, name, fitid, source, category_id)
          VALUES (${checkingId}, ${dayOfThisMonth(t.day)}, ${t.amount}, ${t.name},
                  ${randomUUID()}, 'manual', ${groceriesId})
        `;
      }
    } finally {
      await sql.end();
    }
  });

  test("renders the curated grid, honors the range toggle, and links out", async ({ page }) => {
    // ── 1. Bootstrap (set password) → lands on the dashboard ────────────────
    await page.goto("/");
    await expect(page).toHaveURL(/\/login$/);
    await page.getByLabel("Password").fill("hunter2");
    await page.getByRole("button", { name: /set password/i }).click();
    await expect(page).toHaveURL("/");

    // ── 2. The hero carries the real net worth, not a placeholder ───────────
    // 10,000.00 cash + 100 shares × 200.00 = 30,000.00.
    await expect(page.getByRole("heading", { name: "Net worth" })).toBeVisible();
    await expect(page.getByText("$30,000.00", { exact: true })).toBeVisible();

    // ── 3. Allocation + spending cards show real figures ────────────────────
    // The total appears twice — as the card's headline and again in the donut
    // legend, which is the whole book in one slice here.
    const allocation = card(page, "Allocation");
    await expect(allocation.getByText("$20,000.00").first()).toBeVisible();
    await expect(allocation.getByText("100.00% · $20,000.00")).toBeVisible();

    const spending = card(page, "Spending");
    // The headline total, then the progress bar's caption: 650.00 spent against
    // a 500.00 budget leaves 150.00 over.
    await expect(spending.getByText("$650.00", { exact: true })).toBeVisible();
    await expect(spending.getByText("$650.00 of $500.00 budgeted")).toBeVisible();
    // Twice by design: the bar caption, and again in the top-overages list.
    await expect(spending.getByText("$150.00 over")).toHaveCount(2);
    await expect(spending.getByText("Groceries")).toBeVisible();

    // Forward income: 100 shares × a 2.00 annual rate (ADR-022 — an estimate).
    const income = card(page, "Forward income");
    await expect(income.getByText("$200.00", { exact: true })).toBeVisible();
    await expect(income.getByText(`Largest payers: ${SYMBOL} $200.00`)).toBeVisible();
    // ADR-022: the page must call it an estimate, right next to the number.
    await expect(income.getByText(/^Estimate —/)).toBeVisible();

    // ── 4. Performance renders a return for the default 1Y range ────────────
    const performance = card(page, "Performance");
    await expect(performance.getByText("Return (range)")).toBeVisible();
    await expect(performance.getByText("Insufficient history for this range.")).toHaveCount(0);

    // ── 5. The shared range toggle re-drives the server render ──────────────
    // All three snapshot days sit 100+ days back, so a 1M window has too little
    // history to measure — the card must say so (ADR-021) rather than invent a %.
    await page.getByRole("radio", { name: "1M", exact: true }).click();
    await expect(page).toHaveURL(/\?range=1M/);
    await expect(performance.getByText("Insufficient history for this range.")).toBeVisible();
    // The hero itself is a current figure — the range rewinds history, not "now".
    await expect(page.getByText("$30,000.00", { exact: true })).toBeVisible();

    // Back to a range with history and the return comes back.
    await page.getByRole("radio", { name: "1Y", exact: true }).click();
    await expect(page).toHaveURL(/\?range=1Y/);
    await expect(performance.getByText("Insufficient history for this range.")).toHaveCount(0);

    // ── 6. Every card deep-links to the page that owns its data ─────────────
    const deepLinks: ReadonlyArray<readonly [string, string]> = [
      ["Allocation", "/investments"],
      ["Performance", "/investments/performance"],
      ["Spending", "/analysis"],
      ["Forward income", "/investments/forecast"],
      ["Alerts", "/alerts"],
      ["Watchlist movers", "/watchlist"],
    ];
    for (const [title, href] of deepLinks) {
      await expect(card(page, title).locator(`a[href="${href}"]`).first()).toBeVisible();
    }

    // …and the links actually navigate (spot-check two of the six).
    await card(page, "Allocation")
      .getByRole("link", { name: /investments/i })
      .first()
      .click();
    await expect(page).toHaveURL(/\/investments$/);
    await page.goBack();

    await card(page, "Spending")
      .getByRole("link", { name: /analysis/i })
      .first()
      .click();
    await expect(page).toHaveURL(/\/analysis$/);
  });
});
