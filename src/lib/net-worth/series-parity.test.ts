import { db } from "@/db/client.ts";
import {
  accountSnapshots,
  accounts,
  holdings,
  liabilities,
  plaidItems,
  prices,
} from "@/db/schema/index.ts";
import { sql } from "drizzle-orm";
import * as fc from "fast-check";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { type NetWorthPoint, computeNetWorth, netWorthSeries } from "./compute.ts";

/**
 * **The parity test for the `netWorthSeries` set-based rewrite (NW-04/NW-05).**
 *
 * `netWorthSeries` used to be a loop that called `computeNetWorth` once per
 * snapshot date — correct, and 98k queries / 85 s on a three-year book. It is now
 * a single set-based query. The rewrite is only acceptable if it is **numerically
 * identical**: one cent of drift on any historical date is a bug, not an
 * improvement.
 *
 * `computeNetWorth` is still exported and still untouched, so the pre-rewrite
 * implementation can be reconstructed in twelve lines *here* — {@link
 * referenceSeries} below — and run side by side on the same data. That makes the
 * oracle a permanent regression rather than a one-off diff script, and keeps zero
 * dead code in `src/`.
 *
 * Two layers:
 *   - **NW-04**, one hand-built book that exercises every rule of the contract
 *     (loans, closed accounts, unpriced holdings, half-cent ties, foreign
 *     currency, …). Each fixture is annotated with the rule it pins.
 *   - **NW-05**, randomized small books via `fast-check`, to sweep the
 *     combinations nobody thought to hand-write.
 *
 * These specs TRUNCATE shared tables, which is why `vitest.config.ts` pins
 * `pool: forks` / `singleFork` / `fileParallelism: false`.
 */

/** The pre-rewrite implementation, kept here (and only here) as the oracle. */
async function referenceSeries(baseCurrency = "USD"): Promise<NetWorthPoint[]> {
  const dates = await db
    .select({ date: accountSnapshots.date })
    .from(accountSnapshots)
    .groupBy(accountSnapshots.date)
    .orderBy(sql`${accountSnapshots.date} asc`);

  const points: NetWorthPoint[] = [];
  for (const { date } of dates) {
    const snap = await computeNetWorth(new Date(`${date}T00:00:00Z`), baseCurrency);
    points.push({ date, value: snap.total.toString() });
  }
  return points;
}

async function resetDomain(): Promise<void> {
  await db.execute(
    sql`TRUNCATE accounts, holdings, account_snapshots, liabilities, prices, plaid_items CASCADE`,
  );
}

type AccountType =
  | "depository"
  | "credit_card"
  | "investment"
  | "crypto_ira"
  | "loan"
  | "property"
  | "personal_asset";

type AssetClass = "equity" | "crypto" | "physical_metal" | "cash" | "property";

/** Insert an account and return its id. */
async function newAccount(values: {
  name: string;
  type: AccountType;
  currency?: string;
  closedAt?: Date;
  plaidItemId?: string;
}): Promise<string> {
  const [row] = await db
    .insert(accounts)
    .values({
      name: values.name,
      institution: "Test",
      type: values.type,
      currency: values.currency ?? "USD",
      closedAt: values.closedAt ?? null,
      plaidItemId: values.plaidItemId ?? null,
    })
    .returning({ id: accounts.id });
  if (!row) throw new Error(`seed failed: ${values.name}`);
  return row.id;
}

