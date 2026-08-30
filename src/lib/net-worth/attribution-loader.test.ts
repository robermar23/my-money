// @vitest-environment node
import { db } from "@/db/client.ts";
import {
  accountSnapshots,
  accounts,
  categories,
  holdingSnapshots,
  holdings,
  investmentTransactions,
  liabilities,
  transactions,
} from "@/db/schema/index.ts";
import { Money } from "@/lib/money/money.ts";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { loadAttribution } from "./attribution-loader.ts";
import { computeNetWorth } from "./compute.ts";
import type { AttributionResult, AttributionRungId, ResidualDiagnosticCode } from "./types.ts";

/**
 * P17-19 — the attribution assembly, against the real database.
 *
 * The pure engine has its own suites and its own identity invariant; what only
 * this layer can be wrong about is **which rows it feeds them**. Every case
 * below is a loader decision that, reversed, produces a page that is wrong
 * without being broken — the residual absorbs the mistake and the identity
 * still reconciles perfectly.
 *
 *   1. **The endpoints are the dashboard's own numbers** (ADR-039 §1). The one
 *      rule the whole phase rests on, asserted against `computeNetWorth`
 *      directly rather than against a hand-written figure.
 *   2. **`categories.kind` is joined.** Without it every categorized flow reads
 *      as uncategorized, `saved` collapses to zero, and the residual swallows a
 *      household's entire year of saving.
 *   3. **Payroll-direct contributions are exempt** (ADR-041 §3). A correctly
 *      recorded 401(k) contribution must not be reported as a data problem.
 *   4. **An untracked loan is named, not zeroed.** `computeNetWorth` skips it at
 *      both endpoints, so it is invisible in the anchor; the diagnostic is the
 *      only thing that says so.
 *   5. **The window is the caller's.** Rows outside it must not reach a rung.
 */

const FROM = "2026-01-01";
const TO = "2026-03-31";

async function reset(): Promise<void> {
  await db.execute(
    sql`TRUNCATE holding_snapshots, holdings, investment_transactions, liabilities, account_snapshots, transactions, categories, accounts CASCADE`,
  );
}

beforeEach(reset);

async function seedAccount(
  name: string,
  type: string,
  balances: Readonly<Record<string, string>> = {},
): Promise<string> {
  const [account] = await db
    .insert(accounts)
    .values({
      name,
      institution: "Test Bank",
      type: type as "depository",
      currency: "USD",
    })
    .returning({ id: accounts.id });
  if (!account) throw new Error("seed account failed");
  const rows = Object.entries(balances).map(([date, balance]) => ({
    accountId: account.id,
    date,
    balance,
  }));
  if (rows.length > 0) await db.insert(accountSnapshots).values(rows);
  return account.id;
}

async function seedCategory(name: string, kind: string): Promise<string> {
  const [category] = await db
    .insert(categories)
    .values({ name, kind })
    .returning({ id: categories.id });
  if (!category) throw new Error("seed category failed");
  return category.id;
}

function rung(result: AttributionResult, id: AttributionRungId): string {
  const found = result.rungs.find((r) => r.id === id);
  if (found === undefined) throw new Error(`no rung ${id}`);
  return found.amount;
}

function codes(result: AttributionResult): ResidualDiagnosticCode[] {
  return result.diagnostics.map((d) => d.code);
}

