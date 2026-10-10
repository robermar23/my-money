// @vitest-environment node
import { db } from "@/db/client.ts";
import { accounts, categories, prices, transactions } from "@/db/schema/index.ts";
import { Money } from "@/lib/money/money.ts";
import { computeNetWorth } from "@/lib/net-worth/compute.ts";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { buildDemoBook } from "./book.ts";
import {
  BOOK_TABLES,
  DEMO_CONFIRM_VAR,
  DemoSeedRefused,
  occupiedBookTables,
  productionRefusal,
  seedDemo,
} from "./seed.ts";

/*
 * P19-32 — the seeder's safety properties are the requirement; the rows are
 * incidental. Real DB: the refusals are about what is in it.
 */

const TODAY = "2026-10-10";
const DEV = { NODE_ENV: "development" } as NodeJS.ProcessEnv;

async function reset(): Promise<void> {
  await db.execute(
    sql.raw(
      `TRUNCATE ${BOOK_TABLES.join(", ")}, prices, categories, category_groups, category_rules CASCADE`,
    ),
  );
}

async function count(table: string): Promise<number> {
  const rows = await db.execute<{ n: number }>(
    sql.raw(`SELECT count(*)::int AS n FROM "${table}"`),
  );
  return rows[0]?.n ?? 0;
}

beforeEach(reset);

describe("productionRefusal", () => {
  it("refuses in production without the confirmation variable", () => {
    expect(productionRefusal({ NODE_ENV: "production" } as NodeJS.ProcessEnv)).toEqual({
      kind: "production",
    });
  });

  it("accepts production only when the variable is exactly 'yes'", () => {
    const env = (v: string) =>
      ({ NODE_ENV: "production", [DEMO_CONFIRM_VAR]: v }) as NodeJS.ProcessEnv;

    expect(productionRefusal(env("yes"))).toBeNull();
    expect(productionRefusal(env("1"))).toEqual({ kind: "production" });
    expect(productionRefusal(env(""))).toEqual({ kind: "production" });
  });

  it("does not apply outside production", () => {
    expect(productionRefusal(DEV)).toBeNull();
    expect(productionRefusal({} as NodeJS.ProcessEnv)).toBeNull();
  });
});

describe("seedDemo — refusals", () => {
  it("refuses a non-empty book and writes nothing", async () => {
    await db
      .insert(accounts)
      .values({ name: "Real checking", institution: "Real bank", type: "depository" });

    await expect(seedDemo({ today: TODAY, env: DEV })).rejects.toBeInstanceOf(DemoSeedRefused);
    await expect(seedDemo({ today: TODAY, env: DEV })).rejects.toThrow(/already holds records/);
    expect(await count("accounts")).toBe(1);
    expect(await count("transactions")).toBe(0);
  });

  it("names every occupied table in the refusal", async () => {
    await seedDemo({ today: TODAY, env: DEV });

    const occupied = await occupiedBookTables();
    expect(occupied).toEqual(
      expect.arrayContaining(["accounts", "transactions", "account_snapshots", "planned_expenses"]),
    );
  });

  it("refuses in production before reading the database", async () => {
    await expect(
      seedDemo({ today: TODAY, env: { NODE_ENV: "production" } as NodeJS.ProcessEnv }),
    ).rejects.toThrow(DEMO_CONFIRM_VAR);
    expect(await count("accounts")).toBe(0);
  });

  it("ignores the tables an untouched instance fills by itself", async () => {
    // A fresh instance has a password, seeded categories and the nightly
    // benchmark price before the household has entered anything.
    await db.execute(sql`INSERT INTO users (password_hash) VALUES ('x')`);
    await db.insert(prices).values({ symbol: "^GSPC", date: TODAY, close: "5000" });

    expect(await occupiedBookTables()).toEqual([]);
    await expect(seedDemo({ today: TODAY, env: DEV })).resolves.toMatchObject({ accounts: 6 });
  });
});

describe("seedDemo — re-running", () => {
  it("is a no-op the second time, never a partial merge", async () => {
    await seedDemo({ today: TODAY, env: DEV });
    const before = await Promise.all(["accounts", "transactions", "account_snapshots"].map(count));

    await expect(seedDemo({ today: TODAY, env: DEV })).rejects.toBeInstanceOf(DemoSeedRefused);

    expect(await Promise.all(["accounts", "transactions", "account_snapshots"].map(count))).toEqual(
      before,
    );
  });

  it("leaves nothing behind when it fails partway", async () => {
    // `prices` is not a book table, so a clashing row passes the emptiness check
    // and fails the seed near its end, after the accounts and transactions are
    // already written inside the transaction.
    const book = buildDemoBook(TODAY);
    await db.insert(prices).values({ symbol: "DEMOSTOCK", date: book.today, close: "1" });

    await expect(seedDemo({ today: TODAY, env: DEV })).rejects.toThrow();

    expect(await occupiedBookTables()).toEqual([]);
    expect(await count("categories")).toBe(0);
  });
});

describe("seedDemo — the written book", () => {
  it("files every transaction under a category that exists", async () => {
    await seedDemo({ today: TODAY, env: DEV });

    const orphans = await db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM ${transactions} t
      LEFT JOIN ${categories} c ON c.id = t.category_id
      WHERE c.id IS NULL`);
    expect(orphans[0]?.n).toBe(0);
  });

  it("reconciles each day's cash snapshot to the prior day plus that day's transactions", async () => {
    await seedDemo({ today: TODAY, env: DEV });

    const breaks = await db.execute<{ n: number }>(sql`
      WITH s AS (
        SELECT a.id, s.date, s.balance,
               lag(s.balance) OVER (PARTITION BY a.id ORDER BY s.date) AS prior
        FROM accounts a JOIN account_snapshots s ON s.account_id = a.id
        WHERE a.type IN ('depository', 'credit_card')
      ), d AS (
        SELECT account_id, posted_at, sum(amount) AS delta
        FROM transactions GROUP BY account_id, posted_at
      )
      SELECT count(*)::int AS n FROM s
      LEFT JOIN d ON d.account_id = s.id AND d.posted_at = s.date
      WHERE s.prior IS NOT NULL AND s.balance <> s.prior + coalesce(d.delta, 0)`);
    expect(breaks[0]?.n).toBe(0);
  });

  it("produces the net worth the pure book implies", async () => {
    // The app's own net-worth path, reading what the writer stored, agrees with
    // the generator: every account's latest row on or before today, summed.
    await seedDemo({ today: TODAY, env: DEV });
    const book = buildDemoBook(TODAY);
    const latest = new Map<string, string>();
    for (const s of book.snapshots) latest.set(s.account, s.balance);
    const expected = Money.sum(
      [...latest.values()].map((b) => Money.fromString(b, "USD")),
      "USD",
    );

    const nw = await computeNetWorth(new Date(`${TODAY}T00:00:00Z`), "USD");

    expect(nw.total.toString()).toBe(expected.toString());
  });
});
