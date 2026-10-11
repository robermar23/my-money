import type { HelpEntry } from "../types.ts";

/**
 * Help for the Accounts pages (PLAN20).
 *
 * Placeholders from P20-04: a title and the one-line summary from
 * docs/FEATURES.md's question column. The sections are written in P20-10.
 */
export const ACCOUNTS_HELP: readonly HelpEntry[] = [
  {
    route: "/accounts",
    title: "All accounts",
    summary: "What accounts do I have, and is each one up to date?",
    sections: [],
  },
  {
    route: "/accounts/new",
    title: "Add an account",
    summary: "How do I add an account by hand, including a house, car, or collectible?",
    sections: [],
  },
  {
    route: "/accounts/<id>",
    title: "Account",
    summary: "What is in one account: balance history, transactions, holdings, loan or card terms?",
    sections: [],
  },
  {
    route: "/accounts/<id>/import",
    title: "Import a statement",
    summary: "How do I load a bank's QFX or CSV export, and did it reconcile?",
    sections: [],
  },
  {
    route: "/accounts/<id>/import/<id>",
    title: "Reading your file",
    summary:
      "A large statement is being read in the background; the preview opens when it is ready.",
    sections: [],
  },
  {
    route: "/accounts/<id>/import/<id>/preview",
    title: "Preview import",
    summary:
      "What will this import add, change, or skip, and does it reconcile with the statement balance?",
    sections: [],
  },
  {
    route: "/transactions",
    title: "Transactions",
    summary: "Which transactions match a payee, amount, date or category, across every account?",
    sections: [],
  },
];