describe("the endpoints are the dashboard's own numbers (ADR-039 §1)", () => {
  it("copies both totals verbatim from computeNetWorth", async () => {
    await seedAccount("Checking", "depository", { [FROM]: "5000.00", [TO]: "8000.00" });
    await seedAccount("Brokerage", "investment", { [FROM]: "40000.00", [TO]: "52000.00" });

    const opening = await computeNetWorth(new Date(`${FROM}T00:00:00Z`));
    const closing = await computeNetWorth(new Date(`${TO}T00:00:00Z`));
    const result = await loadAttribution({ from: FROM, to: TO });

    // Not "approximately", and not re-summed from items: the same strings. If
    // this page and the net-worth chart could ever disagree, the household has
    // no way to tell which one to believe.
    expect(result.opening).toBe(opening.total.toString());
    expect(result.closing).toBe(closing.total.toString());
    expect(result.delta).toBe(closing.total.sub(opening.total).toString());
  });

  it("does not re-sum the items, which is deliberately not the total", async () => {
    await seedAccount("Checking", "depository", { [FROM]: "5000.00", [TO]: "8000.00" });
    // computeNetWorth lists a foreign-currency account in `items` but excludes
    // it from `total` (compute.ts, the Money.sum currency filter). Re-deriving
    // the total here would therefore produce a SECOND valuation that disagrees
    // with the dashboard — the one thing ADR-039 §1 forbids.
    const [eur] = await db
      .insert(accounts)
      .values({
        name: "Euro savings",
        institution: "Test Bank",
        type: "depository",
        currency: "EUR",
      })
      .returning({ id: accounts.id });
    if (!eur) throw new Error("seed account failed");
    await db.insert(accountSnapshots).values([
      { accountId: eur.id, date: FROM, balance: "9000.00" },
      { accountId: eur.id, date: TO, balance: "9000.00" },
    ]);

    const opening = await computeNetWorth(new Date(`${FROM}T00:00:00Z`));
    const result = await loadAttribution({ from: FROM, to: TO });

    expect(result.opening).toBe(opening.total.toString());
    expect(result.opening).toBe("5000.00");
  });

  it("closes the identity against those endpoints exactly", async () => {
    await seedAccount("Checking", "depository", { [FROM]: "5000.00", [TO]: "8000.00" });
    const result = await loadAttribution({ from: FROM, to: TO });

    const reconstructed = Money.sum(
      [
        Money.fromString(result.opening, "USD"),
        ...result.rungs.map((r) => Money.fromString(r.amount, "USD")),
      ],
      "USD",
    );
    expect(reconstructed.toString()).toBe(result.closing);
  });
});

describe("categories.kind is joined by the loader (ADR-040 §6)", () => {
  it("counts categorized income and expense into the saved rung", async () => {
    const checking = await seedAccount("Checking", "depository", {
      [FROM]: "5000.00",
      [TO]: "8000.00",
    });
    const income = await seedCategory("Salary", "income");
    const expense = await seedCategory("Groceries", "expense");

    await db.insert(transactions).values([
      {
        accountId: checking,
        postedAt: "2026-02-01",
        amount: "4000.00",
        name: "ACME PAYROLL",
        fitid: "pay-1",
        categoryId: income,
        source: "manual",
      },
      {
        accountId: checking,
        postedAt: "2026-02-05",
        amount: "-1000.00",
        name: "GROCERY MART",
        fitid: "food-1",
        categoryId: expense,
        source: "manual",
      },
    ]);

    const result = await loadAttribution({ from: FROM, to: TO });
    expect(rung(result, "saved")).toBe("3000.00");
    // …and nothing was reported as uncategorized, because the join worked.
    expect(codes(result)).not.toContain("uncategorized");
  });

  it("reports an uncategorized row as uncategorized rather than guessing", async () => {
    const checking = await seedAccount("Checking", "depository", {
      [FROM]: "5000.00",
      [TO]: "8000.00",
    });
    await db.insert(transactions).values({
      accountId: checking,
      postedAt: "2026-02-01",
      amount: "-1200.00",
      name: "UNKNOWN MERCHANT",
      fitid: "mystery-1",
      categoryId: null,
      source: "manual",
    });

    const result = await loadAttribution({ from: FROM, to: TO });
    expect(codes(result)).toContain("uncategorized");
  });
});

describe("the window belongs to the caller", () => {
  it("ignores a transaction posted after the window closes", async () => {
    const checking = await seedAccount("Checking", "depository", {
      [FROM]: "5000.00",
      [TO]: "8000.00",
    });
    const income = await seedCategory("Salary", "income");
    await db.insert(transactions).values({
      accountId: checking,
      postedAt: "2026-04-15",
      amount: "4000.00",
      name: "ACME PAYROLL",
      fitid: "pay-late",
      categoryId: income,
      source: "manual",
    });

    const result = await loadAttribution({ from: FROM, to: TO });
    expect(rung(result, "saved")).toBe("0.00");
  });
});

