import "server-only";

import { db } from "@/db/client.ts";
import { categoryRules, transactions } from "@/db/schema/index.ts";
import { DEFAULT_RULES } from "@/lib/categorization/seed.ts";
import { type ChecklistFacts, REVIEW_QUEUE_TARGET } from "@/lib/help/checklist.ts";
import { backupsConfigured } from "@/lib/instance/queries.ts";
import { isNull, notInArray, sql } from "drizzle-orm";

/**
 * What the getting-started checklist is derived from (PLAN20 P20-30).
 *
 * The accounts come from the dashboard's own net-worth read, so they cost
 * nothing. The rest is three small reads, run in parallel with the dashboard
 * loader, each stopping at the few rows it needs: one transaction, at most
 * {@link REVIEW_QUEUE_TARGET} uncategorized ones, one rule outside the default
 * set. Backups come from the same sources `/settings/instance` reads.
 *
 * Every fact is a yes/no or a capped count. None is a figure, and nothing here
 * is stored (ADR-060: the checklist is derived, never kept).
 */

/** The part of the facts that the accounts already on the dashboard answer. */
type AccountFacts = Pick<ChecklistFacts, "hasAccount" | "importAccountId">;

/** The rest, read here. */
export type BookFacts = Omit<ChecklistFacts, keyof AccountFacts>;

/** Account types an import fits best: statements come from cash and card accounts. */
const IMPORTABLE: ReadonlySet<string> = new Set(["depository", "credit_card"]);

/** The patterns the default rule set seeds; a rule outside them is the owner's own. */
const DEFAULT_PATTERNS: readonly string[] = DEFAULT_RULES.map((rule) => rule.pattern);

/**
 * Read the book facts the dashboard does not already have.
 *
 * @returns Yes/no facts and a capped count; never a figure.
 */
export async function loadBookFacts(): Promise<BookFacts> {
  const [anyTransaction, waiting, ownRule, backups] = await Promise.all([
    db.select({ one: sql`1` }).from(transactions).limit(1),
    db
      .select({ one: sql`1` })
      .from(transactions)
      .where(isNull(transactions.categoryId))
      .limit(REVIEW_QUEUE_TARGET),
    db
      .select({ one: sql`1` })
      .from(categoryRules)
      .where(notInArray(categoryRules.pattern, [...DEFAULT_PATTERNS]))
      .limit(1),
    backupsConfigured(),
  ]);
  return {
    hasTransaction: anyTransaction.length > 0,
    waitingCount: waiting.length,
    hasOwnRule: ownRule.length > 0,
    backupsConfigured: backups,
  };
}

/**
 * Answer the account facts from the dashboard's own account list.
 *
 * @param accounts - The net-worth line items, or none on a first run.
 * @returns Whether an account exists, and which one an import link should open.
 */
export function accountFacts(
  accounts: readonly { readonly accountId: string; readonly accountType: string }[],
): AccountFacts {
  const target = accounts.find((a) => IMPORTABLE.has(a.accountType)) ?? accounts[0];
  return { hasAccount: accounts.length > 0, importAccountId: target?.accountId ?? null };
}
