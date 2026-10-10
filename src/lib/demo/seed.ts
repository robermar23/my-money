import "server-only";

import { type Db, db } from "@/db/client.ts";
import {
  accountSnapshots,
  accounts,
  categories,
  categoryBudgets,
  categoryGroups,
  holdingSnapshots,
  holdings,
  liabilities,
  plannedExpenses,
  prices,
  scheduledObligations,
  securities,
  transactions,
} from "@/db/schema/index.ts";
import { DEFAULT_CATEGORIES, DEFAULT_GROUPS } from "@/lib/categorization/seed.ts";
import { sql } from "drizzle-orm";
import { type DemoAccountKey, type DemoBook, buildDemoBook } from "./book.ts";

/**
 * PLAN19 P19-32 — write the demo household, and refuse every way it could
 * damage a real one.
 *
 * This is the one new destructive capability Phase 19 contemplates (PLAN19
 * §Privacy ¶1), so the refusals are the feature and the rows are incidental:
 *
 *   1. **Production refuses** unless `SEED_DEMO_CONFIRM=yes` is set. A demo on
 *      a production instance is legitimate (it is how a prospective adopter
 *      evaluates the published image), but it has to be asked for by name.
 *   2. **A non-empty book refuses**, always, with no override. "Non-empty"
 *      means any row in a table that holds the household's own records. The
 *      tables an untouched instance fills by itself are ignored: `users` (the
 *      password), `categories`/`category_rules` (seeded defaults), `prices`
 *      (the worker fetches the benchmark nightly), `alerts` (the unconfigured-
 *      backup alert, ADR-052) and `household_profile`.
 *   3. **One transaction.** The emptiness check and every insert share it, so
 *      a failure partway leaves the database exactly as it was. A re-run on a
 *      seeded book is refused by rule 2: it is a no-op, never a partial merge.
 *
 * There is deliberately no "wipe and reseed" mode. Clearing a book is
 * `make db-reset`, a separate command with its own name, so no single command
 * both destroys data and writes a fake replacement.
 */

/** The variable that lets the seeder run where `NODE_ENV` is `production`. */
export const DEMO_CONFIRM_VAR = "SEED_DEMO_CONFIRM";

/**
 * Tables whose rows are the household's own records. Any row in any of them
 * makes the book non-empty. Constant identifiers, never user input.
 */
export const BOOK_TABLES = [
  "accounts",
  "transactions",
  "account_snapshots",
  "holdings",
  "holding_lots",
  "holding_snapshots",
  "securities",
  "investment_transactions",
  "liabilities",
  "credit_lines",
  "import_batches",
  "asset_documents",
  "plaid_items",
  "income_sources",
  "retirement_contributions",
  "scheduled_obligations",
  "obligation_occurrences",
  "planned_expenses",
  "category_budgets",
  "household_members",
  "watchlist_items",
  "price_targets",
] as const;

/** Why the seeder declined to write anything. */
export type DemoSeedRefusal =
  | { readonly kind: "production" }
  | { readonly kind: "not_empty"; readonly tables: readonly string[] };

/** Thrown when a refusal fires. Nothing has been written when it is. */
export class DemoSeedRefused extends Error {
  readonly refusal: DemoSeedRefusal;

  constructor(refusal: DemoSeedRefusal) {
    super(refusalMessage(refusal));
    this.name = "DemoSeedRefused";
    this.refusal = refusal;
  }
}

function refusalMessage(refusal: DemoSeedRefusal): string {
  if (refusal.kind === "production") {
    return `Refusing to seed demo data: NODE_ENV is "production". Set ${DEMO_CONFIRM_VAR}=yes to seed this instance on purpose.`;
  }
  const tables = refusal.tables.join(", ");
  return `Refusing to seed demo data: this database already holds records (${tables}). The demo only seeds an empty book, and it never overwrites or merges. Use a fresh instance to evaluate the app.`;
}

/**
 * The production guard, as a pure function of the environment.
 *
 * @param env - The process environment (injected for tests).
 * @returns The refusal, or null when seeding may proceed.
 */
export function productionRefusal(env: NodeJS.ProcessEnv): DemoSeedRefusal | null {
  if (env.NODE_ENV !== "production") return null;
  return env[DEMO_CONFIRM_VAR] === "yes" ? null : { kind: "production" };
}

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * Every book table that holds at least one row.
 *
 * @param tx - The handle to read through (the seeding transaction).
 * @returns Table names, in {@link BOOK_TABLES} order; empty for an empty book.
 */