describe("netWorthSeries parity with the per-date computeNetWorth loop", () => {
  beforeEach(async () => {
    await resetDomain();
  });

  afterAll(async () => {
    await resetDomain();
  });

  it("matches the reference across a book that exercises every rule", async () => {
    // Six dates on the spine. `D3` is the interesting one: an account closes on
    // it, so it sits exactly on the UTC boundary the closed-account rule uses.
    const D = ["2026-01-01", "2026-02-01", "2026-03-01", "2026-04-01", "2026-05-01", "2026-06-01"];

    // ── R9: balance types, with gaps that force a carry-back ─────────────────
    const checking = await newAccount({ name: "Checking", type: "depository" });
    await db.insert(accountSnapshots).values([
      { accountId: checking, date: D[0] as string, balance: "1000.00" },
      { accountId: checking, date: D[2] as string, balance: "1750.25" },
      { accountId: checking, date: D[4] as string, balance: "2100.10" },
    ]);

    // Sign handling: a credit card is a negative balance.
    const card = await newAccount({ name: "Card", type: "credit_card" });
    await db.insert(accountSnapshots).values([
      { accountId: card, date: D[0] as string, balance: "-450.33" },
      { accountId: card, date: D[3] as string, balance: "-1204.99" },
    ]);

    // R9 for the valuation types.
    const home = await newAccount({ name: "Home", type: "property" });
    await db
      .insert(accountSnapshots)
      .values({ accountId: home, date: D[1] as string, balance: "412000.00" });
    const truck = await newAccount({ name: "Tacoma", type: "personal_asset" });
    await db
      .insert(accountSnapshots)
      .values({ accountId: truck, date: D[1] as string, balance: "28500.00" });

    // ── R4/R6/R7: live valuation from prices ─────────────────────────────────
    const brokerage = await newAccount({ name: "Brokerage", type: "investment" });
    await db.insert(holdings).values([
      // The half-cent tie: 0.5 × 100.01 = 50.005 → half-even 50.00, and NOT the
      // 50.01 a naive Postgres round() would produce (§4.1 of the plan).
      {
        accountId: brokerage,
        symbol: "TIE",
        quantity: "0.50000000",
        quantityUnit: "shares",
        assetClass: "equity",
      },
      // A second priced holding, so per-holding rounding and total rounding can
      // disagree if the SQL ever sums before rounding (§4.2).
      {
        accountId: brokerage,
        symbol: "ODD",
        quantity: "3.33300000",
        quantityUnit: "shares",
        assetClass: "equity",
      },
      // R5: cash asset-class → face value at FULL precision, never rounded per
      // holding. The 8dp tail is what catches a stray round() here.
      {
        accountId: brokerage,
        symbol: "CASH",
        quantity: "1234.56789012",
        quantityUnit: "usd",
        assetClass: "cash",
      },
      // R7: never priced on any date → contributes exactly 0, always.
      {
        accountId: brokerage,
        symbol: "NOPRICE",
        quantity: "10.00000000",
        quantityUnit: "shares",
        assetClass: "equity",
      },
    ]);
    // Prices start only at D[1] and stop at D[3]: before D[1] the holdings are
    // unpriced (R7 → 0 → R8 fall-through), and after D[3] the lookback must
    // reach back to D[3] rather than go blank.
    await db.insert(prices).values([
      { symbol: "TIE", date: D[1] as string, close: "100.01000000" },
      { symbol: "TIE", date: D[3] as string, close: "100.03000000" },
      { symbol: "ODD", date: D[1] as string, close: "17.77500000" },
      { symbol: "ODD", date: D[3] as string, close: "19.99900000" },
    ]);
    // A snapshot on the account too — R8 decides which one wins per date.
    await db.insert(accountSnapshots).values([
      { accountId: brokerage, date: D[0] as string, balance: "999.99" },
      { accountId: brokerage, date: D[2] as string, balance: "888.88" },
    ]);

    // R4 covers crypto_ira as well, and a physical_metal holding.
    const ira = await newAccount({ name: "Gold IRA", type: "crypto_ira" });
    await db.insert(holdings).values({
      accountId: ira,
      symbol: "XAU",
      quantity: "12.50000000",
      quantityUnit: "troy_oz",
      assetClass: "physical_metal",
    });
    await db.insert(prices).values([
      { symbol: "XAU", date: D[0] as string, close: "2401.55500000" },
      { symbol: "XAU", date: D[4] as string, close: "2555.12500000" },
    ]);

    // R8: holdings exist but no price ever → live total is 0 → the snapshot wins.
    const dormant = await newAccount({ name: "Dormant brokerage", type: "investment" });
    await db.insert(holdings).values({
      accountId: dormant,
      symbol: "GHOST",
      quantity: "5.00000000",
      quantityUnit: "shares",
      assetClass: "equity",
    });
    await db
      .insert(accountSnapshots)
      .values({ accountId: dormant, date: D[0] as string, balance: "7500.00" });

    // R8 again, via the other door: an investment account with NO holdings at
    // all, where the live CTE produces no row rather than a zero.
    const empty = await newAccount({ name: "Empty brokerage", type: "investment" });
    await db
      .insert(accountSnapshots)
      .values({ accountId: empty, date: D[1] as string, balance: "333.33" });

    // ── R2/R3: loans ─────────────────────────────────────────────────────────
    const mortgage = await newAccount({ name: "Mortgage", type: "loan" });
    await db.insert(liabilities).values({
      accountId: mortgage,
      name: "30yr fixed",
      principalAtOrigination: "375000.00",
      annualRate: "0.062500",
      termMonths: 360,
      startDate: "2024-07-01",
    });
    // R3: the nightly job writes snapshots for loan accounts. They must be
    // ignored — the amortization is the only source of truth.
    await db.insert(accountSnapshots).values([
      { accountId: mortgage, date: D[0] as string, balance: "-999999.99" },
      { accountId: mortgage, date: D[3] as string, balance: "-888888.88" },
    ]);

    // R2's other half: a loan with no liabilities row is SKIPPED, not zeroed.
    // (Indistinguishable in a total, but it must not throw or emit a line.)
    const orphanLoan = await newAccount({ name: "Unconfigured loan", type: "loan" });
    await db
      .insert(accountSnapshots)
      .values({ accountId: orphanLoan, date: D[0] as string, balance: "-42000.00" });

    // ── R1: closed mid-history, exactly on a spine date's UTC midnight ────────
    const closed = await newAccount({
      name: "Closed savings",
      type: "depository",
      closedAt: new Date(`${D[2]}T00:00:00Z`),
    });
    await db
      .insert(accountSnapshots)
      .values({ accountId: closed, date: D[0] as string, balance: "6000.00" });

    // ── R11: a non-base currency account is dropped from the total ───────────
    const euro = await newAccount({ name: "Euro account", type: "depository", currency: "EUR" });
    await db
      .insert(accountSnapshots)
      .values({ accountId: euro, date: D[0] as string, balance: "99999.00" });

    // ── R10: a Plaid-linked account with no snapshot gets an explicit 0.00
    // line in `items[]`. It cannot move a total — this pins that it doesn't.
    const [item] = await db
      .insert(plaidItems)
      .values({
        plaidItemId: "item-parity-test",
        institutionId: "ins_test",
        institutionName: "Test Bank",
        productsConsented: ["transactions"],
      })
      .returning({ id: plaidItems.id });
    if (!item) throw new Error("seed failed: plaid item");
    await newAccount({ name: "Freshly linked", type: "depository", plaidItemId: item.id });

    // A date on which nothing has any value yet: D[5] is covered by carry-backs,
    // so instead assert the empty-total path with an explicit early date.
    await db
      .insert(accountSnapshots)
      .values({ accountId: checking, date: D[5] as string, balance: "2222.22" });

    const actual = await netWorthSeries();
    const expected = await referenceSeries();

    expect(actual).toEqual(expected);
    // Guard the guard: a reference that silently returned [] would make the
    // deep-equal vacuous.
    expect(expected).toHaveLength(6);
    expect(actual.map((p) => p.date)).toEqual(D);
    for (const point of actual) {
      expect(typeof point.value).toBe("string");
      expect(point.value).toMatch(/^-?\d+\.\d{2}$/);
    }
  });

  it("keeps cash/property holdings at unrounded face value", async () => {
    // Isolated on purpose. Rounding is idempotent under adding exact-cent
    // values, so a *single* over-precise holding can never reveal a stray
    // round() — round₂(q) and round₂(round₂(q)) always agree. It takes two
    // holdings whose tails sum across a cent boundary:
    //
    //   face value, as the contract requires:  100.006 + 100.006 = 200.012 → 200.01
    //   rounded per holding (the bug):           100.01 +   100.01 = 200.02  → 200.02
    //
    // The big fixture above cannot make this call, because the loan's
    // amortization contributes its own sub-cent tail and can mask the gap.
    const brokerage = await newAccount({ name: "Cash sleeve", type: "investment" });
    await db.insert(holdings).values([
      {
        accountId: brokerage,
        symbol: "CASH-A",
        quantity: "100.00600000",
        quantityUnit: "usd",
        assetClass: "cash",
      },
      {
        accountId: brokerage,
        symbol: "CASH-B",
        quantity: "100.00600000",
        quantityUnit: "usd",
        assetClass: "cash",
      },
    ]);
    await db
      .insert(accountSnapshots)
      .values({ accountId: brokerage, date: "2026-01-01", balance: "0.00" });

    const actual = await netWorthSeries();
    expect(actual).toEqual(await referenceSeries());
    expect(actual).toEqual([{ date: "2026-01-01", value: "200.01" }]);
  });

  it("emits 0.00 — not a missing point — on a date where nothing has value yet", async () => {
    // The only snapshot on the first date belongs to an account that is already
    // closed by then, so every contribution is absent and the SUM is over zero
    // rows. `Money.sum([])` is "0.00"; a bare SUM would be NULL.
    const closed = await newAccount({
      name: "Closed",
      type: "depository",
      closedAt: new Date("2025-12-31T00:00:00Z"),
    });
    const open = await newAccount({ name: "Open", type: "depository" });
    await db.insert(accountSnapshots).values([
      { accountId: closed, date: "2026-01-01", balance: "500.00" },
      { accountId: open, date: "2026-02-01", balance: "125.00" },
    ]);

    const actual = await netWorthSeries();
    expect(actual).toEqual(await referenceSeries());
    expect(actual).toEqual([
      { date: "2026-01-01", value: "0.00" },
      { date: "2026-02-01", value: "125.00" },
    ]);
  });

  it("matches the reference when there are no accounts or no snapshots at all", async () => {
    expect(await netWorthSeries()).toEqual([]);
    expect(await netWorthSeries()).toEqual(await referenceSeries());

    await newAccount({ name: "No snapshots", type: "depository" });
    expect(await netWorthSeries()).toEqual([]);
    expect(await netWorthSeries()).toEqual(await referenceSeries());
  });
});