describe("payroll-direct contributions (ADR-041 §3)", () => {
  it("counts them as a retirement rung and does not flag them as unmatched", async () => {
    const brokerage = await seedAccount("401(k)", "investment", {
      [FROM]: "40000.00",
      [TO]: "52000.00",
    });
    await db.insert(investmentTransactions).values({
      accountId: brokerage,
      type: "buy",
      subtype: "contribution",
      tradeDate: "2026-02-15",
      amount: "1000.00",
      source: "income",
    });

    const result = await loadAttribution({ from: FROM, to: TO });
    expect(rung(result, "retirement")).toBe("1000.00");
    // The market rung subtracts the same flow, so the two cancel by
    // construction: the account rose 12,000 of which 1,000 was contributed.
    expect(rung(result, "investment_return")).toBe("11000.00");
    expect(codes(result)).not.toContain("unmatched_investment_deposits");
  });
});

describe("an untracked loan", () => {
  it("is named as a residual cause rather than silently zeroed", async () => {
    await seedAccount("Checking", "depository", { [FROM]: "5000.00", [TO]: "8000.00" });
    // A loan account with NO liabilities row. computeNetWorth skips it entirely
    // at both endpoints, so it is absent from the anchor — and the only thing
    // that can say so is the diagnostic.
    await seedAccount("Mortgage", "loan");

    const result = await loadAttribution({ from: FROM, to: TO });
    expect(rung(result, "debt_principal")).toBe("0.00");
    expect(codes(result)).toContain("untracked_loan");
  });

  it("produces a principal rung once the terms are recorded", async () => {
    await seedAccount("Checking", "depository", { [FROM]: "5000.00", [TO]: "8000.00" });
    const loan = await seedAccount("Mortgage", "loan");
    await db.insert(liabilities).values({
      accountId: loan,
      name: "Mortgage",
      principalAtOrigination: "300000.00",
      annualRate: "0.065",
      termMonths: 360,
      startDate: "2024-01-01",
    });

    const result = await loadAttribution({ from: FROM, to: TO });
    expect(Money.fromString(rung(result, "debt_principal"), "USD").isNegative()).toBe(false);
    expect(rung(result, "debt_principal")).not.toBe("0.00");
    expect(codes(result)).not.toContain("untracked_loan");
  });
});

