import type { Account, AccountSnapshot, Price, Transaction } from "@/db/schema/index.ts";
import { Money } from "@/lib/money/money.ts";

/**
 * Beancount export (Phase 6, ADR-016) — a nightly, ONE-WAY, plain-text mirror of
 * the database. Readable in `less` forever, with no tooling — the longevity
 * hedge from IDEAS.md §2/§10. my-money never reads beancount back.
 *
 * This is a HEDGE, not a ledger (CLAUDE.md §Domain Scope — we are not building
 * double-entry accounting):
 *   - `balance` assertions come straight from `account_snapshots` (the trustworthy
 *     net-worth spine). They will NOT necessarily reconcile under `bean-check`,
 *     because a snapshot is an independent point-in-time value (e.g. an
 *     investment account valued by holdings), not a sum of transaction postings.
 *   - Transactions are best-effort two-posting entries. Each entry balances (the
 *     contra leg is the exact negative), but the contra ACCOUNT is a guess
 *     (Income vs Expenses by sign), not a tracked counterparty.
 *
 * Money discipline (CLAUDE.md §Money): balance/transaction amounts are routed
 * through `Money` (2-dp, exact). `prices.close` is NUMERIC(18,8) and is emitted
 * verbatim — it is a per-unit price, not a money amount subject to cents
 * rounding, and we do no arithmetic on it, so the stored decimal string is the
 * faithful (and float-free) representation.
 */

const DEFAULT_CURRENCY = "USD";

export type BeancountAccountRow = Pick<
  Account,
  "id" | "type" | "institution" | "name" | "currency" | "createdAt"
>;
export type BeancountSnapshotRow = Pick<AccountSnapshot, "accountId" | "date" | "balance">;
export type BeancountPriceRow = Pick<Price, "symbol" | "date" | "close">;
export type BeancountTransactionRow = Pick<
  Transaction,
  "accountId" | "postedAt" | "amount" | "name" | "memo" | "category"
>;

export interface BeancountInput {
  readonly accounts: readonly BeancountAccountRow[];
  readonly snapshots: readonly BeancountSnapshotRow[];
  readonly prices: readonly BeancountPriceRow[];
  readonly transactions: readonly BeancountTransactionRow[];
  /** Fixed for deterministic output in tests; defaults to now. */
  readonly generatedAt?: Date;
}

/**
 * CamelCase a free-text string into a single valid beancount account component
 * (`[A-Z][A-Za-z0-9]*`). "M&T Bank" → "MTBank"; "Gold Card" → "GoldCard".
 * Returns "X" if nothing survives (e.g. an all-punctuation name).
 */
function toComponent(raw: string): string {
  const camel = raw
    .normalize("NFKC")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join("");
  if (!camel) return "X";
  // A component must start with a letter or digit; CamelCase guarantees that,
  // but guard against a leading digit-only edge by prefixing nothing (digits
  // are legal leaders in beancount).
  return camel;
}

/** Coerce an arbitrary symbol into a valid beancount commodity name. */
function toCommodity(symbol: string): string {
  let s = symbol
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "-")
    .replace(/-+/g, "-")
    .replace(/-+$/g, "");
  if (!/^[A-Z]/.test(s)) s = `X${s}`;
  return s || "X";
}

/** Escape a string for a beancount double-quoted literal. */
function escapeString(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/[\r\n]+/g, " ");
}

/** The beancount root type for one of our account types. */
function rootType(type: BeancountAccountRow["type"]): "Assets" | "Liabilities" {
  return type === "credit_card" || type === "loan" ? "Liabilities" : "Assets";
}

/** `Assets:M&TBank:Checking` → `Assets:MTBank:Checking`. */
export function accountToBeancountName(
  account: Pick<BeancountAccountRow, "type" | "institution" | "name">,
): string {
  return `${rootType(account.type)}:${toComponent(account.institution)}:${toComponent(account.name)}`;
}

/** `YYYY-MM-DD open <Account> <CUR>`. */
export function formatOpen(
  account: Pick<BeancountAccountRow, "type" | "institution" | "name" | "currency">,
  openDate: string,
): string {
  return `${openDate} open ${accountToBeancountName(account)} ${account.currency}`;
}

/** `YYYY-MM-DD balance <Account> <amount> <CUR>` (amount via Money, exact 2-dp). */
export function formatBalance(
  account: Pick<BeancountAccountRow, "type" | "institution" | "name" | "currency">,
  snapshot: BeancountSnapshotRow,
): string {
  const amount = Money.fromString(snapshot.balance, account.currency).toString();
  return `${snapshot.date} balance ${accountToBeancountName(account)} ${amount} ${account.currency}`;
}

/** `YYYY-MM-DD price <COMMODITY> <close> USD` (close emitted verbatim, 8-dp). */
export function formatPrice(price: Pick<BeancountPriceRow, "symbol" | "date" | "close">): string {
  return `${price.date} price ${toCommodity(price.symbol)} ${price.close} ${DEFAULT_CURRENCY}`;
}

