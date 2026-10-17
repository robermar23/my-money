import type { Route } from "next";
import { TOUR_HASH } from "./events.ts";

/**
 * The getting-started checklist (PLAN20 P20-30).
 *
 * Five things a working book has, each **derived from state the app already
 * keeps**, never stored. Ticking happens by doing the thing, not by clicking a
 * box. This module is pure: the dashboard gathers the {@link ChecklistFacts}
 * and this turns them into items, so the wording and the "done" rules are
 * tested without a database.
 *
 * The copy follows the help rules (docs/HELP.md): second person, the pages' own
 * words, and no figure the app computes. The one number shown is
 * {@link REVIEW_QUEUE_TARGET}, a fixed constant rather than a setting
 * (`personal-tool-builder`, PLAN20 P20-00).
 */

/**
 * The review queue counts as worked down below this many uncategorized
 * transactions. Fixed, not a setting: the item is a nudge, not a goal to tune.
 */
export const REVIEW_QUEUE_TARGET = 20;

/** What the checklist is derived from. Gathered on the server, holding no figures. */
export interface ChecklistFacts {
  /** At least one account exists. */
  readonly hasAccount: boolean;
  /**
   * An account to import into: a cash or card account if there is one, else
   * any account, else `null`. Only its id, which the link needs.
   */
  readonly importAccountId: string | null;
  /** At least one transaction exists, imported or synced. */
  readonly hasTransaction: boolean;
  /**
   * Uncategorized transactions, counted no higher than
   * {@link REVIEW_QUEUE_TARGET}: the item only needs to know "below it or not".
   */
  readonly waitingCount: number;
  /** A category rule exists that is not one of the default set. */
  readonly hasOwnRule: boolean;
  /**
   * Nightly backups are switched on, or `null` when neither the app nor the
   * worker's last report can say (the worker is down or has not reported yet).
   */
  readonly backupsConfigured: boolean | null;
}

/** The checklist's items, in the order they are worth doing. */
export type ChecklistItemId = "account" | "transactions" | "review" | "rule" | "backups";

/** One line of the checklist. */
export interface ChecklistItem {
  readonly id: ChecklistItemId;
  /** What to do, as a short imperative. */
  readonly title: string;
  /** One sentence on why, or where it is done. */
  readonly detail: string;
  readonly done: boolean;
  /** The page where it is done, or `null` while an earlier item blocks it. */
  readonly href: Route | null;
  /** The same page with its tour started, or `null` when the page has none. */
  readonly tourHref: Route | null;
}

function accountItem(facts: ChecklistFacts): ChecklistItem {
  return {
    id: "account",
    title: "Add an account",
    detail: "Everything on the dashboard builds from your accounts and their balances.",
    done: facts.hasAccount,
    href: "/accounts/new",
    tourHref: `/accounts${TOUR_HASH}`,
  };
}

function transactionsItem(facts: ChecklistFacts): ChecklistItem {
  const id = facts.importAccountId;
  return {
    id: "transactions",
    title: "Bring in transactions",
    detail:
      "Import a bank statement on an account's page, or connect the bank under Settings → Connections.",
    done: facts.hasTransaction,
    href: id === null ? null : `/accounts/${id}/import`,
    tourHref: id === null ? null : `/accounts/${id}/import${TOUR_HASH}`,
  };
}

function reviewItem(facts: ChecklistFacts): ChecklistItem {
  return {
    id: "review",
    title: `Get the review queue under ${REVIEW_QUEUE_TARGET}`,
    detail: "Spending, budgets and cash flow only count what has a category.",
    // An empty book has an empty queue; that is not the queue worked down.
    done: facts.hasTransaction && facts.waitingCount < REVIEW_QUEUE_TARGET,
    href: facts.hasTransaction ? "/analysis/review" : null,
    tourHref: facts.hasTransaction ? `/analysis/review${TOUR_HASH}` : null,
  };
}

function ruleItem(facts: ChecklistFacts): ChecklistItem {
  return {
    id: "rule",
    title: "Make a rule of your own",
    detail:
      "A rule categorizes a payee from now on. Categorizing with “make rule” ticked makes one, or add one under Categories.",
    done: facts.hasOwnRule,
    href: "/settings/categories",
    tourHref: null,
  };
}

function backupsItem(facts: ChecklistFacts): ChecklistItem {
  return {
    id: "backups",
    title: "Switch on backups",
    detail: "Your history is the whole point; the Instance page shows whether backups run.",
    done: facts.backupsConfigured === true,
    href: "/settings/instance",
    tourHref: null,
  };
}

/**
 * Turn the facts into the checklist.
 *
 * @param facts - What the dashboard gathered.
 * @returns The five items, in order.
 */
export function gettingStarted(facts: ChecklistFacts): readonly ChecklistItem[] {
  return [
    accountItem(facts),
    transactionsItem(facts),
    reviewItem(facts),
    ruleItem(facts),
    backupsItem(facts),
  ];
}

/**
 * Whether every item is done. Once it is, the checklist is gone for good on
 * that device, even if an item later slips (a queue that grows back).
 *
 * @param items - The checklist.
 * @returns `true` when nothing is left to do.
 */
export function isComplete(items: readonly ChecklistItem[]): boolean {
  return items.every((item) => item.done);
}
