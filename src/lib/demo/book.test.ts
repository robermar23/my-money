// @vitest-environment node
import { Money } from "@/lib/money/money.ts";
import { describe, expect, it } from "vitest";
import { addDays, buildDemoBook, demoOpeningBalance } from "./book.ts";

/*
 * P19-32 — the demo book's internal consistency, without a database. The
 * writer's refusals are covered in seed.test.ts.
 */

const TODAY = "2026-10-10";

describe("buildDemoBook", () => {
  it("is deterministic for a given day", () => {
    // P19-31 seeds one database and reads it twice; a book that changed between
    // two builds would make that comparison meaningless.
    expect(buildDemoBook(TODAY)).toEqual(buildDemoBook(TODAY));
  });

  it("covers the 365 days ending today, and nothing after it", () => {
    const book = buildDemoBook(TODAY);

    expect(book.from).toBe(addDays(TODAY, -364));
    expect(book.transactions.every((t) => t.postedAt >= book.from && t.postedAt <= TODAY)).toBe(
      true,
    );
    expect(book.snapshots.filter((s) => s.account === "checking")).toHaveLength(365);
  });

  it("reconciles every cash-like snapshot to its opening balance plus its transactions", () => {
    const book = buildDemoBook(TODAY);

    for (const key of ["checking", "savings", "card"] as const) {
      let running = Money.fromString(demoOpeningBalance(key), "USD");
      for (const snap of book.snapshots.filter((s) => s.account === key)) {
        for (const t of book.transactions) {
          if (t.account === key && t.postedAt === snap.date) {
            running = running.add(Money.fromString(t.amount, "USD"));
          }
        }
        expect(snap.balance, `${key} on ${snap.date}`).toBe(running.toString());
      }
    }
  });

  it("values the brokerage at the sum of its positions every day", () => {
    const book = buildDemoBook(TODAY);

    for (const snap of book.snapshots.filter((s) => s.account === "brokerage")) {
      const positions = book.holdingSnapshots
        .filter((h) => h.date === snap.date)
        .map((h) => Money.fromString(h.value, "USD"));
      expect(snap.balance).toBe(Money.sum(positions, "USD").toString());
    }
  });

  it("never overdraws checking and keeps the card owed rather than in credit", () => {
    // A demo whose checking account goes negative reads as a broken app.
    const book = buildDemoBook(TODAY);

    for (const s of book.snapshots) {
      if (s.account === "checking") expect(Number(s.balance)).toBeGreaterThan(0);
      if (s.account === "card") expect(Number(s.balance)).toBeLessThanOrEqual(0);
    }
  });

  it("gives every fitid a unique value within its account", () => {
    const book = buildDemoBook(TODAY);
    const keys = book.transactions.map((t) => `${t.account}/${t.fitid}`);

    expect(new Set(keys).size).toBe(keys.length);
  });

  it("names no real institution, merchant or ticker", () => {
    // PLAN19 §Privacy ¶1. Every name is a placeholder, and a ticker longer than
    // five letters cannot be a US listing, so the price fetch never resolves one.
    const book = buildDemoBook(TODAY);

    for (const a of book.accounts) {
      expect(a.institution).toMatch(/^(Demo|Example|Sample|Owner)\b/);
    }
    for (const h of book.holdings) {
      expect(h.symbol.length).toBeGreaterThan(5);
      expect(h.securityName).toMatch(/^Demo /);
    }
  });

  it("dates the planned expense in the future and the bill's anchor inside the book", () => {
    const book = buildDemoBook(TODAY);

    expect(book.plannedExpense.dueDate > TODAY).toBe(true);
    expect(book.plannedExpense.accrualStartDate <= book.plannedExpense.dueDate).toBe(true);
    expect(book.recurringBill.anchorDate >= book.recurringBill.startDate).toBe(true);
  });
});
