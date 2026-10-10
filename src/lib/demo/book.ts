import { Money } from "@/lib/money/money.ts";
import { balanceAtMonth, monthlyPayment } from "@/lib/mortgage/amortization.ts";
import Decimal from "decimal.js";

/**
 * PLAN19 P19-32 — the synthetic household `make seed-demo` writes.
 *
 * Pure: it takes a date and returns rows. Nothing here touches the database,
 * which is what lets the safety properties live in one small writer
 * ([seed.ts](./seed.ts)) and the book's internal consistency be tested without
 * one.
 *
 * **Everything is fictional.** No institution, merchant or ticker in this file
 * is real: the institutions are "Demo Bank"-style placeholders, the merchants
 * are invented, and the two tickers (`DEMOSTOCK`, `DEMOBOND`) are longer than
 * any US listing can be, so the nightly price fetch can never resolve them to a
 * real security. It logs one failure per symbol per night and the demo keeps
 * its last seeded price.
 *
 * **Deterministic.** A fixed-seed PRNG drives every amount, so the same `today`
 * always yields the same book. P19-31's parity run depends on that: it seeds
 * one database and reads it with two versions of the code.
 *
 * Money stays in strings and `Money` throughout (CLAUDE.md §Money). The PRNG
 * produces whole cents as integers, which are formatted once into a decimal
 * string and never added as numbers.
 */

/** The accounts the demo book holds, by a stable key the writer maps to ids. */
export type DemoAccountKey = "checking" | "savings" | "card" | "brokerage" | "mortgage" | "home";

/** A default category name the demo book files transactions under. */
export type DemoCategoryName =
  | "Income"
  | "Mortgage"
  | "Groceries"
  | "Coffee"
  | "Restaurant"
  | "Gas"
  | "Utilities"
  | "Shopping"
  | "Subscriptions"
  | "Interest"
  | "Transfer"
  | "Payment"
  | "Credit Card Payment"
  | "Transport";

export interface DemoAccount {
  readonly key: DemoAccountKey;
  readonly name: string;
  readonly institution: string;
  readonly type: "depository" | "credit_card" | "investment" | "loan" | "property";
  readonly subtype?: "checking" | "savings";
  readonly apy?: string;
  readonly taxTreatment?: "taxable";
  readonly acquiredAt?: string;
  readonly acquisitionCost?: string;
}

export interface DemoTransaction {
  readonly account: DemoAccountKey;
  readonly postedAt: string;
  readonly amount: string;
  readonly name: string;
  readonly category: DemoCategoryName;
  readonly fitid: string;
}

export interface DemoSnapshot {
  readonly account: DemoAccountKey;
  readonly date: string;
  readonly balance: string;
}

export interface DemoHolding {
  readonly symbol: string;
  readonly securityName: string;
  readonly quantity: string;
  readonly costBasis: string;
}

export interface DemoPrice {
  readonly symbol: string;
  readonly date: string;
  readonly close: string;
}

export interface DemoHoldingSnapshot {
  readonly symbol: string;
  readonly date: string;
  readonly value: string;
}

export interface DemoBook {
  readonly from: string;
  readonly today: string;
  readonly accounts: readonly DemoAccount[];
  readonly transactions: readonly DemoTransaction[];
  readonly snapshots: readonly DemoSnapshot[];
  readonly holdings: readonly DemoHolding[];
  readonly prices: readonly DemoPrice[];
  readonly holdingSnapshots: readonly DemoHoldingSnapshot[];
  readonly mortgage: {
    readonly name: string;
    readonly principal: string;
    readonly annualRate: string;
    readonly termMonths: number;
    readonly startDate: string;
  };
  readonly plannedExpense: {
    readonly label: string;
    readonly amount: string;
    readonly dueDate: string;
    readonly accrualStartDate: string;
    readonly category: DemoCategoryName;
  };
  readonly recurringBill: {
    readonly label: string;
    readonly amount: string;
    readonly anchorDate: string;
    readonly startDate: string;
    readonly category: DemoCategoryName;
  };
  readonly budgets: ReadonlyArray<{ readonly category: DemoCategoryName; readonly amount: string }>;
}

const USD = "USD";
const SEED = 0x19_32_2026;