// ── NW-05: the combinations nobody hand-wrote ────────────────────────────────

/** The date axis every generated book draws from. */
const DATES = [
  "2026-01-01",
  "2026-02-01",
  "2026-03-01",
  "2026-04-01",
  "2026-05-01",
  "2026-06-01",
] as const;

/** A small shared symbol pool, so price coverage is partial by construction. */
const SYMBOLS = ["AAA", "BBB", "CCC"] as const;

/**
 * Values chosen so half-cent ties are *likely*, not incidental. Random floats
 * essentially never produce a tie, and a tie is precisely the case the rewrite
 * can get wrong (Postgres `round()` is half-away-from-zero; decimal.js is
 * half-even). Three of the seven quantities tie against two of the seven closes
 * — e.g. `0.5 × 100.01 = 50.005`, `12.5 × 0.01 = 0.125` — so a book with a
 * couple of priced holdings hits one often.
 */
const QUANTITIES = [
  "0.50000000",
  "0.25000000",
  "1.50000000",
  "3.33300000",
  "100.00600000",
  "0.00500000",
  "12.50000000",
] as const;
const CLOSES = [
  "100.01000000",
  "0.01000000",
  "17.77500000",
  "0.00500000",
  "2401.55500000",
  "33.33300000",
  "1.00000000",
] as const;
const BALANCES = ["1000.00", "-450.33", "0.00", "999999.99", "-1204.99", "0.01"] as const;

