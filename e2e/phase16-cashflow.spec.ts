import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { type Page, expect, test } from "@playwright/test";
import postgres from "postgres";

/**
 * Phase 16 critical flow (P16-38): the app learns a bill from history, asks
 * before believing it, and turns it into a **date**.
 *
 * Per CLAUDE.md §Testing Philosophy this is the single cash-flow path we E2E.
 * The detector, the periodicity test, the residual rate, the day walk and
 * safe-to-spend are pure functions with ~150 unit tests behind them; what only
 * a browser can prove is that the composition survives the trip through a
 * server component, a server action, a background job, and a page refresh.
 *
 * Four assertions carry the test, matching the four things Phase 16 claims:
 *
 *   1. **Detection proposes.** Seven months of identical rent charges show up as
 *      a suggestion on `/plan/cashflow/review`, read off the user's own
 *      transactions with no lookup of any kind.
 *   2. **Nothing is believed until confirmed** (ADR-036 §2). Before the click,
 *      `/plan/cashflow` says in as many words that no bills are dated on the
 *      line. If a projection could quietly include an unconfirmed candidate,
 *      every unit test would still pass and the preview→confirm boundary would
 *      be decorative.
 *   3. **The confirmed bill becomes a date, and is not charged twice.** After
 *      the click the page states a low-water balance ON A DAY and the calendar
 *      lists the bill — but the headline figure does **not** collapse by two
 *      rents, because the rent MOVED from the flat spending rate onto the
 *      calendar rather than being added to it (ADR-038 §2). That is the
 *      phase's defining rule, and it is the one property a unit test can only
 *      check per-function: the residual and the day walk agreeing end to end
 *      is a property of the loader that assembles them.
 *   4. **The dashboard agrees, exactly.** ADR-029 §2 says the loader computes
 *      and the card renders; two surfaces disagreeing by a cent would mean two
 *      computations, which is the failure that design exists to prevent. The
 *      figure is scraped off the page and asserted verbatim on the card.
 *
 * Nothing here touches the network: the cash-flow layer has no egress by
 * construction (see privacy-egress.test.ts), and no prices are needed because
 * the projection walks operating cash only.
 *
 * The figures are chosen so the projection is unambiguous and stable whatever
 * day of the month the suite runs:
 *   $9,500 opening checking · $1,850 rent on the 1st · $5,200 take-home on the
 *   15th · ~$600/mo of ordinary spending. Two rents and two paychecks fall
 *   inside a 60-day horizon, and the worst case low point (~$4,600) stays
 *   comfortably positive — so safe-to-spend is a figure, not a shortfall, on
 *   every calendar day.
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

/** Day `day` of the month `n` whole months back (UTC). */
function monthsBack(n: number, day: number): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - n, day))
    .toISOString()
    .slice(0, 10);
}

const checkingId = randomUUID();
const sourceId = randomUUID();

const rentCategoryId = randomUUID();
const groceriesId = randomUUID();
const salaryId = randomUUID();

/**
 * Months of history seeded.
 *
 * Seven, for two independent reasons: the honesty ladder needs **three whole
 * months** before it will state a spending rate at all (`MIN_HISTORY_MONTHS`),
 * and the periodicity test needs at least three occurrences before it will call
 * a series a series. Seven clears both with room to spare, so a run on the 2nd
 * of a month is no different from a run on the 28th.
 */
const HISTORY_MONTHS = 7;

/** The landlord, spelled identically every month — this is what groups. */
const RENT_PAYEE = "RAVENSWOOD PROPERTY MGMT";
const RENT_AMOUNT = "-1850.00";

/** The headline figure on `/plan/cashflow`, as rendered — e.g. `"$4,612.40"`. */
async function headlineFigure(page: Page): Promise<string> {
  return await page
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: "Safe to spend" }) })
    .locator("div.font-mono")
    .first()
    .innerText();
}

/**
 * The headline figure as a number, for comparing two runs of the projection.
 *
 * `Number()` on a formatted string is exactly what CLAUDE.md §Money forbids in
 * the app — and exactly what a test comparing two rendered figures has to do.
 * Nothing computed here is ever written anywhere.
 */
async function safeToSpend(page: Page): Promise<number> {
  const raw = (await headlineFigure(page)).trim();
  expect(raw, "the headline is not a money figure").toMatch(/^\$[\d,]+\.\d{2}$/);
  return Number(raw.replace(/[$,]/g, ""));
}