export const DEMO_ACCOUNTS: readonly DemoAccount[] = [
  {
    key: "checking",
    name: "Everyday Checking",
    institution: "Demo Bank",
    type: "depository",
    subtype: "checking",
  },
  {
    key: "savings",
    name: "Rainy Day Savings",
    institution: "Demo Bank",
    type: "depository",
    subtype: "savings",
    apy: "4.0000",
  },
  { key: "card", name: "Rewards Card", institution: "Example Card Co.", type: "credit_card" },
  {
    key: "brokerage",
    name: "Sample Brokerage",
    institution: "Sample Investments",
    type: "investment",
    taxTreatment: "taxable",
  },
  { key: "mortgage", name: "Home Mortgage", institution: "Example Home Loans", type: "loan" },
  { key: "home", name: "Home", institution: "Owner estimate", type: "property" },
];

const OPENING = { checking: "3200.00", savings: "12000.00", cardOwed: "850.00" } as const;
const PAYCHECK = "2850.00";
const SAVINGS_TRANSFER = "800.00";
const INTERNET = "65.00";
const STREAMING = "15.99";

export const DEMO_HOLDINGS: readonly DemoHolding[] = [
  {
    symbol: "DEMOSTOCK",
    securityName: "Demo Total Market Fund",
    quantity: "120",
    costBasis: "18000.00",
  },
  { symbol: "DEMOBOND", securityName: "Demo Bond Fund", quantity: "200", costBasis: "19500.00" },
];

/**
 * Mulberry32 — a 32-bit PRNG small enough to inline and good enough for
 * plausible grocery bills. Not for anything that needs to be unpredictable.
 *
 * @param seed - The starting state.
 * @returns A function yielding floats in [0, 1).
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Whole cents in `[minCents, maxCents]`, formatted as a decimal string. */
function cents(rand: () => number, minCents: number, maxCents: number): string {
  const c = minCents + Math.floor(rand() * (maxCents - minCents + 1));
  return `${Math.floor(c / 100)}.${String(c % 100).padStart(2, "0")}`;
}

function parseDay(iso: string): Date {
  return new Date(`${iso}T00:00:00Z`);
}

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Shift a date by whole days, in UTC.
 *
 * @param iso - `YYYY-MM-DD`.
 * @param days - Days to add (negative to subtract).
 * @returns The shifted `YYYY-MM-DD`.
 */
