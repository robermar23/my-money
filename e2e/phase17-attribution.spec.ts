import { randomUUID } from "node:crypto";
import { type Page, expect, test } from "@playwright/test";
import postgres from "postgres";

/**
 * Phase 17 critical flow (P17-29): the app explains a number it already showed,
 * and admits what it cannot explain.
 *
 * Per CLAUDE.md §Testing Philosophy this is the single attribution path we E2E.
 * The boundary rules, the pairing tie-breaks, the five rungs, the identity, the
 * degradation ladder and every diagnostic are pure functions with ~220 unit
 * tests behind them; what only a browser can prove is that the composition
 * survives the trip through the loader, a server component, a client island, and
 * a page reload — and that the two halves of the phase's thesis actually hold on
 * a real book.
 *
 * **Both halves are asserted, and the second one is the phase.**
 *
 *   1. **A clean book reconciles.** Every dollar of the change is claimed by a
 *      rung and `Not yet explained` is **$0.00** — on a book that contains a
 *      mortgage (whose principal is deliberately counted twice with opposite
 *      signs), a paired internal transfer (which must move nothing), and a
 *      brokerage deposit (which must NOT read as market growth). Each of those
 *      is a way to be wrong by a few hundred dollars while the page still looks
 *      plausible, and the residual is the only thing that catches all three at
 *      once.
 *   2. **A dirtied book grows its residual AND says why.** Removing the category
 *      from one $1,500 expense makes `saved` $1,500 too generous, so the
 *      residual moves to exactly −$1,500 and the `Uncategorized transactions`
 *      diagnostic appears with a link to go and fix it. A decomposition that
 *      quietly absorbed the damage — or that reported it with nothing to point
 *      at — would fail here and pass every unit test.
 *
 * And one structural claim that only two pages side by side can check: the
 * closing figure on `/analysis/networth` is the **same number** the dashboard
 * hero shows, to the cent (ADR-039 §1). Two surfaces disagreeing would mean two
 * derivations of net worth, which is the failure that design exists to prevent.
 *
 * The window is a fixed 60 days ending today, passed as explicit `?from=&to=`
 * so the run is identical whatever day of the month it happens on. Every figure
 * below is chosen so the identity closes exactly:
 *
 *   Δchecking  +1,500  (earned 6,000 − spent 1,500 − mortgage 2,000 − moved 1,000)
 *   Δbrokerage +2,000  (100 shares × 100.00 → 120.00, of which 1,000 was a deposit)
 *   Δmortgage    +P    (whatever the schedule says two months of principal is)
 *
 *   delta = 3,500 + P  =  saved 2,500 + investment_return 1,000 + debt_principal P
 *
 * `P` is deliberately never asserted as a literal. It is the amortization
 * schedule's own answer and it moves with the calendar — but it appears on BOTH
 * sides of the identity, so the residual is zero regardless, which is the actual
 * claim.
 *
 * Nothing here touches the network: the attribution layer has no egress by
 * construction (see privacy-egress.test.ts), and prices come from the seeded
 * `prices` rows rather than any fetch.
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

const FROM = daysAgo(60);
const TO = daysAgo(0);

const checkingId = randomUUID();
const brokerageId = randomUUID();
const mortgageId = randomUUID();
const holdingId = randomUUID();

const salaryCategoryId = randomUUID();
const groceriesCategoryId = randomUUID();
const housingCategoryId = randomUUID();
const transferCategoryId = randomUUID();

/** The expense whose category gets removed in the second half. */
const GROCERIES_TXN = randomUUID();

const SYMBOL = "VTSAX";

/**
 * The rung table's figure for one label.
 *
 * The table is the chart's text alternative (P17-21), which is exactly why the
 * assertions read from it: every figure the waterfall draws is here, and a
 * screen reader gets the same page this test does.
 */
async function rungAmount(page: Page, label: string): Promise<string> {
  const row = page.locator("li").filter({ hasText: label }).first();
  return (await row.locator("span.font-mono").first().innerText()).trim();
}

/**
 * A rendered money figure as a number, for comparing two runs of the page.
 *
 * `Number()` on a formatted string is exactly what CLAUDE.md §Money forbids in
 * the app — and exactly what a test comparing two rendered figures has to do.
 * Nothing computed here is ever written anywhere.
 */
function asNumber(rendered: string): number {
  expect(rendered, "not a money figure").toMatch(/^-?\$[\d,]+\.\d{2}$/);
  return Number(rendered.replace(/[$,]/g, ""));
}