const UNIT_FOR: Record<AssetClass, "shares" | "coin" | "troy_oz" | "usd"> = {
  equity: "shares",
  crypto: "coin",
  physical_metal: "troy_oz",
  cash: "usd",
  property: "usd",
};

interface GeneratedAccount {
  readonly type: AccountType;
  readonly currency: string;
  readonly closedOn: string | null;
  readonly snapshots: ReadonlyArray<{ readonly date: string; readonly balance: string }>;
  readonly holdings: ReadonlyArray<{
    readonly symbol: string;
    readonly quantity: string;
    readonly assetClass: AssetClass;
  }>;
  readonly hasLiability: boolean;
}

interface GeneratedBook {
  readonly accounts: readonly GeneratedAccount[];
  readonly prices: ReadonlyArray<{
    readonly symbol: string;
    readonly date: string;
    readonly close: string;
  }>;
}

/**
 * Repeated entries are deliberate weighting. A uniform draw over seven account
 * types, five asset classes and a sparse price table almost never assembles the
 * interesting shape — a live-valued account holding a priced position — so the
 * generator leans toward `investment`/`crypto_ira` and toward priced asset
 * classes. Verified by mutation: with a flat distribution, swapping the
 * half-even fragment for a plain `round()` slipped through 25 runs untouched.
 */
const accountArb: fc.Arbitrary<GeneratedAccount> = fc.record({
  type: fc.constantFrom<AccountType>(
    "investment",
    "investment",
    "crypto_ira",
    "depository",
    "credit_card",
    "loan",
    "property",
    "personal_asset",
  ),
  // EUR exercises the "excluded from the total" rule without needing fx_rates.
  currency: fc.constantFrom("USD", "USD", "USD", "EUR"),
  closedOn: fc.constantFrom<string | null>(null, null, null, ...DATES),
  snapshots: fc.array(
    fc.record({
      date: fc.constantFrom(...DATES),
      balance: fc.constantFrom(...BALANCES),
    }),
    { maxLength: 4 },
  ),
  holdings: fc.array(
    fc.record({
      symbol: fc.constantFrom(...SYMBOLS),
      quantity: fc.constantFrom(...QUANTITIES),
      assetClass: fc.constantFrom<AssetClass>(
        "equity",
        "equity",
        "crypto",
        "physical_metal",
        "cash",
        "property",
      ),
    }),
    { minLength: 1, maxLength: 3 },
  ),
  hasLiability: fc.boolean(),
});