export function addDays(iso: string, days: number): string {
  const d = parseDay(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return isoDay(d);
}

/** Shift by whole months, clamped to the target month's last day. */
function addMonths(iso: string, months: number): string {
  const d = parseDay(iso);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return isoDay(d);
}

function dayOfMonth(iso: string): number {
  return Number(iso.slice(8, 10));
}

function isMonthEnd(iso: string): boolean {
  return addDays(iso, 1).slice(8, 10) === "01";
}

function wholeMonthsBetween(fromIso: string, toIso: string): number {
  const months =
    (Number(toIso.slice(0, 4)) - Number(fromIso.slice(0, 4))) * 12 +
    (Number(toIso.slice(5, 7)) - Number(fromIso.slice(5, 7)));
  return Math.max(0, months);
}

/** Every `YYYY-MM-DD` from `from` to `to`, inclusive. */
function daysInclusive(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

/**
 * Accumulates transactions and keeps each cash-like account's running balance,
 * so a day's snapshot is exactly the opening balance plus every transaction
 * posted on or before it — the property the reconciliation test asserts.
 */
class Ledger {
  readonly transactions: DemoTransaction[] = [];
  readonly balances = new Map<DemoAccountKey, Money>();
  private seq = 0;

  constructor(opening: ReadonlyArray<readonly [DemoAccountKey, string]>) {
    for (const [key, amount] of opening) this.balances.set(key, Money.fromString(amount, USD));
  }

  post(
    account: DemoAccountKey,
    postedAt: string,
    amount: string,
    name: string,
    category: DemoCategoryName,
  ): void {
    this.seq += 1;
    this.transactions.push({
      account,
      postedAt,
      amount,
      name,
      category,
      fitid: `demo-${account}-${String(this.seq).padStart(5, "0")}`,
    });
    const prior = this.balances.get(account) ?? Money.zero(USD);
    this.balances.set(account, prior.add(Money.fromString(amount, USD)));
  }

  balance(account: DemoAccountKey): Money {
    return this.balances.get(account) ?? Money.zero(USD);
  }
}

/** The day's card purchases: groceries weekly, the rest at plausible rates. */
function cardSpending(ledger: Ledger, day: string, rand: () => number): void {
  const weekday = parseDay(day).getUTCDay();
  const spend = (name: string, category: DemoCategoryName, lo: number, hi: number): void => {
    ledger.post("card", day, `-${cents(rand, lo, hi)}`, name, category);
  };
  if (weekday === 6) spend("GREENLEAF GROCERY", "Groceries", 9_000, 18_000);
  if (weekday === 3 && rand() < 0.5) spend("GREENLEAF GROCERY", "Groceries", 1_500, 4_500);
  if (rand() < 0.08) spend("CORNER BISTRO", "Restaurant", 2_500, 8_000);
  if (rand() < 0.07) spend("QUICKFUEL STATION", "Gas", 3_500, 5_500);
  if (rand() < 0.12) spend("BEAN THERE COFFEE", "Coffee", 450, 900);
  if (rand() < 0.05) spend("MAIN ST GOODS", "Shopping", 2_000, 15_000);
  if (dayOfMonth(day) === 9)
    ledger.post("card", day, `-${STREAMING}`, "STREAMFLIX", "Subscriptions");
}

/**
 * Build the demo household for the year ending `today`.
 *
 * @param today - The last day of the book, `YYYY-MM-DD`. The book covers the
 *   365 days ending here, so a demo seeded today has a full year of history.
 * @returns Every row the writer inserts, keyed by account rather than by id.
 */
export function buildDemoBook(today: string): DemoBook {
  const rand = mulberry32(SEED);
  const from = addDays(today, -364);
  const days = daysInclusive(from, today);

  const mortgage = {
    name: "Home mortgage",
    principal: "320000.00",
    annualRate: "0.062500",
    termMonths: 360,
    startDate: `${addMonths(from, -42).slice(0, 7)}-01`,
  };
  const mortgagePayment = monthlyPayment(
    Money.fromString(mortgage.principal, USD),
    mortgage.annualRate,
    mortgage.termMonths,
  ).toString();

  const ledger = new Ledger([
    ["checking", OPENING.checking],
    ["savings", OPENING.savings],
    ["card", Money.fromString(OPENING.cardOwed, USD).negate().toString()],
  ]);
  const snapshots: DemoSnapshot[] = [];
  const prices: DemoPrice[] = [];
  const holdingSnapshots: DemoHoldingSnapshot[] = [];

  let statementOwed = Money.fromString(OPENING.cardOwed, USD);
  const close = new Map<string, Decimal>([
    ["DEMOSTOCK", new Decimal("182.40")],
    ["DEMOBOND", new Decimal("96.15")],
  ]);
  const drift = new Map<string, readonly [number, number]>([
    ["DEMOSTOCK", [-0.014, 0.0155]],
    ["DEMOBOND", [-0.003, 0.0034]],
  ]);
  const homeValue = new Decimal("395000.00");

  for (const day of days) {
    const dom = dayOfMonth(day);
    if (dom === 1) statementOwed = ledger.balance("card").negate();

    if (dom === 1) {
      ledger.post("checking", day, PAYCHECK, "DEMO EMPLOYER PAYROLL", "Income");
      ledger.post("checking", day, `-${mortgagePayment}`, "EXAMPLE HOME LOANS PAYMENT", "Mortgage");
    }
    if (dom === 15) ledger.post("checking", day, PAYCHECK, "DEMO EMPLOYER PAYROLL", "Income");
    if (dom === 5 && !statementOwed.isZero() && !statementOwed.isNegative()) {
      const amount = statementOwed.toString();
      ledger.post("checking", day, `-${amount}`, "REWARDS CARD AUTOPAY", "Credit Card Payment");
      ledger.post("card", day, amount, "AUTOPAY THANK YOU", "Payment");
      statementOwed = Money.zero(USD);
    }
    if (dom === 12) ledger.post("checking", day, `-${INTERNET}`, "HOMETOWN INTERNET", "Utilities");
    if (dom === 16) {
      ledger.post("checking", day, `-${SAVINGS_TRANSFER}`, "TRANSFER TO SAVINGS", "Transfer");
      ledger.post("savings", day, SAVINGS_TRANSFER, "TRANSFER FROM CHECKING", "Transfer");
    }
    if (dom === 20) {
      ledger.post(
        "checking",
        day,
        `-${cents(rand, 8_500, 17_500)}`,
        "CITY POWER AND WATER",
        "Utilities",
      );
    }
    cardSpending(ledger, day, rand);
    if (isMonthEnd(day)) {
      const interest = ledger.balance("savings").mul("0.04").div(12).toString();
      ledger.post("savings", day, interest, "INTEREST PAID", "Interest");
    }

    for (const key of ["checking", "savings", "card"] as const) {
      snapshots.push({ account: key, date: day, balance: ledger.balance(key).toString() });
    }

    // Prices walk once per day; the brokerage is valued at the day's closes.
    let brokerage = Money.zero(USD);
    for (const holding of DEMO_HOLDINGS) {
      const [lo, hi] = drift.get(holding.symbol) ?? [0, 0];
      const prior = close.get(holding.symbol) ?? new Decimal(1);
      const next = prior.times(new Decimal(1).plus(lo + rand() * (hi - lo))).toDecimalPlaces(2);
      close.set(holding.symbol, next);
      prices.push({ symbol: holding.symbol, date: day, close: next.toFixed(2) });
      const value = Money.fromString(next.toFixed(2), USD).mul(holding.quantity).toString();
      holdingSnapshots.push({ symbol: holding.symbol, date: day, value });
      brokerage = brokerage.add(Money.fromString(value, USD));
    }
    snapshots.push({ account: "brokerage", date: day, balance: brokerage.toString() });

    // The loan row mirrors what the nightly job writes; net worth itself
    // reads the amortization, never this row (compute.ts).
    const remaining = balanceAtMonth(
      Money.fromString(mortgage.principal, USD),
      mortgage.annualRate,
      mortgage.termMonths,
      wholeMonthsBetween(mortgage.startDate, day),
    );
    snapshots.push({ account: "mortgage", date: day, balance: remaining.negate().toString() });

    // A home is revalued by hand, so it gets a row once a month, not daily.
    if (day === from || dom === 1) {
      const months = wholeMonthsBetween(from, day);
      const value = homeValue.times(new Decimal("1.0025").pow(months)).toNearest(100);
      snapshots.push({ account: "home", date: day, balance: value.toFixed(2) });
    }
  }

  const accounts = DEMO_ACCOUNTS.map((a) =>
    a.key === "home" ? { ...a, acquiredAt: mortgage.startDate, acquisitionCost: "360000.00" } : a,
  );

  return {
    from,
    today,
    accounts,
    transactions: ledger.transactions,
    snapshots,
    holdings: DEMO_HOLDINGS,
    prices,
    holdingSnapshots,
    mortgage,
    plannedExpense: {
      label: "Car registration and new tires",
      amount: "1200.00",
      dueDate: addMonths(today, 5),
      accrualStartDate: addMonths(today, -1),
      category: "Transport",
    },
    recurringBill: {
      label: "Internet",
      amount: INTERNET,
      anchorDate:
        dayOfMonth(from) <= 12 ? `${from.slice(0, 7)}-12` : `${addMonths(from, 1).slice(0, 7)}-12`,
      startDate: from,
      category: "Utilities",
    },
    budgets: [
      { category: "Groceries", amount: "650.00" },
      { category: "Restaurant", amount: "150.00" },
    ],
  };
}

/**
 * The opening balance of a cash-like account — what its first snapshot reads
 * before that day's transactions. Exposed for the reconciliation test.
 *
 * @param key - A cash-like account.
 * @returns The opening balance as stored (net-worth sign).
 */
export function demoOpeningBalance(key: "checking" | "savings" | "card"): string {
  if (key === "card") return Money.fromString(OPENING.cardOwed, USD).negate().toString();
  return OPENING[key];
}