export async function occupiedBookTables(tx: Tx | Db = db): Promise<string[]> {
  const probes = BOOK_TABLES.map((t) =>
    sql.raw(`SELECT '${t}' AS t WHERE EXISTS (SELECT 1 FROM "${t}")`),
  );
  const rows = await tx.execute<{ t: string }>(sql.join(probes, sql` UNION ALL `));
  const hit = new Set(Array.from(rows, (r) => r.t));
  return BOOK_TABLES.filter((t) => hit.has(t));
}

/** Row counts the seeder wrote, for the CLI's one-line report. */
export interface DemoSeedSummary {
  readonly from: string;
  readonly today: string;
  readonly accounts: number;
  readonly transactions: number;
  readonly snapshots: number;
}

export interface SeedDemoOptions {
  /** Last day of the book; defaults to today in UTC. */
  readonly today?: string;
  /** Environment for the production guard; defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Seed the demo household into an empty book.
 *
 * @param options - Reference date and environment, both injectable.
 * @returns What was written.
 * @throws {DemoSeedRefused} In production without confirmation, or when the
 *   book is not empty. Nothing is written in either case.
 */
export async function seedDemo(options: SeedDemoOptions = {}): Promise<DemoSeedSummary> {
  const refusal = productionRefusal(options.env ?? process.env);
  if (refusal) throw new DemoSeedRefused(refusal);

  const book = buildDemoBook(options.today ?? new Date().toISOString().slice(0, 10));

  return db.transaction(async (tx) => {
    const occupied = await occupiedBookTables(tx);
    if (occupied.length > 0) throw new DemoSeedRefused({ kind: "not_empty", tables: occupied });

    const categoryId = await ensureCategories(tx);
    const accountId = await writeAccounts(tx, book);
    await writeActivity(tx, book, accountId, categoryId);
    await writeInvestments(tx, book, accountId);
    await writePlans(tx, book, accountId, categoryId);

    return {
      from: book.from,
      today: book.today,
      accounts: book.accounts.length,
      transactions: book.transactions.length,
      snapshots: book.snapshots.length,
    };
  });
}

/**
 * Resolve the default category names to ids, inserting the default taxonomy
 * first when an instance has none yet. An instance that already has
 * categories keeps them; a renamed default fails loudly rather than filing
 * demo rows under nothing.
 */
async function ensureCategories(tx: Tx): Promise<(name: string) => string> {
  const existing = await tx.select({ id: categories.id }).from(categories).limit(1);
  if (existing.length === 0) {
    const groups = await tx
      .insert(categoryGroups)
      .values(DEFAULT_GROUPS.map((g) => ({ name: g.name, sortOrder: g.sortOrder })))
      .returning({ id: categoryGroups.id, name: categoryGroups.name });
    const groupId = new Map(groups.map((g) => [g.name.toLowerCase(), g.id]));
    await tx.insert(categories).values(
      DEFAULT_CATEGORIES.map((c, i) => ({
        name: c.name,
        kind: c.kind,
        groupId: groupId.get(c.group.toLowerCase()) ?? null,
        sortOrder: 10 + i,
      })),
    );
  }
  const rows = await tx.select({ id: categories.id, name: categories.name }).from(categories);
  const byName = new Map(rows.map((r) => [r.name.toLowerCase(), r.id]));
  return (name) => {
    const id = byName.get(name.toLowerCase());
    if (!id) throw new Error(`Demo seed needs a category named "${name}", and none exists.`);
    return id;
  };
}

async function writeAccounts(tx: Tx, book: DemoBook): Promise<(key: DemoAccountKey) => string> {
  const ids = new Map<DemoAccountKey, string>();
  for (const a of book.accounts) {
    const [row] = await tx
      .insert(accounts)
      .values({
        name: a.name,
        institution: a.institution,
        type: a.type,
        subtype: a.subtype ?? null,
        apy: a.apy ?? null,
        taxTreatment: a.taxTreatment ?? null,
        acquiredAt: a.acquiredAt ?? null,
        acquisitionCost: a.acquisitionCost ?? null,
      })
      .returning({ id: accounts.id });
    if (!row) throw new Error(`Demo seed could not create account "${a.name}".`);
    ids.set(a.key, row.id);
  }
  return (key) => {
    const id = ids.get(key);
    if (!id) throw new Error(`Demo book references an unknown account "${key}".`);
    return id;
  };
}

/** Insert in slices so one statement never carries thousands of parameters. */
async function insertChunked<T>(rows: readonly T[], write: (slice: T[]) => Promise<unknown>) {
  for (let i = 0; i < rows.length; i += 500) await write(rows.slice(i, i + 500));
}

async function writeActivity(
  tx: Tx,
  book: DemoBook,
  accountId: (key: DemoAccountKey) => string,
  categoryId: (name: string) => string,
): Promise<void> {
  await insertChunked(book.transactions, (slice) =>
    tx.insert(transactions).values(
      slice.map((t) => ({
        accountId: accountId(t.account),
        postedAt: t.postedAt,
        amount: t.amount,
        name: t.name,
        category: t.category,
        categoryId: categoryId(t.category),
        fitid: t.fitid,
        source: "manual",
      })),
    ),
  );
  await insertChunked(book.snapshots, (slice) =>
    tx
      .insert(accountSnapshots)
      .values(
        slice.map((s) => ({ accountId: accountId(s.account), date: s.date, balance: s.balance })),
      ),
  );
  await tx.insert(liabilities).values({
    accountId: accountId("mortgage"),
    name: book.mortgage.name,
    principalAtOrigination: book.mortgage.principal,
    annualRate: book.mortgage.annualRate,
    termMonths: book.mortgage.termMonths,
    startDate: book.mortgage.startDate,
  });
}

async function writeInvestments(
  tx: Tx,
  book: DemoBook,
  accountId: (key: DemoAccountKey) => string,
): Promise<void> {
  const holdingId = new Map<string, string>();
  for (const h of book.holdings) {
    const [security] = await tx
      .insert(securities)
      .values({ symbol: h.symbol, tickerSymbol: h.symbol, name: h.securityName, assetType: "etf" })
      .returning({ id: securities.id });
    const [holding] = await tx
      .insert(holdings)
      .values({
        accountId: accountId("brokerage"),
        symbol: h.symbol,
        quantity: h.quantity,
        quantityUnit: "shares",
        assetClass: "equity",
        costBasis: h.costBasis,
        securityId: security?.id ?? null,
      })
      .returning({ id: holdings.id });
    if (!holding) throw new Error(`Demo seed could not create holding "${h.symbol}".`);
    holdingId.set(h.symbol, holding.id);
  }
  const position = (symbol: string): { id: string; quantity: string; costBasis: string } => {
    const id = holdingId.get(symbol);
    const h = book.holdings.find((x) => x.symbol === symbol);
    if (!id || !h) throw new Error(`Demo book references an unknown holding "${symbol}".`);
    return { id, quantity: h.quantity, costBasis: h.costBasis };
  };
  await insertChunked(book.holdingSnapshots, (slice) =>
    tx.insert(holdingSnapshots).values(
      slice.map((s) => {
        const p = position(s.symbol);
        return {
          holdingId: p.id,
          date: s.date,
          quantity: p.quantity,
          value: s.value,
          costBasis: p.costBasis,
        };
      }),
    ),
  );
  // Plain insert, no ON CONFLICT: these symbols cannot already be priced on an
  // empty book, and if they somehow are, failing the whole seed is the honest
  // outcome (and the transaction makes it a clean one).
  await insertChunked(book.prices, (slice) =>
    tx.insert(prices).values(slice.map((p) => ({ ...p, source: "manual" }))),
  );
}

async function writePlans(
  tx: Tx,
  book: DemoBook,
  accountId: (key: DemoAccountKey) => string,
  categoryId: (name: string) => string,
): Promise<void> {
  const pe = book.plannedExpense;
  await tx.insert(plannedExpenses).values({
    label: pe.label,
    amount: pe.amount,
    dueDate: pe.dueDate,
    accrualStartDate: pe.accrualStartDate,
    categoryId: categoryId(pe.category),
  });
  const bill = book.recurringBill;
  await tx.insert(scheduledObligations).values({
    accountId: accountId("checking"),
    categoryId: categoryId(bill.category),
    label: bill.label,
    expectedAmount: bill.amount,
    direction: "outflow",
    cadence: "monthly",
    anchorDate: bill.anchorDate,
    startDate: bill.startDate,
    source: "manual",
  });
  await tx
    .insert(categoryBudgets)
    .values(book.budgets.map((b) => ({ categoryId: categoryId(b.category), amount: b.amount })));
}