describe("holding quantities (ADR-039 §2)", () => {
  it("confesses a position whose share count was never recorded at the start", async () => {
    const brokerage = await seedAccount("Brokerage", "investment", {
      [FROM]: "40000.00",
      [TO]: "52000.00",
    });
    await db.insert(holdings).values({
      accountId: brokerage,
      symbol: "FXAIX",
      quantity: "100.00000000",
      quantityUnit: "shares",
      assetClass: "equity",
    });

    const result = await loadAttribution({ from: FROM, to: TO });
    expect(codes(result)).toContain("quantity_drift");
  });

  it("says the count was never recorded rather than inventing a zero", async () => {
    const brokerage = await seedAccount("Brokerage", "investment", {
      [FROM]: "40000.00",
      [TO]: "52000.00",
    });
    await db.insert(holdings).values({
      accountId: brokerage,
      symbol: "FXAIX",
      quantity: "100.00000000",
      quantityUnit: "shares",
      assetClass: "equity",
    });

    const result = await loadAttribution({ from: FROM, to: TO });
    const drift = result.diagnostics.find((d) => d.code === "quantity_drift");
    // A `"0"` opening would ALSO produce a drift diagnostic — with the wrong
    // sentence. "We do not know what you held" and "you held nothing" are
    // different statements, and only one of them is true.
    expect(drift?.detail).toContain("no share count recorded at the start");
    expect(drift?.detail).not.toContain("changed share count");
  });

  it("reads the share count at the window's start, not the latest one", async () => {
    const brokerage = await seedAccount("Brokerage", "investment", {
      [FROM]: "40000.00",
      [TO]: "52000.00",
    });
    const [holding] = await db
      .insert(holdings)
      .values({
        accountId: brokerage,
        symbol: "FXAIX",
        quantity: "150.00000000",
        quantityUnit: "shares",
        assetClass: "equity",
      })
      .returning({ id: holdings.id });
    if (!holding) throw new Error("seed holding failed");
    // 100 shares at the window's start, 150 by mid-window and still 150 today.
    // Reading the LATEST snapshot would compare 150 against 150 and report no
    // drift at all — on the one book where the ADR-039 §2 wart actually bit.
    await db.insert(holdingSnapshots).values([
      { holdingId: holding.id, date: FROM, quantity: "100.00000000", value: "40000.00" },
      { holdingId: holding.id, date: "2026-02-15", quantity: "150.00000000", value: "60000.00" },
    ]);

    const result = await loadAttribution({ from: FROM, to: TO });
    expect(codes(result)).toContain("quantity_drift");
  });

  it("stays quiet when the opening share count matches today's", async () => {
    const brokerage = await seedAccount("Brokerage", "investment", {
      [FROM]: "40000.00",
      [TO]: "52000.00",
    });
    const [holding] = await db
      .insert(holdings)
      .values({
        accountId: brokerage,
        symbol: "FXAIX",
        quantity: "100.00000000",
        quantityUnit: "shares",
        assetClass: "equity",
      })
      .returning({ id: holdings.id });
    if (!holding) throw new Error("seed holding failed");
    await db.insert(holdingSnapshots).values({
      holdingId: holding.id,
      date: FROM,
      quantity: "100.00000000",
      value: "40000.00",
    });

    const result = await loadAttribution({ from: FROM, to: TO });
    expect(codes(result)).not.toContain("quantity_drift");
  });
});

describe("snapshot staleness is measured at the end it happened", () => {
  it("reads the opening endpoint's own snapshot date, not the closing one", async () => {
    // The balance last recorded three months BEFORE the window opens, and again
    // the day before it closes. The opening figure is therefore a stale carry —
    // and reading the closing date at both ends would report a book in perfect
    // health while the whole opening endpoint rests on a stale row.
    await seedAccount("Checking", "depository", {
      "2025-10-01": "5000.00",
      "2026-03-30": "8000.00",
    });

    const result = await loadAttribution({ from: FROM, to: TO });
    expect(codes(result)).toContain("snapshot_gap");
  });

  it("stays quiet when both endpoints rest on a recent balance", async () => {
    await seedAccount("Checking", "depository", { [FROM]: "5000.00", "2026-03-30": "8000.00" });
    const result = await loadAttribution({ from: FROM, to: TO });
    expect(codes(result)).not.toContain("snapshot_gap");
  });
});

describe("the degradation ladder reads the whole book (P17-14)", () => {
  it("returns no_snapshots on a book with no balances at all", async () => {
    await seedAccount("Checking", "depository");
    const result = await loadAttribution({ from: FROM, to: TO });
    expect(result.status).toBe("no_snapshots");
  });

  it("returns insufficient_history when records begin inside the window", async () => {
    await seedAccount("Checking", "depository", { "2026-02-01": "5000.00", [TO]: "8000.00" });
    const result = await loadAttribution({ from: FROM, to: TO });
    expect(result.status).toBe("insufficient_history");
  });

  it("returns ok once a balance exists on or before the window opens", async () => {
    await seedAccount("Checking", "depository", { [FROM]: "5000.00", [TO]: "8000.00" });
    const result = await loadAttribution({ from: FROM, to: TO });
    expect(result.status).toBe("ok");
  });
});

describe("an empty book", () => {
  it("returns every rung at zero rather than throwing", async () => {
    const result = await loadAttribution({ from: FROM, to: TO });
    expect(result.rungs.every((r) => r.amount === "0.00")).toBe(true);
    expect(result.delta).toBe("0.00");
  });
});