test.describe("phase 17: the decomposition reconciles, and names what it cannot explain", () => {
  test.beforeAll(async () => {
    try {
      process.loadEnvFile(".env.local");
    } catch {
      /* CI env injects real vars */
    }
    const sql = postgres(databaseUrl(), { max: 1 });
    try {
      await sql.unsafe(`TRUNCATE
        users, accounts, account_snapshots, holdings, holding_snapshots, securities,
        prices, transactions, categories, category_groups, liabilities,
        investment_transactions, alerts
        CASCADE`);

      // ── The three accounts ──────────────────────────────────────────────
      await sql`
        INSERT INTO accounts (id, name, institution, type, subtype, currency) VALUES
          (${checkingId},  'Everyday Checking', 'M&T Bank',  'depository', 'checking', 'USD'),
          (${brokerageId}, 'Fidelity Brokerage','Fidelity',  'investment',  NULL,      'USD'),
          (${mortgageId},  'Sunwest Mortgage',  'Sunwest',   'loan',        NULL,      'USD')
      `;

      // Checking is snapshot-valued at BOTH ends of the window. Balances more
      // than 45 days stale would trip the `snapshot_gap` diagnostic and make the
      // clean half of this test noisy for a reason it is not about.
      await sql`
        INSERT INTO account_snapshots (account_id, date, balance) VALUES
          (${checkingId}, ${FROM}, '20000.00'),
          (${checkingId}, ${TO},   '21500.00')
      `;

      // ── The brokerage: one priced position ──────────────────────────────
      // `computeNetWorth` values an investment account from holdings × the close
      // on the date (R4/R6), so the endpoints are 10,000 → 12,000 without any
      // snapshot on the account at all.
      await sql`
        INSERT INTO holdings (id, account_id, symbol, quantity, quantity_unit, asset_class, source)
        VALUES (${holdingId}, ${brokerageId}, ${SYMBOL}, '100.00000000', 'shares', 'equity', 'manual')
      `;
      await sql`
        INSERT INTO prices (symbol, date, close, source) VALUES
          (${SYMBOL}, ${FROM}, '100.00000000', 'seed'),
          (${SYMBOL}, ${TO},   '120.00000000', 'seed')
      `;
      // The share count at the opening date, recorded. Without this the app
      // correctly reports that it does not know what was held then (the ADR-039
      // §2 quantity wart) — true, and not what this test is about.
      await sql`
        INSERT INTO holding_snapshots (holding_id, date, quantity, value, cost_basis, currency)
        VALUES
          (${holdingId}, ${FROM}, '100.00000000', '10000.00', '9000.00', 'USD'),
          (${holdingId}, ${TO},   '100.00000000', '12000.00', '9000.00', 'USD')
      `;

      // ── The mortgage: terms, not a balance ──────────────────────────────
      // A `loan` account is valued from the amortization schedule and its
      // snapshots are ignored entirely, so the ONLY thing needed here is terms.
      // A loan with no `liabilities` row is left out of net worth at both ends
      // and would raise the `untracked_loan` diagnostic instead.
      await sql`
        INSERT INTO liabilities
          (account_id, name, principal_at_origination, annual_rate, term_months, start_date)
        VALUES (${mortgageId}, '30yr fixed', '300000.00', '0.055000', 360, '2020-06-01')
      `;

      // ── Categories ──────────────────────────────────────────────────────
      // `kind` is what the household boundary reads: 'income'/'expense' cross it,
      // 'transfer' is decided by whether the counterparty leg was found.
      await sql`
        INSERT INTO categories (id, name, kind, necessity) VALUES
          (${salaryCategoryId},    'Salary',    'income',   NULL),
          (${groceriesCategoryId}, 'Groceries', 'expense',  'essential'),
          (${housingCategoryId},   'Housing',   'expense',  'essential'),
          (${transferCategoryId},  'Transfer',  'transfer', NULL)
      `;

      // ── The window's transactions ───────────────────────────────────────
      const txns: Array<{
        id: string;
        account: string;
        date: string;
        amount: string;
        name: string;
        category: string;
      }> = [
        {
          id: randomUUID(),
          account: checkingId,
          date: daysAgo(30),
          amount: "6000.00",
          name: "ACME CORP PAYROLL",
          category: salaryCategoryId,
        },
        {
          id: GROCERIES_TXN,
          account: checkingId,
          date: daysAgo(25),
          amount: "-1500.00",
          name: "MARKET ELM STREET",
          category: groceriesCategoryId,
        },
        // The whole payment, because that is what the bank shows. `saved` falls
        // by all 2,000; `debt_principal` adds the principal back; the net is the
        // interest — which is exactly what a mortgage payment costs you.
        {
          id: randomUUID(),
          account: checkingId,
          date: daysAgo(20),
          amount: "-2000.00",
          name: "SUNWEST MORTGAGE PMT",
          category: housingCategoryId,
        },
        // Two legs of one internal move. Both are `transfer`, they are five days
        // apart at most and identical in amount, so they PAIR — and a paired
        // transfer must move no rung at all. If pairing broke, `saved` would
        // fall by 1,000 and the residual would show it.
        {
          id: randomUUID(),
          account: checkingId,
          date: daysAgo(15),
          amount: "-1000.00",
          name: "TRANSFER TO FIDELITY",
          category: transferCategoryId,
        },
        {
          id: randomUUID(),
          account: brokerageId,
          date: daysAgo(15),
          amount: "1000.00",
          name: "TRANSFER FROM CHECKING",
          category: transferCategoryId,
        },
      ];
      for (const t of txns) {
        await sql`
          INSERT INTO transactions
            (id, account_id, posted_at, amount, name, category_id, fitid, source)
          VALUES (${t.id}, ${t.account}, ${t.date}, ${t.amount}, ${t.name},
                  ${t.category}, ${t.id}, 'manual')
        `;
      }

      // The same $1,000 as the brokerage sees it. `investment_return` subtracts
      // this before calling anything market growth — otherwise a deposit would
      // read as a gain, which is the single most flattering way to be wrong.
      // `source='manual'`, NOT `'income'`: a payroll-direct contribution has its
      // own rung and this is not one.
      await sql`
        INSERT INTO investment_transactions
          (account_id, type, subtype, trade_date, amount, name, source)
        VALUES (${brokerageId}, 'cash', 'deposit', ${daysAgo(15)}, '1000.00',
                'TRANSFER FROM CHECKING', 'manual')
      `;
    } finally {
      await sql.end();
    }
  });

  test("reconciles a clean book, then grows the residual and says why", async ({ page }) => {
    // ── 1. Bootstrap ────────────────────────────────────────────────────────
    await page.goto("/");
    await expect(page).toHaveURL(/\/login$/);
    await page.getByLabel("Password").fill("hunter2");
    await page.getByRole("button", { name: /set password/i }).click();
    await expect(page).toHaveURL("/");

    // ── 2. The dashboard's net worth, as the household sees it ──────────────
    // 21,500 checking + 12,000 brokerage − the mortgage balance. Scraped rather
    // than asserted as a literal, because the mortgage balance moves with the
    // calendar — the CLAIM is that the other page says the same thing.
    await expect(page.getByRole("heading", { name: "Net worth" })).toBeVisible();
    const heroFigure = (
      await page
        .locator("main")
        .getByText(/^-?\$[\d,]+\.\d{2}$/)
        .first()
        .innerText()
    ).trim();
    expect(heroFigure).toMatch(/^-?\$[\d,]+\.\d{2}$/);

    // ── 3. The attribution page ─────────────────────────────────────────────
    await page.goto(`/analysis/networth?from=${FROM}&to=${TO}`);
    await expect(page.getByRole("heading", { name: "What changed your net worth" })).toBeVisible();

    // The waterfall renders. It is `aria-hidden` on purpose — the rung table is
    // its text alternative — so it is located by its markup rather than a role.
    await expect(page.locator(".recharts-surface").first()).toBeVisible();

    // ── 4. ADR-039 §1: the closing figure IS the dashboard's ────────────────
    // Not "close to". The endpoints come from the same `computeNetWorth`, and
    // this is the one assertion a unit test cannot make.
    const endpoints = await page.getByRole("heading", { name: /^From .* to .*$/ }).innerText();
    const closing = endpoints.replace(/^From .*? to /, "").trim();
    expect(closing, "the attribution page disagrees with the dashboard").toBe(heroFigure);

    // ── 5. THE CLAIM (clean): every dollar is claimed by a rung ─────────────
    expect(await rungAmount(page, "Saved from income")).toBe("$2,500.00");
    expect(await rungAmount(page, "Investment return")).toBe("$1,000.00");
    // The schedule's own answer for two months of a 30-year note — a real
    // figure, never zero, and never asserted as a literal.
    expect(asNumber(await rungAmount(page, "Loan principal paid"))).toBeGreaterThan(0);
    // Nothing revalued and nothing came from payroll, and the rows say so
    // rather than being dropped: "we checked and it was nothing" and "we did not
    // look" are different statements.
    expect(await rungAmount(page, "Retirement contributions")).toBe("$0.00");
    expect(await rungAmount(page, "Property & asset revaluation")).toBe("$0.00");

    // The residual, on a book where the app can see everything: a cent, and the
    // cent is not slop.
    //
    // `balanceAtMonth` returns the loan balance at FULL precision. The endpoints
    // round once each — round(Σ items at T0), round(Σ items at T1) — while this
    // rung rounds the DIFFERENCE of the two full-precision balances, once. Two
    // roundings against one disagree by up to a cent on any amortizing loan, and
    // any book with a mortgage will show ±$0.01 here forever.
    //
    // It is left that way on purpose. Making the rung agree exactly would mean
    // deriving it from the same rounded balances the identity is trying to
    // explain, which is precisely the "arranged, not checked" failure ADR-039 §4
    // exists to prevent — and it would buy a cent. The tolerance is stated here
    // rather than widened later: one cent, not "about zero".
    const cleanResidual = await rungAmount(page, "Not yet explained");
    expect(
      Math.abs(asNumber(cleanResidual)),
      `a book the app can fully see should leave nothing but rounding, got ${cleanResidual}`,
    ).toBeLessThanOrEqual(0.01);

    // And the sentence leads with the largest thing that happened rather than
    // reciting the table.
    await expect(
      page.getByText(/Your net worth rose by \$[\d,]+\.\d{2} between .* and .*, mostly from/),
    ).toBeVisible();
    await expect(page.getByText(/mostly from/)).toContainText("saved from income");
    // Nothing to admit, so nothing is admitted.
    await expect(page.getByText(/cannot yet account for/)).toHaveCount(0);

    // ── 6. Dirty the book: one expense loses its category ───────────────────
    // Not a deletion and not a change of amount — the money still left the
    // account, the app just no longer knows what it was. `saved` therefore reads
    // 1,500 too generous, and that has to surface somewhere.
    const sql = postgres(databaseUrl(), { max: 1 });
    try {
      await sql`UPDATE transactions SET category_id = NULL WHERE id = ${GROCERIES_TXN}`;
    } finally {
      await sql.end();
    }

    // ── 7. THE CLAIM (dirty): the residual grows AND names its cause ────────
    await page.reload();

    // `saved` is now 6,000 − 2,000, because an uncategorized row is reported
    // rather than guessed into an expense on the strength of its sign.
    expect(await rungAmount(page, "Saved from income")).toBe("$4,000.00");

    // Exactly the missing category, to the cent the loan rounding accounts for.
    // A bound rather than an equality would pass on a residual that grew for
    // some other reason entirely, which is the thing worth catching here.
    const dirtyResidual = await rungAmount(page, "Not yet explained");
    expect(
      asNumber(dirtyResidual) - asNumber(cleanResidual),
      `losing a $1,500 category should move the residual by exactly that, got ${dirtyResidual}`,
    ).toBeCloseTo(-1500, 2);

    // The rungs that had nothing to do with it did not move — a residual that
    // absorbed the damage by quietly re-cutting the other rungs would be worse
    // than one that grew.
    expect(await rungAmount(page, "Investment return")).toBe("$1,000.00");

    // And this is the half the phase exists for: the gap is not just reported,
    // it is EXPLAINED, with somewhere to go.
    const diagnostics = page
      .locator("section")
      .filter({ has: page.getByRole("heading", { name: "Why some of it is unexplained" }) });
    await expect(diagnostics).toBeVisible();

    const uncategorized = diagnostics
      .locator("li")
      .filter({ hasText: "Uncategorized transactions" })
      .first();
    await expect(uncategorized).toBeVisible();
    await expect(uncategorized).toContainText("$1,500.00");
    await expect(uncategorized).toContainText(/1 transaction in this window has no category/);
    // A diagnostic without a fix link is a complaint.
    await expect(uncategorized.getByRole("link", { name: /Fix this/ })).toBeVisible();

    // The sentence says it too, in as many words, rather than leaving the
    // admission to a table the household may not scroll to.
    await expect(page.getByText(/of that is money this app cannot yet account for/)).toBeVisible();

    // ── 8. And it never names the merchant ──────────────────────────────────
    // A diagnostic names ACCOUNTS, never payees. The uncategorized row here is a
    // grocery run; on a real book it is a therapist or a person. Asserted on the
    // rendered page, not just in the unit test, because this is the surface that
    // gets screenshotted.
    await expect(page.getByText("MARKET ELM STREET")).toHaveCount(0);
  });
});