const bookArb: fc.Arbitrary<GeneratedBook> = fc.record({
  accounts: fc.array(accountArb, { minLength: 0, maxLength: 4 }),
  // A price on the first date for every symbol, so most holdings are actually
  // valued, plus a random scattering that leaves coverage genuinely partial
  // (later dates reach back; unpriced symbols still exercise the zero rule).
  prices: fc
    .array(
      fc.record({
        symbol: fc.constantFrom(...SYMBOLS),
        date: fc.constantFrom(...DATES),
        close: fc.constantFrom(...CLOSES),
      }),
      { maxLength: 8 },
    )
    .chain((scattered) =>
      fc
        .array(fc.constantFrom(...CLOSES), { minLength: SYMBOLS.length, maxLength: SYMBOLS.length })
        .map((baseline) => [
          ...SYMBOLS.map((symbol, i) => ({
            symbol,
            date: DATES[0],
            close: baseline[i] as string,
          })),
          ...scattered,
        ]),
    ),
});

/**
 * Materialize a generated book, discarding rows the schema's uniqueness rules
 * would reject — `(account_id, symbol)` on holdings, `(account_id, date)` on
 * snapshots, `(symbol, date)` on prices. Dropping duplicates keeps the generator
 * free to emit them (which is where the interesting collisions come from)
 * without turning every collision into a spurious failure.
 */
async function seedBook(book: GeneratedBook): Promise<void> {
  const seenPrice = new Set<string>();
  const priceRows = book.prices.filter((p) => {
    const key = `${p.symbol}|${p.date}`;
    if (seenPrice.has(key)) return false;
    seenPrice.add(key);
    return true;
  });
  if (priceRows.length > 0) await db.insert(prices).values([...priceRows]);

  for (const [i, account] of book.accounts.entries()) {
    const id = await newAccount({
      name: `Account ${i}`,
      type: account.type,
      currency: account.currency,
      ...(account.closedOn ? { closedAt: new Date(`${account.closedOn}T00:00:00Z`) } : {}),
    });

    const seenSymbol = new Set<string>();
    const holdingRows = account.holdings.filter((h) => {
      if (seenSymbol.has(h.symbol)) return false;
      seenSymbol.add(h.symbol);
      return true;
    });
    if (holdingRows.length > 0) {
      await db.insert(holdings).values(
        holdingRows.map((h) => ({
          accountId: id,
          symbol: h.symbol,
          quantity: h.quantity,
          quantityUnit: UNIT_FOR[h.assetClass],
          assetClass: h.assetClass,
        })),
      );
    }

    const seenDate = new Set<string>();
    const snapshotRows = account.snapshots.filter((s) => {
      if (seenDate.has(s.date)) return false;
      seenDate.add(s.date);
      return true;
    });
    if (snapshotRows.length > 0) {
      await db
        .insert(accountSnapshots)
        .values(snapshotRows.map((s) => ({ accountId: id, date: s.date, balance: s.balance })));
    }

    if (account.type === "loan" && account.hasLiability) {
      await db.insert(liabilities).values({
        accountId: id,
        name: `Loan ${i}`,
        principalAtOrigination: "375000.00",
        annualRate: "0.062500",
        termMonths: 360,
        startDate: "2024-07-01",
      });
    }
  }
}

describe("netWorthSeries parity — property-based", () => {
  beforeEach(async () => {
    await resetDomain();
  });

  afterAll(async () => {
    await resetDomain();
  });

  it("matches the reference on randomly generated small books", async () => {
    await fc.assert(
      fc.asyncProperty(bookArb, async (book) => {
        await resetDomain();
        await seedBook(book);
        expect(await netWorthSeries()).toEqual(await referenceSeries());
      }),
      // 40 runs keeps the reference implementation's per-date query loop cheap
      // while still sweeping type/price/closure combinations the hand-written
      // fixture fixes in place. fast-check prints a reproducible seed on failure.
      { numRuns: 40 },
    );
    // Each run truncates, re-seeds, and pays for the reference's per-date query
    // loop, so the whole property runs well past Vitest's 5 s default.
  }, 60_000);

  it("windowing a random book is exactly filtering the full series", async () => {
    await fc.assert(
      fc.asyncProperty(bookArb, fc.constantFrom(...DATES), async (book, from) => {
        await resetDomain();
        await seedBook(book);
        const full = await netWorthSeries();
        expect(await netWorthSeries("USD", { from })).toEqual(full.filter((p) => p.date >= from));
      }),
      { numRuns: 15 },
    );
  }, 60_000);
});