/**
 * A best-effort balanced two-posting entry:
 *
 *   YYYY-MM-DD * "name" ["memo"]
 *     <Account>            <amount> CUR
 *     <Income|Expenses>:<Cat>  <-amount> CUR
 *
 * Sign (our convention: positive = inflow): a positive amount credits the
 * account and debits Income; a negative amount debits the account and credits
 * Expenses. The contra leg is the exact negative, so the entry balances.
 */
export function formatTransaction(
  txn: BeancountTransactionRow,
  account: Pick<BeancountAccountRow, "type" | "institution" | "name" | "currency">,
): string {
  const cur = account.currency;
  const amount = Money.fromString(txn.amount, cur);
  const contra = amount.negate();
  const contraRoot = amount.isNegative() ? "Expenses" : "Income";
  const category = txn.category ? toComponent(txn.category) : "Uncategorized";

  const header = txn.memo
    ? `${txn.postedAt} * "${escapeString(txn.name)}" "${escapeString(txn.memo)}"`
    : `${txn.postedAt} * "${escapeString(txn.name)}"`;

  return [
    header,
    `  ${accountToBeancountName(account)}  ${amount.toString()} ${cur}`,
    `  ${contraRoot}:${category}  ${contra.toString()} ${cur}`,
  ].join("\n");
}

function header(generatedAt: Date): string {
  return [
    ";; my-money beancount export — GENERATED, DO NOT EDIT.",
    ";; One-way mirror of the Postgres database (ADR-016); edits are overwritten.",
    `;; Generated at ${generatedAt.toISOString()}.`,
    ";; `balance` assertions come from account_snapshots and may not reconcile",
    ";; under bean-check; transactions are best-effort two-posting entries.",
    "",
    'option "title" "my-money"',
    `option "operating_currency" "${DEFAULT_CURRENCY}"`,
  ].join("\n");
}

/** Earliest YYYY-MM-DD an account is referenced (snapshot/txn), else its createdAt day. */
function earliestActivity(
  account: BeancountAccountRow,
  snapshots: readonly BeancountSnapshotRow[],
  transactions: readonly BeancountTransactionRow[],
): string {
  let min: string | null = null;
  for (const s of snapshots) {
    if (s.accountId === account.id && (min === null || s.date < min)) min = s.date;
  }
  for (const t of transactions) {
    if (t.accountId === account.id && (min === null || t.postedAt < min)) min = t.postedAt;
  }
  return min ?? account.createdAt.toISOString().slice(0, 10);
}

/**
 * Render the whole database into one deterministic, sorted beancount document.
 * Same input + `generatedAt` → byte-identical output.
 */
export function renderBeancount(input: BeancountInput): string {
  const generatedAt = input.generatedAt ?? new Date();
  const byId = new Map(input.accounts.map((a) => [a.id, a]));
  const nameOf = (a: BeancountAccountRow) => accountToBeancountName(a);

  const sections: string[] = [header(generatedAt)];

  // ── Accounts (open directives), sorted by beancount name ──
  if (input.accounts.length > 0) {
    const opens = [...input.accounts]
      .sort((a, b) => nameOf(a).localeCompare(nameOf(b)))
      .map((a) => formatOpen(a, earliestActivity(a, input.snapshots, input.transactions)));
    sections.push([";; ── Accounts ──", ...opens].join("\n"));
  }

  // ── Prices, sorted by (date, commodity) ──
  if (input.prices.length > 0) {
    const lines = [...input.prices]
      .sort((a, b) => a.date.localeCompare(b.date) || a.symbol.localeCompare(b.symbol))
      .map(formatPrice);
    sections.push([";; ── Prices ──", ...lines].join("\n"));
  }

  // ── Balances (from snapshots), sorted by (date, account name) ──
  const balances = input.snapshots
    .map((s) => ({ s, a: byId.get(s.accountId) }))
    .filter((x): x is { s: BeancountSnapshotRow; a: BeancountAccountRow } => x.a !== undefined)
    .sort((x, y) => x.s.date.localeCompare(y.s.date) || nameOf(x.a).localeCompare(nameOf(y.a)))
    .map(({ s, a }) => formatBalance(a, s));
  if (balances.length > 0) {
    sections.push([";; ── Balances (account_snapshots) ──", ...balances].join("\n"));
  }

  // ── Transactions, sorted by (date, account name, name, amount) ──
  const txns = input.transactions
    .map((t) => ({ t, a: byId.get(t.accountId) }))
    .filter((x): x is { t: BeancountTransactionRow; a: BeancountAccountRow } => x.a !== undefined)
    .sort(
      (x, y) =>
        x.t.postedAt.localeCompare(y.t.postedAt) ||
        nameOf(x.a).localeCompare(nameOf(y.a)) ||
        x.t.name.localeCompare(y.t.name) ||
        x.t.amount.localeCompare(y.t.amount),
    )
    .map(({ t, a }) => formatTransaction(t, a));
  if (txns.length > 0) {
    sections.push([";; ── Transactions ──", ...txns].join("\n"));
  }

  return `${sections.join("\n\n")}\n`;
}