test.describe("phase 16: a detected bill becomes a date, and a number", () => {
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
        income_sources, scheduled_obligations, obligation_occurrences, alerts
        CASCADE`);

      // ── The operating account ───────────────────────────────────────────
      // `subtype='checking'` is load-bearing, not decoration: the projection
      // walks OPERATING cash only (ADR-038 §6). Without the subtype this
      // account is unclassified, the ladder reports `no_operating_account`, and
      // the page correctly refuses to draw anything at all.
      await sql`
        INSERT INTO accounts (id, name, institution, type, subtype, currency)
        VALUES (${checkingId}, 'Everyday Checking', 'M&T Bank', 'depository', 'checking', 'USD')
      `;
      // Day zero of the walk is the latest snapshot per account.
      await sql`
        INSERT INTO account_snapshots (account_id, date, balance)
        VALUES (${checkingId}, ${daysAgo(0)}, '9500.00')
      `;

      // ── Categories ──────────────────────────────────────────────────────
      // `kind` matters twice: 'income' is what `observedNetIncome` sums for
      // take-home (never the declared gross), and 'transfer' would be excluded
      // from detection entirely — neither category here is one.
      await sql`
        INSERT INTO categories (id, name, kind, necessity) VALUES
          (${rentCategoryId}, 'Rent',      'expense', 'essential'),
          (${groceriesId},    'Groceries', 'expense', 'essential'),
          (${salaryId},       'Salary',    'income',  NULL)
      `;

      // ── Seven months of history ─────────────────────────────────────────
      // Rent on the 1st, identical every month — a clean monthly series with an
      // unmistakable 30/31-day median gap and zero amount spread, so the
      // detector reads it as `monthly` + `fixed` rather than declining to guess.
      // Groceries deliberately do NOT form a series: the payee token and the day
      // of month both move, so they stay ordinary spending and end up in the
      // residual rate instead of on the calendar.
      const rows: {
        id: string;
        date: string;
        amount: string;
        name: string;
        category: string;
      }[] = [];
      // Rent runs through the CURRENT month (i down to 0), because a series
      // whose last occurrence is more than two nominal periods old is
      // suppressed as stale — and last month's 1st is 59 days ago on the
      // 29th, one calendar day from failing this test for a reason that has
      // nothing to do with what it asserts. The 1st is never in the future.
      for (let i = HISTORY_MONTHS; i >= 0; i--) {
        rows.push({
          id: randomUUID(),
          date: monthsBack(i, 1),
          amount: RENT_AMOUNT,
          name: `${RENT_PAYEE} ${1000 + i}`,
          category: rentCategoryId,
        });
        // The 15th, however, would be a future-dated deposit early in the
        // month, so income and spending stop at last month.
        if (i === 0) continue;
        rows.push({
          id: randomUUID(),
          date: monthsBack(i, 15),
          amount: "5200.00",
          name: "ACME CORP PAYROLL",
          category: salaryId,
        });
        // Two irregular grocery runs a month, at three different stores.
        rows.push({
          id: randomUUID(),
          date: monthsBack(i, 7 + (i % 5)),
          amount: ["-284.19", "-311.05", "-266.73"][i % 3] as string,
          name: `MARKET ${["ELM", "BIRCH", "CEDAR"][i % 3]} STREET`,
          category: groceriesId,
        });
        rows.push({
          id: randomUUID(),
          date: monthsBack(i, 19 + (i % 6)),
          amount: ["-172.40", "-198.88", "-155.02"][i % 3] as string,
          name: `MARKET ${["CEDAR", "ELM", "BIRCH"][i % 3]} STREET`,
          category: groceriesId,
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

      // ── The paycheck ────────────────────────────────────────────────────
      // The source supplies the CADENCE and ANCHOR the projection dates
      // paydays on. Its `gross_per_period` is deliberately not what lands on
      // the line: inflows come from observed take-home (ADR-038 §3), which is
      // the $5,200 that actually posted, not this $6,500.
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

  test("detects the rent, asks first, then states a date the dashboard agrees with", async ({
    page,
  }) => {
    // ── 1. Bootstrap → dashboard ────────────────────────────────────────────
    await page.goto("/");
    await expect(page).toHaveURL(/\/login$/);
    await page.getByLabel("Password").fill("hunter2");
    await page.getByRole("button", { name: /set password/i }).click();
    await expect(page).toHaveURL("/");

    // ── 2. THE CLAIM (before): no bills are believed yet ─────────────────────
    // The projection exists — there is a balance and a spending rate — but it
    // is run-rate-only and says so. This is the assertion that makes the
    // confirm step below mean something.
    await page.goto("/plan/cashflow");
    await expect(page.getByRole("heading", { name: "Cash flow" })).toBeVisible();
    await expect(page.getByText(/no bills are dated on this line yet/i)).toBeVisible();
    await expect(
      page.getByText(/No bills are dated inside this window|Confirming a recurring bill/i).first(),
    ).toBeVisible();

    // Keep the figure. At this point the rent is inside the flat spending rate
    // and nowhere else; after confirming it is on the calendar and nowhere
    // else. A projection that double-counted would charge it in both places,
    // and the two numbers are how that gets caught (see step 6).
    const before = await safeToSpend(page);

    // ── 3. Detection proposes ───────────────────────────────────────────────
    await page.goto("/plan/cashflow/review");
    await expect(page.getByRole("heading", { name: "Recurring bills" })).toBeVisible();

    // The landlord is found by grouping the user's own payee strings — the
    // month-varying reference number (`… 1007`) is normalized away, which is
    // the whole reason seven differently-suffixed charges are one series.
    const rentRow = page
      .locator("li")
      .filter({ hasText: new RegExp(RENT_PAYEE, "i") })
      .first();
    await expect(rentRow).toBeVisible();
    await expect(rentRow).toContainText("monthly");
    await expect(rentRow).toContainText("$1,850.00");

    // The evidence is inspectable before the decision, not after it.
    await rentRow.getByRole("button", { name: "Show the charges" }).click();
    await expect(rentRow.getByText(`${monthsBack(1, 1)} \u00b7 $1,850.00`)).toBeVisible();

    // ── 4. Nothing is written until the click ───────────────────────────────
    await rentRow.getByRole("button", { name: "Confirm" }).click();

    // It has moved out of "found in your history" and into the confirmed
    // schedule — the section that only ever holds rows the user agreed to.
    const schedule = page
      .locator("section")
      .filter({ has: page.getByRole("heading", { name: "Confirmed bills" }) });
    await expect(schedule.getByText(new RegExp(RENT_PAYEE, "i")).first()).toBeVisible();

    // ── 5. The nightly job turns the schedule into a calendar ───────────────
    // Materializes occurrences, matches the ones whose window has closed
    // against the transactions that actually posted, and raises or resolves
    // cash-flow alerts. Idempotent by construction, so running it here is the
    // same operation the 02:00 chain performs.
    execSync(
      "node --import tsx --import ./scripts/loaders/register.mjs src/worker/run-once.ts project-cashflow-daily",
      {
        cwd: process.cwd(),
        env: { ...process.env, DATABASE_URL: databaseUrl() },
        stdio: "inherit",
      },
    );

    // ── 6. THE CLAIM (after): a number, and a DATE ──────────────────────────
    await page.goto("/plan/cashflow");

    // The run-rate-only caveat is gone, because the caveat was true and is not
    // any more.
    await expect(page.getByText(/no bills are dated on this line yet/i)).toHaveCount(0);

    // The sentence this entire phase exists to produce.
    const lowWater = page.getByText(
      /Your lowest projected balance is \$[\d,]+\.\d{2} on \w+ \d+\./,
    );
    await expect(lowWater).toBeVisible();

    // Safe-to-spend, stated as something a family member can act on rather than
    // as a bare figure — and never without its horizon, which is what stops it
    // reading as a balance (ADR-038 §5).
    await expect(page.getByRole("heading", { name: "Safe to spend" })).toBeVisible();
    await expect(
      page.getByText(/You could spend \$[\d,]+\.\d{2} on top of your usual spending/),
    ).toBeVisible();
    await expect(page.getByText(/Over 60 days/)).toBeVisible();

    // The confirmed rent is now attributed rather than sitting anonymously in
    // the run-rate, so the page can state what share of spending the calendar
    // accounts for. Zero here would mean nothing was attributed at all.
    const coverage = page.getByText(/(\d+)% of your recent spending is bills this calendar knows/);
    await expect(coverage).toBeVisible();
    const coverageText = (await coverage.innerText()).trim();
    const coveragePct = Number(/^(\d+)%/.exec(coverageText)?.[1] ?? "0");
    expect(
      coveragePct,
      `the confirmed rent should be attributed, got "${coverageText}"`,
    ).toBeGreaterThan(25);

    // ── THE INVARIANT (ADR-038 §2) ──────────────────────────────────────────
    // Two rents fall inside a 60-day horizon. A projection that took a
    // total-spend run-rate AND ALSO dated the mortgage would charge the
    // household ~$3,700 it does not owe, and safe-to-spend would collapse by
    // roughly that much the moment the bill was confirmed. It must not: the
    // rent moved OUT of the rate as it moved ONTO the calendar.
    //
    // The bound is one rent rather than an exact equality because the two
    // figures are not identical by construction — a flat daily rate spreads a
    // monthly bill evenly while the calendar lands it on the 1st, so the low
    // point genuinely shifts. One rent is comfortably tighter than the ~$3,700
    // a double-count costs and comfortably looser than that legitimate shift.
    const after = await safeToSpend(page);
    expect(
      after,
      `confirming a bill already inside observed spend cost $${(before - after).toFixed(2)} — that is a double-count, not a projection`,
    ).toBeGreaterThan(before - 1850);

    // The bill is on the calendar, by name, on a day.
    const upcoming = page
      .locator("section")
      .filter({ has: page.getByRole("heading", { name: "What is coming" }) });
    await expect(upcoming.getByText(new RegExp(RENT_PAYEE, "i")).first()).toBeVisible();

    // ── 7. The dashboard agrees, to the cent ────────────────────────────────
    const figure = (await headlineFigure(page)).trim();
    expect(figure).toMatch(/^\$[\d,]+\.\d{2}$/);

    await page.goto("/");
    const card = page
      .locator("section")
      .filter({ has: page.getByRole("heading", { name: "Safe to spend" }) })
      .first();
    await expect(card).toBeVisible();
    // Same loader, same number — ADR-029 §2 in one assertion.
    await expect(card).toContainText(figure);
    // And the same qualifier: the card never shows the figure bare either.
    await expect(card).toContainText(/next 60 days/);
  });
});
